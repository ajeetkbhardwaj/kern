import { promises as fs, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, relative, join } from "node:path";
import { loadAgentIgnore, isPathIgnored } from "./agentignore.js";

const AGENT_IGNORE_CACHE = new Map<string, { config: Awaited<ReturnType<typeof loadAgentIgnore>> | null; timestamp: number }>();

async function getAgentIgnore(root: string) {
  const now = Date.now();
  const cached = AGENT_IGNORE_CACHE.get(root);
  if (cached && now - cached.timestamp < 5000) return cached.config;
  try {
    const config = await loadAgentIgnore(root);
    AGENT_IGNORE_CACHE.set(root, { config, timestamp: now });
    return config;
  } catch {
    return null;
  }
}

export async function safeResolve(root: string, p: string): Promise<string> {
  const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
  const realRoot = await fs.realpath(root).catch(() => resolve(root));
  let realAbs: string;
  try {
    realAbs = await fs.realpath(abs);
  } catch {
    const parent = resolve(abs, "..");
    const realParent = await fs.realpath(parent).catch(() => parent);
    const base = abs.slice(parent.length);
    realAbs = normalize(realParent + base);
  }
  const rel = relative(realRoot, realAbs);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..\\`) || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  // Agentignore check
  const ignoreConfig = await getAgentIgnore(root);
  if (ignoreConfig && isPathIgnored(ignoreConfig, realAbs)) {
    throw new Error(`Path is ignored by .agentignore: ${p}`);
  }
  return realAbs;
}

export function safeResolveSync(root: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
  let rRoot = resolve(root);
  let rAbs: string;
  try {
    rRoot = realpathSync(root) as string;
  } catch {
    rRoot = resolve(root);
  }
  try {
    rAbs = realpathSync(abs) as string;
  } catch {
    const parent = resolve(abs, "..");
    let realParent = parent;
    try {
      realParent = realpathSync(parent) as string;
    } catch {
      realParent = parent;
    }
    rAbs = normalize(realParent + abs.slice(parent.length));
  }
  const rel = relative(rRoot, rAbs);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..\\`) || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  // Agentignore check (best-effort using cached config)
  const cached = AGENT_IGNORE_CACHE.get(root);
  const ignoreConfig = cached ? cached.config : null;
  if (ignoreConfig && isPathIgnored(ignoreConfig, rAbs)) {
    throw new Error(`Path is ignored by .agentignore: ${p}`);
  }
  return rAbs;
}
