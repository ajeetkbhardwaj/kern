import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  McpServerConfigEntry,
  McpServerOrigin,
  McpTransportType,
  ResolvedMcpServerDef,
} from "./types.js";

const VALID_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultUserMcpPath(home = homedir()): string {
  return join(home, ".kern", "mcp.json");
}

export function defaultTrustFilePath(home = homedir()): string {
  return join(home, ".kern", "mcp-trust.json");
}

export function defaultProjectMcpPath(cwd: string): string {
  return join(resolve(cwd), ".mcp.json");
}

export interface ExpandEnvResult {
  value: string;
  missing: string[];
}

/** Expand ${VAR}, ${VAR:-default}, and $VAR placeholders using process.env + overrides. */
export function expandEnvString(
  raw: string,
  envSource: Record<string, string | undefined> = process.env,
): ExpandEnvResult {
  const missing: string[] = [];
  let value = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_m, name: string, fallback?: string) => {
    const hit = envSource[name];
    if (hit !== undefined && hit !== "") return hit;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return "";
  });
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (_m, name: string) => {
    const hit = envSource[name];
    if (hit !== undefined && hit !== "") return hit;
    missing.push(name);
    return "";
  });
  return { value, missing: [...new Set(missing)] };
}

function inferTransport(entry: McpServerConfigEntry): McpTransportType | null {
  const explicit = entry.transport ?? entry.type;
  if (explicit === "sse") return "sse";
  if (explicit === "http" || explicit === "streamable-http") return "http";
  if (explicit === "stdio") return "stdio";
  if (typeof entry.url === "string" && entry.url.trim()) {
    return /\/sse(?:[/?#]|$)/i.test(entry.url.trim()) ? "sse" : "http";
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    return "stdio";
  }
  return null;
}

function serverFingerprint(cwd: string, name: string, entry: McpServerConfigEntry): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({
      cwd: resolve(cwd),
      name,
      command: entry.command ?? null,
      args: entry.args ?? [],
      cwdOverride: entry.cwd ?? null,
    }))
    .digest("hex");
  return hash.slice(0, 24);
}

interface TrustStore {
  trusted?: Record<string, string>;
}

async function readTrustStore(trustFilePath: string): Promise<TrustStore> {
  try {
    const raw = await readFile(trustFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TrustStore;
    }
  } catch {
    // missing or malformed
  }
  return {};
}

