/**
 * @kern/tools/agentignore — .agentignore file support.
 *
 * Loads .agentignore files from the workspace root (and parent directories)
 * and matches paths against gitignore-style patterns. Ignored paths are
 * blocked by tool operations to prevent accidental access to build output,
 * node_modules, secrets, etc.
 */

import { readFile, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AgentIgnoreConfig {
  root: string;
  patterns: string[];
  negativePatterns: string[];
}

/** Default ignore patterns that always apply (in addition to .agentignore file). */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  "*.log",
  "*.local",
];

/** Parse a .agentignore file content into patterns and negative patterns. */
function parseAgentIgnore(content: string): { patterns: string[]; negativePatterns: string[] } {
  const patterns: string[] = [];
  const negativePatterns: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      negativePatterns.push(line.slice(1));
    } else {
      patterns.push(line);
    }
  }
  return { patterns, negativePatterns };
}

/** Convert a gitignore-style pattern to a regex. */
function patternToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  // Trailing slash means match directories only
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  // Leading slash anchors to root
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  // Contains a slash (not trailing) => match from root
  const hasMiddleSlash = pattern.includes("/");

  if (anchored || hasMiddleSlash) {
    // Match from root
    regex += "^";
  } else {
    // Match at any depth
    regex += "(?:^|/)";
  }

  for (; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** pattern
        i++;
        if (pattern[i + 1] === "/") {
          // **/ matches zero or more directories
          regex += "(?:.*/)?";
          i++;
        } else if (i === pattern.length - 1) {
          // trailing ** matches everything
          regex += ".*";
        } else {
          regex += ".+";
        }
      } else {
        // * matches anything within a path segment
        regex += "[^/]*";
      }
    } else if (c === "?") {
      regex += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
  }

  if (dirOnly) {
    regex += "(?:/|$)";
  } else {
    regex += "$";
  }

  return new RegExp(regex);
}

/** Load .agentignore from root, walking up parent directories until found. */
export async function loadAgentIgnore(root: string): Promise<AgentIgnoreConfig> {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  const negativePatterns: string[] = [];

  let dir = resolve(root);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const stopAt = home ? resolve(home) : "/";

  while (true) {
    const ignoreFile = join(dir, ".agentignore");
    try {
      await stat(ignoreFile);
      const content = await readFile(ignoreFile, "utf8");
      const parsed = parseAgentIgnore(content);
      patterns.push(...parsed.patterns);
      negativePatterns.push(...parsed.negativePatterns);
      break; // Use the nearest .agentignore only
    } catch {
      // No .agentignore here, continue up
    }
    if (dir === stopAt || dir === "/") break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return { root, patterns, negativePatterns };
}

/** Synchronous variant of loadAgentIgnore for sync path guards. */
export function loadAgentIgnoreSync(root: string): AgentIgnoreConfig {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  const negativePatterns: string[] = [];

  let dir = resolve(root);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const stopAt = home ? resolve(home) : "/";

  while (true) {
    const ignoreFile = join(dir, ".agentignore");
    try {
      statSync(ignoreFile);
      const content = readFileSync(ignoreFile, "utf8");
      const parsed = parseAgentIgnore(content);
      patterns.push(...parsed.patterns);
      negativePatterns.push(...parsed.negativePatterns);
      break;
    } catch {
      // No .agentignore here, continue up
    }
    if (dir === stopAt || dir === "/") break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return { root, patterns, negativePatterns };
}

/** Check whether a path is ignored by .agentignore rules. */
export function isPathIgnored(config: AgentIgnoreConfig, path: string): boolean {
  const rel = path.startsWith(config.root)
    ? path.slice(config.root.length).replace(/^[/\\]+/, "")
    : path.replace(/^[/\\]+/, "");

  if (!rel) return false;

  let matched = false;

  // Check positive patterns
  for (const pattern of config.patterns) {
    const re = patternToRegex(pattern);
    if (re.test(rel)) {
      matched = true;
      break;
    }
  }

  if (!matched) return false;

  // Check negative patterns (re-inclusion)
  for (const pattern of config.negativePatterns) {
    const re = patternToRegex(pattern);
    if (re.test(rel)) {
      return false;
    }
  }

  return true;
}
