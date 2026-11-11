/**
 * @kern/tools/permissions — Permission rule engine.
 *
 * Adapted from docker-agents Chapter 11 for TypeScript/kern.
 * Declarative permission lists evaluated Deny → Allow → Ask,
 * otherwise falling through to safety mode.
 */

import type { CommandClass } from "../safety/safety-patterns.js";

export type PermissionResult = "deny" | "allow" | "ask" | "fallthrough";

/**
 * Permission checker that evaluates declarative rules.
 */
export class PermissionChecker {
  private denyRules: RegExp[];
  private allowRules: RegExp[];
  private askRules: RegExp[];

  constructor({
    denyRules = [],
    allowRules = [],
    askRules = [],
  }: { denyRules?: string[]; allowRules?: string[]; askRules?: string[] } = {}) {
    this.denyRules = denyRules.map((r) => new RegExp(r, "i"));
    this.allowRules = allowRules.map((r) => new RegExp(r, "i"));
    this.askRules = askRules.map((r) => new RegExp(r, "i"));
  }

  /**
   * Check a command string against permission rules.
   * Returns the first matching result, or "fallthrough" if no rules match.
   */
  check(command: string, commandClass?: CommandClass): PermissionResult {
    const trimmed = command.trim();

    // Layer 1: Deny rules checked first
    for (const rule of this.denyRules) {
      if (rule.test(trimmed)) {
        return "deny";
      }
    }

    // Layer 2: Allow rules
    for (const rule of this.allowRules) {
      if (rule.test(trimmed)) {
        return "allow";
      }
    }

    // Layer 3: Ask rules
    for (const rule of this.askRules) {
      if (rule.test(trimmed)) {
        return "ask";
      }
    }

    return "fallthrough";
  }

  /**
   * Add a deny rule.
   */
  addDenyRule(pattern: string): void {
    this.denyRules.push(new RegExp(pattern, "i"));
  }

  /**
   * Add an allow rule.
   */
  addAllowRule(pattern: string): void {
    this.allowRules.push(new RegExp(pattern, "i"));
  }

  /**
   * Add an ask rule.
   */
  addAskRule(pattern: string): void {
    this.askRules.push(new RegExp(pattern, "i"));
  }

  /**
   * Clear all rules for a category.
   */
  clear(category: "deny" | "allow" | "ask"): void {
    switch (category) {
      case "deny":
        this.denyRules = [];
        break;
      case "allow":
        this.allowRules = [];
        break;
      case "ask":
        this.askRules = [];
        break;
    }
  }
}

/**
 * Create a default permission checker with common patterns.
 */
export function createDefaultPermissionChecker(): PermissionChecker {
  return new PermissionChecker({
    denyRules: [
      // Dangerous filesystem operations
      "rm -rf",
      "rm .*--no-preserve-root",
      "shred",
      "mkfs",
      "dd.*of=/dev/",
      // Destructive git operations
      "git reset --hard",
      "git clean.*-f",
      "git push.*--force",
      // Shell injection / backdoor patterns
      "curl.*\\|.*(sh|bash)",
      "wget.*\\|.*(sh|bash)",
      "python.*shutil.rmtree",
      // Fork bombs
      ":()*{:|:&};:",
    ],
    allowRules: [
      // Read-only operations
      "ls",
      "cat",
      "pwd",
      "whoami",
      "date",
      "which",
      "file",
      "stat",
      "du",
      "df",
      "head",
      "tail",
      "wc",
      "grep",
      "find",
      // Read-only git
      "git status",
      "git diff",
      "git log",
      "git branch",
      "git show",
      "git remote",
      "git config",
      // Read-only package queries
      "npm ls",
      "npm list",
      "npm view",
      "npm search",
      "npm outdated",
      "pip list",
      "pip show",
      "pip search",
    ],
    askRules: [
      // Potentially destructive but common operations
      "kubectl",
      "sudo",
      "docker",
      "chmod -R",
      "chown -R",
    ],
  });
}