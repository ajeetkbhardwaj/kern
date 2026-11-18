import type { PolicyDecision, PolicyInput, ToolPolicyEngine } from "@kern/protocol";
import { isSensitivePath } from "@kern/protocol";
import type { PolicyConfig } from "./policy-config.js";
import { DEFAULT_POLICY_CONFIG } from "./policy-config.js";
import { PermissionChecker, DEFAULT_PERMISSION_RULES } from "./permissions/permissions.js";
import {
  evaluateSafetyMode,
  DEFAULT_SAFETY_MODE,
  type SafetyPolicyConfig,
  DEFAULT_SAFETY_POLICY_CONFIG,
} from "./safety/safety-mode.js";
import { classifyCommand } from "./safety/safety-patterns.js";
import { matchPattern } from "./hooks/registry.js";

const SENSITIVE_CMD_PATTERNS = [
  /\.ssh\//,
  /\.aws\//,
  /\.kern\/auth\.json/,
  /\.git-credentials/,
  /\.config\/gh\//,
  /id_rsa/,
  /\.env\b/,
];

export class AllowAllPolicy implements ToolPolicyEngine {
  async evaluate(_input: PolicyInput): Promise<PolicyDecision> {
    return { decision: "allow" };
  }
}
export class DefaultPolicy implements ToolPolicyEngine {
  private readonly sessionAllowed = new Set<string>();
  private readonly sessionAllowedPatterns = new Set<string>();
  private permissionChecker: PermissionChecker;
  private safetyConfig: SafetyPolicyConfig;

  constructor(
    private config: PolicyConfig = DEFAULT_POLICY_CONFIG,
    safetyConfig: SafetyPolicyConfig = DEFAULT_SAFETY_POLICY_CONFIG,
  ) {
    this.safetyConfig = {
      ...safetyConfig,
      denyRules: safetyConfig.denyRules.length > 0 ? [...safetyConfig.denyRules] : [...DEFAULT_PERMISSION_RULES.denyRules],
      allowRules: safetyConfig.allowRules.length > 0 ? [...safetyConfig.allowRules] : [...DEFAULT_PERMISSION_RULES.allowRules],
      askRules: safetyConfig.askRules.length > 0 ? [...safetyConfig.askRules] : [...DEFAULT_PERMISSION_RULES.askRules],
    };
    this.permissionChecker = new PermissionChecker({
      denyRules: this.safetyConfig.denyRules,
      allowRules: this.safetyConfig.allowRules,
      askRules: this.safetyConfig.askRules,
    });
  }

  /** Don't ask again for this tool for the rest of the session. */
  allowForSession(toolName: string): void {
    this.sessionAllowed.add(toolName);
  }

  setApprovalMode(mode: PolicyConfig["approvalMode"]): void {
    this.config = { ...this.config, approvalMode: mode };
  }

  approvalMode(): PolicyConfig["approvalMode"] {
    return this.config.approvalMode;
  }

  sessionAllowlist(): string[] {
    return [...this.sessionAllowed];
  }

  /** Don't ask again for commands matching this glob pattern for the rest of the session. */
  allowPattern(pattern: string): void {
    this.sessionAllowedPatterns.add(pattern);
  }

  sessionAllowedPatternsList(): string[] {
    return [...this.sessionAllowedPatterns];
  }

  /** Set the safety mode for this policy engine. */
  setSafetyMode(mode: typeof DEFAULT_SAFETY_MODE): boolean {
    this.safetyConfig = { ...this.safetyConfig, mode };
    return true;
  }

  /** Get the current safety mode. */
  safetyMode(): typeof DEFAULT_SAFETY_MODE {
    return this.safetyConfig.mode;
  }

  /** Update permission rules without clobbering sibling rule lists. */
  updatePermissionRules(rules: {
    denyRules?: string[];
    allowRules?: string[];
    askRules?: string[];
  }): void {
    this.safetyConfig = {
      ...this.safetyConfig,
      ...(rules.denyRules !== undefined ? { denyRules: [...rules.denyRules] } : {}),
      ...(rules.allowRules !== undefined ? { allowRules: [...rules.allowRules] } : {}),
      ...(rules.askRules !== undefined ? { askRules: [...rules.askRules] } : {}),
    };
    this.permissionChecker = new PermissionChecker({
      denyRules: this.safetyConfig.denyRules,
      allowRules: this.safetyConfig.allowRules,
      askRules: this.safetyConfig.askRules,
    });
  }