export async function trustProjectServer(
  cwd: string,
  name: string,
  entry: McpServerConfigEntry,
  trustFilePath = defaultTrustFilePath(),
): Promise<void> {
  const store = await readTrustStore(trustFilePath);
  const trusted = { ...(store.trusted ?? {}) };
  const key = `${resolve(cwd)}::${name}`;
  trusted[key] = serverFingerprint(cwd, name, entry);
  await mkdir(dirname(trustFilePath), { recursive: true });
  await writeFile(trustFilePath, JSON.stringify({ trusted }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function resolveEntry(
  name: string,
  entry: McpServerConfigEntry,
  origin: McpServerOrigin,
  cwd: string,
  opts: {
    sourcePath?: string;
    allowProjectStdio?: boolean;
    trustMap?: Record<string, string>;
    envSource?: Record<string, string | undefined>;
  },
): ResolvedMcpServerDef | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const transport = inferTransport(entry);
  if (!transport) return null;

  const envSource = opts.envSource ?? process.env;
  const missing = new Set<string>();
  const timeoutMs =
    typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs >= 1000
      ? Math.min(300_000, Math.round(entry.timeoutMs))
      : DEFAULT_TIMEOUT_MS;

  if (transport === "http" || transport === "sse") {
    const rawUrl = typeof entry.url === "string" ? entry.url.trim() : "";
    const expUrl = expandEnvString(rawUrl, envSource);
    for (const m of expUrl.missing) missing.add(m);
    if (!/^https?:\/\//i.test(expUrl.value)) return null;

    let headers: Record<string, string> | undefined;
    if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
      headers = {};
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v !== "string") continue;
        const expH = expandEnvString(v, envSource);
        for (const m of expH.missing) missing.add(m);
        if (expH.value.length > 0 && expH.value.length <= 4096) {
          headers[k.slice(0, 128)] = expH.value;
        }
      }
      if (Object.keys(headers).length === 0) headers = undefined;
    }

    return {
      name,
      transport,
      origin,
      sourcePath: opts.sourcePath,
      url: expUrl.value,
      headers,
      timeoutMs,
      disabled: entry.disabled === true,
      deferred: entry.deferred === true,
      trusted: true,
      missingEnvVars: [...missing],
      includeTools: entry.includeTools,
      excludeTools: entry.excludeTools,
      rawEntry: entry,
    };
  }

  // Stdio transport
  const rawCommand = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!rawCommand) return null;

  const expandedEnv: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [k, v] of Object.entries(entry.env)) {
      if (typeof v !== "string") continue;
      const exp = expandEnvString(v, envSource);
      for (const m of exp.missing) missing.add(m);
      if (exp.value !== "") {
        expandedEnv[k] = exp.value;
      }
    }
  }
  const mergedEnvSource = { ...envSource, ...expandedEnv };
  const expCmd = expandEnvString(rawCommand, mergedEnvSource);
  for (const m of expCmd.missing) missing.add(m);

  const args = Array.isArray(entry.args)
    ? entry.args.map((a) => {
        const exp = expandEnvString(String(a), mergedEnvSource);
        for (const m of exp.missing) missing.add(m);
        return exp.value;
      })
    : [];

  let trusted = true;
  let trustReason: string | undefined;
  if (origin === "project" && !opts.allowProjectStdio) {
    const fp = serverFingerprint(cwd, name, entry);
    const saved = opts.trustMap?.[`${resolve(cwd)}::${name}`];
    if (saved !== fp) {
      trusted = false;
      trustReason = `Project stdio server "${name}" requires trust approval (run /mcp trust ${name} or move to ~/.kern/mcp.json).`;
    }
  }

  return {
    name,
    transport: "stdio",
    origin,
    sourcePath: opts.sourcePath,
    command: expCmd.value,
    args,
    env: Object.keys(expandedEnv).length > 0 ? expandedEnv : undefined,
    cwd: entry.cwd ? resolve(cwd, entry.cwd) : cwd,
    timeoutMs,
    disabled: entry.disabled === true,
    deferred: entry.deferred === true,
    trusted,
    trustReason,
    missingEnvVars: [...missing],
    includeTools: entry.includeTools,
    excludeTools: entry.excludeTools,
    rawEntry: entry,
  };
}

interface RawMcpFile {
  servers?: Record<string, McpServerConfigEntry>;
  mcpServers?: Record<string, McpServerConfigEntry>;
}

async function readMcpJsonFile(filePath: string): Promise<Record<string, McpServerConfigEntry>> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as RawMcpFile;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return { ...(parsed.servers ?? {}), ...(parsed.mcpServers ?? {}) };
}

export interface LoadMcpConfigsOptions {
  userConfigPath?: string;
  trustFilePath?: string;
  extraConfigPaths?: string[];
  allowProjectStdio?: boolean;
  envSource?: Record<string, string | undefined>;
}

