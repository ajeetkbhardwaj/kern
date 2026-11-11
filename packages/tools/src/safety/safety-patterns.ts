/**
 * @kern/tools/safety/safety-patterns — Destructive pattern detection.
 *
 * Adapted from docker-agents Chapter 11 for TypeScript/kern.
 * Classifies shell commands and tool calls as safe/destructive/unknown.
 */

export type CommandClass = "safe" | "destructive" | "unknown";

/** Destructive command patterns (case-insensitive). */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b.*--force\b|--force\b.*--recursive\b)\b/i,
  /\brm\s+.*--no-preserve-root\b/i,
  /\bfind\b.*-delete\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b.*-[a-z]*f[a-z]*\b/,
  /\bgit\s+push\b.*--force\b/,
  /\bdd\b.*\bof=\/dev\//,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bchmod\s+-R\b.*\s\/(\s|$)/,
  /\b: *\(\) *\{[^}]*\} *;/,
  /\bcurl\b.*\|\s*(sh|bash)\b/,
  /\bwget\b.*\|\s*(sh|bash)\b/,
  /\bpython\d?\b.*shutil\.rmtree\b/,
];

/** Safe command patterns (case-insensitive). */
export const SAFE_PATTERNS: RegExp[] = [
  /\b(ls|cat|pwd|echo|whoami|date|which|file|stat|du|df|head|tail|wc|grep|find|locate)\b/,
  /\b(git\s+(status|diff|log|branch|show|remote|config))\b/,
  /\b(npm\s+(ls|list|view|search|outdated))\b/,
  /\b(pip\s+(list|show|search))\b/,
];

/**
 * Classify a command string as safe, destructive, or unknown.
 */
export function classifyCommand(command: string): CommandClass {
  const trimmed = command.trim();

  // Check destructive patterns first
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "destructive";
    }
  }

  // Check safe patterns
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "safe";
    }
  }

  return "unknown";
}

/**
 * Check if a command matches any destructive pattern and return the matched pattern.
 */
export function matchDestructivePattern(command: string): { matched: boolean; pattern?: RegExp } {
  const trimmed = command.trim();
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { matched: true, pattern };
    }
  }
  return { matched: false };
}