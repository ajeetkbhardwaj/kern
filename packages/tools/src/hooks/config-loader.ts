/**
 * @kern/tools/hooks/config-loader — YAML hook configuration loader.
 *
 * Loads hook registrations from YAML config files:
 *   - A single config file: .kern/hooks.yaml (workspace) or ~/.kern/hooks.yaml (user)
 *   - A hooks.d/ directory: .kern/hooks.d/*.yaml or ~/.kern/hooks.d/*.yaml
 *
 * Each YAML file defines a list of hook registrations referencing built-in
 * handlers by name. Built-in handlers must be registered via registerBuiltinHandler()
 * before loading configs that reference them.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import type { HookRegistration } from "./events/contracts.js";
import { HookRegistry } from "./registry.js";
import { matchPattern } from "./registry.js";

export type BuiltinHandler = (params: unknown[]) => unknown;

export interface HookConfigEntry {
  event: string;
  handler: string;
  matcher?: string;
  priority?: number;
  canBlock?: boolean;
}

export interface HookConfigFile {
  hooks?: HookConfigEntry[];
}

const BUILTIN_HANDLERS = new Map<string, BuiltinHandler>();

/** Register a built-in handler by name so YAML configs can reference it. */
export function registerBuiltinHandler(name: string, handler: BuiltinHandler): void {
  BUILTIN_HANDLERS.set(name, handler);
}

/** Look up a registered built-in handler by name. */
export function getBuiltinHandler(name: string): BuiltinHandler | undefined {
  return BUILTIN_HANDLERS.get(name);
}

/** Parse a YAML config file into HookRegistration entries. */
function parseHookConfig(raw: string, source: string): HookRegistration[] {
  let doc: HookConfigFile;
  try {
    doc = load(raw) as HookConfigFile;
  } catch (error) {
    throw new Error(`Failed to parse hook config ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = doc.hooks ?? [];
  const registrations: HookRegistration[] = [];
  for (const entry of entries) {
    const handler = getBuiltinHandler(entry.handler);
    if (!handler) {
      throw new Error(`Unknown built-in handler "${entry.handler}" in ${source}`);
    }
    registrations.push({
      event: entry.event,
      handler: handler as unknown as HookRegistration["handler"],
      matcher: entry.matcher,
      priority: entry.priority ?? 0,
      canBlock: entry.canBlock,
    });
  }
  return registrations;
}

/** List of default config file locations, in priority order (first found wins for single-file). */
export function defaultConfigPaths(cwd: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    resolve(cwd, ".kern", "hooks.yaml"),
    join(home, ".kern", "hooks.yaml"),
  ];
}

/** List of default hooks.d/ directory locations. */
export function defaultHooksDirs(cwd: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    resolve(cwd, ".kern", "hooks.d"),
    join(home, ".kern", "hooks.d"),
  ];
}

/** Load hook registrations from a single YAML file. Returns empty array if file doesn't exist. */
export async function loadHookConfigFile(path: string): Promise<HookRegistration[]> {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const raw = await readFile(path, "utf8");
  return parseHookConfig(raw, path);
}

/** Load hook registrations from all .yaml/.yml files in a hooks.d/ directory. */
export async function loadHooksDir(dir: string): Promise<HookRegistration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const yamlFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const registrations: HookRegistration[] = [];
  for (const file of yamlFiles) {
    const fullPath = join(dir, file);
    try {
      const fileRegs = await loadHookConfigFile(fullPath);
      registrations.push(...fileRegs);
    } catch (error) {
      // Log and skip malformed files rather than aborting the whole directory
      console.warn(`Skipping malformed hook config ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return registrations;
}

/** Load all hook configs from default locations and register with a HookRegistry.
 *
 * Load order (later overrides earlier for duplicate event+matcher combos):
 *   1. Workspace .kern/hooks.yaml
 *   2. User ~/.kern/hooks.yaml
 *   3. Workspace .kern/hooks.d/*.yaml (sorted)
 *   4. User ~/.kern/hooks.d/*.yaml (sorted)
 */
export async function loadDefaultHookConfigs(
  registry: HookRegistry,
  cwd: string,
): Promise<{ loaded: number; sources: string[] }> {
  const sources: string[] = [];
  let loaded = 0;

  // Single config files
  for (const path of defaultConfigPaths(cwd)) {
    try {
      const regs = await loadHookConfigFile(path);
      for (const reg of regs) {
        registry.register(reg);
        loaded += 1;
      }
      if (regs.length > 0) sources.push(path);
    } catch {
      // best-effort: skip unreadable single-file configs
    }
  }

  // hooks.d/ directories
  for (const dir of defaultHooksDirs(cwd)) {
    try {
      const regs = await loadHooksDir(dir);
      for (const reg of regs) {
        registry.register(reg);
        loaded += 1;
      }
      if (regs.length > 0) sources.push(dir);
    } catch {
      // best-effort: skip unreadable directories
    }
  }

  return { loaded, sources };
}