  /** Merge additional permission rules onto the active defaults/lists. */
  extendPermissionRules(rules: {
    denyRules?: string[];
    allowRules?: string[];
    askRules?: string[];
  }): void {
    const mergeUnique = (base: string[], extra?: string[]) =>
      extra && extra.length > 0 ? [...new Set([...base, ...extra])] : base;
    this.updatePermissionRules({
      denyRules: mergeUnique(this.safetyConfig.denyRules, rules.denyRules),
      allowRules: mergeUnique(this.safetyConfig.allowRules, rules.allowRules),
      askRules: mergeUnique(this.safetyConfig.askRules, rules.askRules),
    });
  }

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const name = input.toolName;

    // 1. Denylist check
    if (this.config.denylistTools.includes(name)) {
      return { decision: "deny", reason: `Tool ${name} is in denylist` };
    }

    // 2. Allowlist check
    if (this.config.allowlistTools.length > 0 && !this.config.allowlistTools.includes(name)) {
      return { decision: "deny", reason: `Tool ${name} not in allowlist` };
    }

    const args = input.arguments as Record<string, unknown> | undefined;

    // 3. Sensitive path check
    if (this.config.blockSensitivePaths && args && typeof args.path === "string") {
      if (isSensitivePath(args.path)) {
        return { decision: "deny", reason: "Access to sensitive path is blocked" };
      }
    }

    // 3b. Session-allowed pattern check — bypasses permission rules and safety mode
    if (args && typeof args.command === "string") {
      const cmd = args.command;
      for (const pattern of this.sessionAllowedPatterns) {
        if (matchPattern(pattern, cmd)) {
          return { decision: "allow" };
        }
      }
    }

    // 4. Permission rules (deny → allow → ask → fallthrough to safety mode)
    let commandPermission: "deny" | "allow" | "ask" | "fallthrough" = "fallthrough";
    if (args && typeof args.command === "string") {
      const cmd = args.command;
      const commandClass = classifyCommand(cmd);
      commandPermission = this.permissionChecker.check(cmd, commandClass);

      if (commandPermission === "deny") {
        return { decision: "deny", reason: `Command blocked by permission rule: ${cmd}` };
      }
      if (commandPermission === "ask") {
        return {
          decision: "require_approval",
          prompt: `Permission required for command. Approve? ${cmd}`,
        };
      }
    }

    // 5. Sensitive command path check (credentials)
    if (name === "bash" && args && typeof args.command === "string") {
      const cmd = args.command;
      if (SENSITIVE_CMD_PATTERNS.some((re) => re.test(cmd))) {
        return { decision: "deny", reason: "Bash command touches sensitive credentials path" };
      }
    }

    // Honor explicit allow rules (for non-destructive commands when not in strict mode)
    if (
      name === "bash" &&
      commandPermission === "allow" &&
      this.safetyConfig.mode !== "strict" &&
      args &&
      typeof args.command === "string" &&
      classifyCommand(args.command) !== "destructive"
    ) {
      return { decision: "allow" };
    }

    // 6. Safety mode evaluation
    const auto =
      this.config.approvalMode === "auto-allowlist" || this.sessionAllowed.has(name);

    if (name === "bash" && args && typeof args.command === "string") {
      const cmd = args.command;
      const commandClass = classifyCommand(cmd);

      // Destructive commands always require approval if configured
      if (commandClass === "destructive" && this.config.destructiveAlwaysRequiresApproval && !auto) {
        return { decision: "require_approval", prompt: `Destructive command detected. Approve? ${cmd}` };
      }

      // Apply safety mode matrix
      const safetyDecision = evaluateSafetyMode(this.safetyConfig.mode, commandClass);
      if (safetyDecision === "deny") {
        return { decision: "deny", reason: `Command ${commandClass} denied by safety mode "${this.safetyConfig.mode}"` };
      }
      if (safetyDecision === "require_approval" && !auto) {
        return { decision: "require_approval", prompt: `Approve ${commandClass} command? ${cmd}` };
      }
      if (safetyDecision === "allow") {
        return { decision: "allow" };
      }
    }

    // 7. Destructive annotation always requires approval in ask mode unless session-allowed
    if (input.annotations?.destructiveHint && this.config.approvalMode === "ask" && !auto) {
      return { decision: "require_approval", prompt: `Approve destructive ${name} operation?` };
    }

    // 8. Write/edit tools in ask mode
    if ((name === "write" || name === "edit") && this.config.approvalMode === "ask" && !auto) {
      return { decision: "require_approval", prompt: `Approve ${name} operation?` };
    }

    // 9. Any non-read tool in ask mode
    const effect = input.sideEffect ?? (input.annotations?.readOnlyHint ? "read" : name === "read" ? "read" : "execute");
    if (effect !== "read" && this.config.approvalMode === "ask" && !auto) {
      return { decision: "require_approval", prompt: `Approve ${name} operation?` };
    }

    return { decision: "allow" };
  }
}