export async function loadMcpConfigs(
  cwd: string,
  opts: LoadMcpConfigsOptions = {},
): Promise<{ defs: ResolvedMcpServerDef[]; warnings: string[] }> {
  const root = resolve(cwd);
  const envSource = opts.envSource ?? process.env;
  const userPath = opts.userConfigPath ?? defaultUserMcpPath();
  const trustPath = opts.trustFilePath ?? defaultTrustFilePath();
  const trustStore = await readTrustStore(trustPath);
  const trustMap = trustStore.trusted ?? {};

  const defs: ResolvedMcpServerDef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const takeEntry = (name: string, entry: McpServerConfigEntry, origin: McpServerOrigin, sourcePath?: string) => {
    if (seen.has(name)) return;
    const resolved = resolveEntry(name, entry, origin, root, {
      sourcePath,
      allowProjectStdio: opts.allowProjectStdio,
      trustMap,
      envSource,
    });
    if (!resolved) {
      warnings.push(`Ignored invalid MCP config entry "${name}"${sourcePath ? ` (${sourcePath})` : ""}`);
      return;
    }
    seen.add(name);
    if (!resolved.trusted && resolved.trustReason) {
      warnings.push(resolved.trustReason);
    }
    if (resolved.missingEnvVars.length > 0) {
      warnings.push(`MCP server "${name}" references unset env var(s): ${resolved.missingEnvVars.join(", ")}`);
    }
    defs.push(resolved);
  };

  // 1. Env overrides
  const envCommandRaw = envSource["KERN_MCP_COMMAND"]?.trim();
  if (envCommandRaw) {
    const expCmd = expandEnvString(envCommandRaw, envSource);
    seen.add("env");
    if (expCmd.missing.length > 0) {
      warnings.push(`MCP server "env" references unset env var(s): ${expCmd.missing.join(", ")}`);
    }
    defs.push({
      name: "env",
      transport: "stdio",
      origin: "env",
      shellCommand: expCmd.value,
      cwd: root,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      disabled: false,
      deferred: false,
      trusted: true,
      missingEnvVars: expCmd.missing,
      rawEntry: { command: envCommandRaw },
    });
  }
  const envUrl = envSource["KERN_MCP_URL"]?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl)) {
    takeEntry("env-http", { url: envUrl }, "env");
  }

  // 2. Explicit extra config paths
  for (const p of opts.extraConfigPaths ?? []) {
    const abs = resolve(root, p);
    try {
      const table = await readMcpJsonFile(abs);
      for (const [name, entry] of Object.entries(table)) {
        if (entry && typeof entry === "object") takeEntry(name, entry, "user", abs);
      }
    } catch (error) {
      warnings.push(`Failed reading MCP config ${abs}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. User config (~/.kern/mcp.json)
  try {
    const table = await readMcpJsonFile(userPath);
    for (const [name, entry] of Object.entries(table)) {
      if (entry && typeof entry === "object") takeEntry(name, entry, "user", userPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(`Invalid user MCP config ${userPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 4. Project configs (.mcp.json, mcp.json, .vscode/mcp.json)
  for (const rel of [".mcp.json", "mcp.json", ".vscode/mcp.json"]) {
    const abs = join(root, rel);
    try {
      const table = await readMcpJsonFile(abs);
      for (const [name, entry] of Object.entries(table)) {
        if (entry && typeof entry === "object") takeEntry(name, entry, "project", abs);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warnings.push(`Invalid project MCP config ${abs}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { defs, warnings };
}

export async function saveMcpServerConfig(
  scope: "user" | "project",
  cwd: string,
  name: string,
  entry: McpServerConfigEntry,
  opts: { userConfigPath?: string } = {},
): Promise<string> {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid server name "${name}": use [A-Za-z0-9_.-] (1-64 chars)`);
  }
  const filePath = scope === "user" ? (opts.userConfigPath ?? defaultUserMcpPath()) : defaultProjectMcpPath(cwd);
  let doc: RawMcpFile = {};
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as RawMcpFile;
    }
  } catch {
    doc = {};
  }
  const nextDoc: RawMcpFile = {
    ...doc,
    mcpServers: {
      ...(doc.mcpServers ?? {}),
      [name]: entry,
    },
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(nextDoc, null, 2) + "\n", {
    encoding: "utf8",
    mode: scope === "user" ? 0o600 : 0o644,
  });
  return filePath;
}

export async function removeMcpServerConfig(
  scope: "user" | "project",
  cwd: string,
  name: string,
  opts: { userConfigPath?: string } = {},
): Promise<boolean> {
  const candidates =
    scope === "user"
      ? [opts.userConfigPath ?? defaultUserMcpPath()]
      : [
          join(resolve(cwd), ".mcp.json"),
          join(resolve(cwd), "mcp.json"),
          join(resolve(cwd), ".vscode", "mcp.json"),
        ];

  let removed = false;
  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      const doc = JSON.parse(raw) as RawMcpFile;
      if (!doc || typeof doc !== "object") continue;
      let changed = false;
      if (doc.mcpServers && name in doc.mcpServers) {
        delete doc.mcpServers[name];
        changed = true;
      }
      if (doc.servers && name in doc.servers) {
        delete doc.servers[name];
        changed = true;
      }
      if (changed) {
        await writeFile(filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
        removed = true;
      }
    } catch {
      // ignore missing/invalid files
    }
  }
  return removed;
}

export async function setMcpServerDisabledInFile(
  filePath: string,
  name: string,
  disabled: boolean,
): Promise<boolean> {
  try {
    const raw = await readFile(filePath, "utf8");
    const doc = JSON.parse(raw) as RawMcpFile;
    if (!doc || typeof doc !== "object") return false;
    const entry = doc.mcpServers?.[name] ?? doc.servers?.[name];
    if (!entry) return false;
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    await writeFile(filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
