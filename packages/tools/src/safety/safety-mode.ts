/**
 * @kern/tools/safety/safety-mode — Safety mode configuration and evaluation.
 *
 * Adapted from docker-agents Chapter 11 (Permissions, Safety Modes & Sandbox)
 * for TypeScript/kern.
 *
 * Four concentric layers of autonomy control:
 *   Layer 1 — Permission rules (deny → allow → ask)
 *   Layer 2 — Safety modes (strict/balanced/restricted/autonomous)
 *   Layer 3 — Hook enforcement (integrated with hooks system)
 *   Layer 4 — Real isolation (optional, namespace/sandbox based)
 */

export type SafetyMode = "strict" | "balanced" | "restricted" | "autonomous";

export type CommandClass = "safe" | "destructive" | "unknown";

export interface SafetyDecision {
  decision: "allow" | "deny" | "require_approval";
  reason?: string;
  commandClass?: CommandClass;
  matchedPattern?: string;
}

/**
 * Safety mode matrix: for each mode, how to classify safe/destructive/unknown commands.
 */
const SAFETY_MODE_MATRIX: Record<SafetyMode, Record<CommandClass, "allow" | "deny" | "require_approval">> = {
  strict: {
    safe: "require_approval",
    destructive: "require_approval",
    unknown: "require_approval",
  },
  balanced: {
    safe: "allow",
    destructive: "require_approval",
    unknown: "require_approval",
  },
  restricted: {
    safe: "allow",
    destructive: "deny",
    unknown: "deny",
  },
  autonomous: {
    safe: "allow",
    destructive: "allow",
    unknown: "allow",
  },
};

/**
 * Default safety mode.
 */
export const DEFAULT_SAFETY_MODE: SafetyMode = "balanced";

/**
 * Evaluate a command class against a safety mode to produce a decision.
 */
export function evaluateSafetyMode(
  mode: SafetyMode,
  commandClass: CommandClass,
): "allow" | "deny" | "require_approval" {
  return SAFETY_MODE_MATRIX[mode][commandClass];
}

/**
 * Safety mode configuration for a session or agent.
 */
export interface SafetyPolicyConfig {
  mode: SafetyMode;
  allowRules: string[];
  denyRules: string[];
  askRules: string[];
  blockSensitivePaths: boolean;
  destructiveAlwaysRequiresApproval: boolean;
}

/**
 * Default safety policy configuration (balanced mode).
 */
export const DEFAULT_SAFETY_POLICY_CONFIG: SafetyPolicyConfig = {
  mode: "balanced",
  allowRules: [],
  denyRules: [],
  askRules: [],
  blockSensitivePaths: true,
  destructiveAlwaysRequiresApproval: true,
};

/**
 * Parse safety mode from string, with fallback to default.
 */
export function parseSafetyMode(value: string | undefined): SafetyMode {
  if (!value) return DEFAULT_SAFETY_MODE;
  switch (value.toLowerCase()) {
    case "strict":
      return "strict";
    case "balanced":
      return "balanced";
    case "restricted":
      return "restricted";
    case "autonomous":
      return "autonomous";
    default:
      return DEFAULT_SAFETY_MODE;
  }
}