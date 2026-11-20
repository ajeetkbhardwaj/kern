import { createAgentSession, resolveSkillInvocation } from "@kern/coding-agent";
import { CONNECTOR_PRESETS, ConnectManager, findConnectorPreset, type McpServerConfigEntry, type McpTransportType } from "@kern/connects";
import {
  SUBAGENT_FORMAT_GUIDE,
  SUBAGENT_PRESETS,
  SubagentManager,
  findSubagentPreset,
  parseSubagentFile,
  type SubagentConfigEntry,
  type SubagentFileFormat,
  type SubagentIsolation,
  type SubagentMode,
} from "@kern/subagents";
import { createLogger, type AskUserRequest } from "@kern/protocol";
import {
  clearAuthKey,
  createAdapterFor,
  createModelRuntime,
  discoverModels,
  loadAuth,
  loadModelsFile,
  maskKey,
  PROVIDER_PRESETS,
  resolveFallbackAdapters,
  saveAuthKey,
  saveProviderToUserFile,
  testProvider,
  type ProviderConfig,
} from "@kern/model";
import { createInterface } from "node:readline";

export const KERN_VERSION = "1.0.0";

const READ_ONLY_TOOLS = ["read", "grep", "find", "git-status", "git-diff", "git-log", "bash-status"];

export interface CliFlags {
  prompt: string;
  readOnly: boolean;
  maxCost?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxTurns?: number;
  maxWallTimeMs?: number;
  maxToolCallsPerTurn?: number;
  maxTotalToolCalls?: number;
  cwd: string;
  noResources: boolean;
  noCompaction: boolean;
  noMcp: boolean;
  noAgents: boolean;
  resume: boolean;
  resumeSession?: string;
  listModels: boolean;
  interactive: boolean;
  print: boolean;
  json: boolean;
  hadPrompt?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  safetyMode?: "strict" | "balanced" | "restricted" | "autonomous";
  rpc: boolean;
  validateConfig: boolean;
  config?: string;
}

function parsePositiveInt(argv: string[], index: number, flag: string): { value: number; nextIndex: number } {
  const next = argv[index + 1];
  const n = next !== undefined ? Number(next) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
  return { value: n, nextIndex: index + 1 };
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    prompt: "",
    readOnly: false,
    cwd: process.cwd(),
    noResources: false,
    noCompaction: false,
    noMcp: false,
    noAgents: false,
    resume: false,
    listModels: false,
    interactive: false,
    print: false,
    json: false,
    rpc: false,
    validateConfig: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--read-only") flags.readOnly = true;
    else if (arg === "--no-resources") flags.noResources = true;
    else if (arg === "--no-compaction") flags.noCompaction = true;
    else if (arg === "--no-mcp") flags.noMcp = true;
    else if (arg === "--no-agents") flags.noAgents = true;
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--session") {
      const next = argv[++i];
      if (!next) throw new Error("--session requires a session id or path");
      flags.resumeSession = next;
      flags.resume = true;
    } else if (arg === "--interactive" || arg === "-i") flags.interactive = true;
    else if (arg === "--print") flags.print = true;
    else if (arg === "--json") {
      flags.json = true;
      flags.print = true;
    } else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--provider") {
      const next = argv[++i];
      if (!next) throw new Error("--provider requires a name");
      flags.provider = next;
    } else if (arg === "--model") {
      const next = argv[++i];
      if (!next) throw new Error("--model requires an id (optionally provider/id)");
      flags.model = next;
    } else if (arg === "--base-url") {
      const next = argv[++i];
      if (!next) throw new Error("--base-url requires a URL");
      flags.baseUrl = next;
    } else if (arg === "--api-key") {
      const next = argv[++i];
      if (!next) throw new Error("--api-key requires a value");
      flags.apiKey = next;
    } else if (arg === "--max-cost") {
      const next = argv[++i];
      const n = next !== undefined ? Number(next) : NaN;
      if (!Number.isFinite(n) || n < 0) throw new Error("--max-cost requires a non-negative number");
      flags.maxCost = n;
    } else if (arg === "--max-input-tokens") {
      const res = parsePositiveInt(argv, i, "--max-input-tokens");
      flags.maxInputTokens = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-output-tokens") {
      const res = parsePositiveInt(argv, i, "--max-output-tokens");
      flags.maxOutputTokens = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-total-tokens") {
      const res = parsePositiveInt(argv, i, "--max-total-tokens");
      flags.maxTotalTokens = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-turns") {
      const res = parsePositiveInt(argv, i, "--max-turns");
      flags.maxTurns = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-wall-time-ms") {
      const res = parsePositiveInt(argv, i, "--max-wall-time-ms");
      flags.maxWallTimeMs = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-tool-calls-per-turn") {
      const res = parsePositiveInt(argv, i, "--max-tool-calls-per-turn");
      flags.maxToolCallsPerTurn = res.value;
      i = res.nextIndex;
    } else if (arg === "--max-total-tool-calls") {
      const res = parsePositiveInt(argv, i, "--max-total-tool-calls");
      flags.maxTotalToolCalls = res.value;
      i = res.nextIndex;
    } else if (arg === "--safety") {
      const next = argv[++i];
      if (!next) throw new Error("--safety requires a mode: strict, balanced, restricted, autonomous");
      if (!["strict", "balanced", "restricted", "autonomous"].includes(next)) {
        throw new Error("--safety mode must be: strict, balanced, restricted, or autonomous");
      }
      flags.safetyMode = next as CliFlags["safetyMode"];
    } else if (arg === "--rpc") {
      flags.rpc = true;
    } else if (arg === "--validate-config") {
      flags.validateConfig = true;
    } else if (arg === "--config") {
      const next = argv[++i];
      if (!next) throw new Error("--config requires a file path");
      flags.config = next;
    } else if (arg === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error("--cwd requires a directory");
      flags.cwd = next;
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`kern v${KERN_VERSION}\n`);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  flags.prompt = positional.join(" ");
  flags.hadPrompt = positional.length > 0;
  return flags;
}

function buildBudgets(flags: CliFlags) {
  return {
    ...(flags.maxCost !== undefined ? { maxCost: flags.maxCost } : {}),
    ...(flags.maxInputTokens !== undefined ? { maxInputTokens: flags.maxInputTokens } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    ...(flags.maxTotalTokens !== undefined ? { maxTotalTokens: flags.maxTotalTokens } : {}),
    ...(flags.maxTurns !== undefined ? { maxTurns: flags.maxTurns } : {}),
    ...(flags.maxWallTimeMs !== undefined ? { maxWallTimeMs: flags.maxWallTimeMs } : {}),
    ...(flags.maxToolCallsPerTurn !== undefined ? { maxToolCallsPerTurn: flags.maxToolCallsPerTurn } : {}),
    ...(flags.maxTotalToolCalls !== undefined ? { maxTotalToolCalls: flags.maxTotalToolCalls } : {}),
  };
}

function printHelp(): void {
  process.stdout.write(
    `kern v${KERN_VERSION} — minimal coding agent kernel\n\nUsage:\n  kern [flags] [prompt]\n  kern login [provider] [--base-url URL] [--model ID] [--api-key KEY] [--default] [--list]\n  kern logout [provider] [--all]\n  kern mcp <list|presets|add|remove|test|trust> [options]\n  kern agents <list|presets|add|remove|enable|disable|trust> [options]\n\nFlags:\n  --read-only                   Only allow read-only tools (read, grep, find, git-status/diff/log)\n  --max-cost N                  Cap session cost in USD\n  --max-input-tokens N          Cap input tokens for the session\n  --max-output-tokens N         Cap output tokens for the session\n  --max-total-tokens N          Cap total tokens for the session\n  --max-turns N                 Cap model turns per user run\n  --max-wall-time-ms N          Cap wall-clock duration (ms) per user run\n  --max-tool-calls-per-turn N   Cap tool calls in a single turn\n  --max-total-tool-calls N      Cap total tool calls in a user run\n  --cwd DIR                     Workspace root (default: cwd)\n  --no-resources                Skip AGENTS.md / skill discovery\n  --no-compaction               Disable automatic compaction\n  --no-mcp                      Disable automatic MCP connector discovery\n  --no-agents                   Disable specialist subagent & A2A discovery\n  --resume                      Resume the most recent session\n  --session ID|PATH             Resume a specific session by ID or JSONL file path\n  --interactive, -i             Start interactive TUI\n  --print                       Force single-prompt print mode (no TUI)\n  --json                        Emit NDJSON agent events in non-interactive mode (implies --print)\n  --list-models                 List available models (configured + live) and exit\n  --provider NAME               Provider from models.json (or KERN_PROVIDER)\n  --model ID                    Model id, optionally provider/id (or KERN_MODEL)\n  --base-url URL                Override endpoint base URL (or KERN_BASE_URL)\n  --api-key KEY                 Override API key (or KERN_API_KEY)\n  --safety MODE                 Safety mode: strict, balanced, restricted, autonomous (default: balanced)\n  --rpc                         JSON-RPC mode (stdin/stdout)\n  --validate-config             Validate config files and exit\n  --config PATH                 Config file path (default: ~/.kern/models.json)\n  --version, -v                 Show version and exit\n  --help, -h                    This message\n\nAuth Commands:\n  kern login [provider]         Log in to an LLM provider (saves key to ~/.kern/auth.json)\n  kern login --list             Show saved & configured provider credentials\n  kern logout [provider|--all]  Remove saved provider credentials from ~/.kern/auth.json\n\nMCP Commands:\n  kern mcp list                 Discover & test configured MCP servers (~/.kern/mcp.json, .mcp.json)\n  kern mcp presets              List built-in connector presets\n  kern mcp add <name> <target>  Add remote HTTP/SSE URL or stdio command [args...]\n  kern mcp remove <name>        Remove server from user/project config\n  kern mcp test [name]          Connect & verify tools/resources/prompts\n  kern mcp trust <name>         Approve an untrusted project stdio server\n\nSubagent & A2A Commands:\n  kern agents list              Discover configured specialists & remote A2A agents\n  kern agents presets           List opt-in specialist templates (none active by default)\n  kern agents add <name>        Add a local specialist or remote A2A agent (--preset, --a2a, --mode...)\n  kern agents remove <name>     Remove specialist from user/project config\n  kern agents enable|disable    Enable or disable a specialist without deleting config\n  kern agents trust <name>      Approve an untrusted project specialist (.kern/agents)\n\nBehavior:\n  On a TTY, Kern starts the TUI by default. Use --print for non-interactive output.\n  If a prompt is provided with the TUI, it is sent as the first message.\n`,
  );
}

/** TTY approval prompt. Non-TTY = deny (fail closed). */
function askApproval(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\nApproval required: ${prompt}\nAllow? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/** TTY fallback for ask-user tool when running without TUI overlay. Non-TTY returns null. */
function askUserCli(req: AskUserRequest): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let prompt = `\n${req.question}\n`;
    if (req.options && req.options.length > 0) {
      req.options.forEach((opt, i) => {
        prompt += `  ${i + 1}. ${opt}\n`;
      });
      prompt += req.allowCustom !== false ? "Select number or enter custom answer (empty to cancel): " : "Select number (empty to cancel): ";
    } else {
      prompt += "Answer (empty to cancel): ";
    }
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      if (req.options && req.options.length > 0 && /^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10) - 1;
        if (idx >= 0 && idx < req.options.length) {
          resolve(req.options[idx]!);
          return;
        }
      }
      resolve(trimmed);
    });
  });
}

function askCliLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function printLoginHelp(): void {
  process.stdout.write(
    `kern login — log in to an LLM provider\n\nUsage:\n  kern login [provider] [options]\n  kern login --list\n\nOptions:\n  --base-url URL   Provider OpenAI-compatible base URL\n  --model ID       Model id to configure for this provider\n  --api-key KEY    API key, $ENV_VAR, or !command (saved securely to ~/.kern/auth.json when literal)\n  --default        Set as default provider/model in ~/.kern/models.json\n  --no-test        Skip live /models probe\n  --list, --status List saved provider credentials\n  --cwd DIR        Workspace root (default: cwd)\n`,
  );
}

function printLogoutHelp(): void {
  process.stdout.write(
    `kern logout — clear saved provider credentials\n\nUsage:\n  kern logout [provider]\n  kern logout --all\n`,
  );
}

async function runLoginCli(argv: string[]): Promise<void> {
  let cwd = process.cwd();
  let providerArg: string | undefined;
  let baseUrlArg: string | undefined;
  let modelArg: string | undefined;
  let apiKeyArg: string | undefined;
  let makeDefault = false;
  let skipTest = false;
  let listOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      printLoginHelp();
      return;
    } else if (a === "--list" || a === "--status") {
      listOnly = true;
    } else if (a === "--default") {
      makeDefault = true;
    } else if (a === "--no-test") {
      skipTest = true;
    } else if (a === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error("--cwd requires a directory");
      cwd = next;
    } else if (a === "--base-url") {
      const next = argv[++i];
      if (!next) throw new Error("--base-url requires a URL");
      baseUrlArg = next;
    } else if (a === "--model") {
      const next = argv[++i];
      if (!next) throw new Error("--model requires an id");
      modelArg = next;
    } else if (a === "--api-key") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--api-key requires a value");
      apiKeyArg = next;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown login flag: ${a}`);
    } else if (!providerArg) {
      providerArg = a;
    } else {
      throw new Error(`Unexpected login argument: ${a}`);
    }
  }

  const file = await loadModelsFile(cwd);
  const auth = await loadAuth();

  if (listOnly) {
    const names = new Set([...Object.keys(auth), ...Object.keys(file.providers ?? {})]);
    if (names.size === 0) {
      process.stdout.write("No logged-in or configured providers. Run `kern login` to add one.\n");
      return;
    }
    for (const p of [...names].sort()) {
      const cred = auth[p]?.apiKey;
      const cfg = file.providers?.[p];
      const credDesc = cred ? `logged in (${maskKey(cred)})` : cfg?.apiKeyEnv ? `env ($${cfg.apiKeyEnv})` : "no saved key";
      const defMark = file.defaultProvider === p ? " [default]" : "";
      process.stdout.write(`${p}\t${credDesc}${defMark}${cfg?.baseUrl ? `\t${cfg.baseUrl}` : ""}\n`);
    }
    return;
  }

  let name = providerArg?.trim().toLowerCase();
  if (!name) {
    if (!process.stdin.isTTY) {
      throw new Error("Usage: kern login <provider> [--base-url URL] [--model ID] [--api-key KEY] [--default]");
    }
    process.stderr.write("Select provider:\n");
    const candidates = PROVIDER_PRESETS.map((p) => p.name);
    for (const cfgName of Object.keys(file.providers ?? {})) {
      if (!candidates.includes(cfgName)) candidates.push(cfgName);
    }
    candidates.forEach((p, idx) => {
      const badge = auth[p]?.apiKey ? ` (logged in: ${maskKey(auth[p]!.apiKey!)})` : auth[p] ? " (logged in)" : "";
      process.stderr.write(`  ${idx + 1}. ${p}${badge}\n`);
    });
    const ans = await askCliLine("Provider number or name: ");
    if (!ans) throw new Error("Login cancelled.");
    if (/^\d+$/.test(ans)) {
      const idx = Number.parseInt(ans, 10) - 1;
      if (idx < 0 || idx >= candidates.length) throw new Error("Invalid provider selection.");
      name = candidates[idx]!;
    } else {
      name = ans.toLowerCase();
    }
  }

  if (!/^[a-z0-9.-]{1,32}$/.test(name)) {
    throw new Error(`Invalid provider name "${name}" — use [a-z0-9.-] (up to 32 chars).`);
  }

  const existingCfg = file.providers?.[name];
  const preset = PROVIDER_PRESETS.find((p) => p.name === name);
  let baseUrl = baseUrlArg ?? existingCfg?.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) {
    if (!process.stdin.isTTY) {
      throw new Error(`--base-url is required for custom provider "${name}"`);
    }
    baseUrl = await askCliLine(`Base URL for ${name} (default http://localhost:11434/v1): `);
    if (!baseUrl) baseUrl = "http://localhost:11434/v1";
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`Invalid base URL "${baseUrl}" — must start with http:// or https://`);
  }

  let apiKey = apiKeyArg;
  if (apiKey === undefined && process.stdin.isTTY) {
    const envHint = existingCfg?.apiKeyEnv ?? preset?.apiKeyEnv;
    const prompt = envHint
      ? `API key, $ENV_VAR, or !cmd (leave blank for ${existingCfg ? "existing" : `$${envHint}`}; enter "none" for local): `
      : 'API key, $ENV_VAR, or !cmd (leave blank / "none" for local): ';
    const typed = await askCliLine(prompt);
    if (typed.toLowerCase() === "none") apiKey = undefined;
    else if (typed) apiKey = typed;
    else if (!existingCfg && envHint) apiKey = `$${envHint}`;
  } else if (apiKey === undefined && !existingCfg && preset?.apiKeyEnv) {
    apiKey = `$${preset.apiKeyEnv}`;
  }

  let discoveredModels: string[] = [];
  if (!skipTest && (!modelArg || apiKey !== undefined)) {
    const res = await testProvider(baseUrl, apiKey, {}).catch((e) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (res.ok) {
      discoveredModels = res.models;
    } else if (!modelArg) {
      process.stderr.write(`[login warning] probe failed: ${res.message}\n`);
    }
  }

  let modelId = modelArg ?? existingCfg?.models?.[0]?.id ?? discoveredModels[0];
  if (!modelId) {
    if (!process.stdin.isTTY) {
      throw new Error(`--model is required for "${name}" when live discovery yields no models`);
    }
    modelId = await askCliLine(`Model ID for ${name}: `);
    if (!modelId) throw new Error("Model ID is required.");
  }

  if (apiKey && !apiKey.startsWith("$") && !apiKey.startsWith("!")) {
    await saveAuthKey(name, apiKey);
  }

  const presetEnv = existingCfg?.apiKeyEnv ?? preset?.apiKeyEnv;
  const envMatch = apiKey?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  const apiKeyEnvOut = envMatch?.[1] ?? presetEnv;
  const cfg: ProviderConfig = {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnvOut ? { apiKeyEnv: apiKeyEnvOut } : {}),
    models: existingCfg?.models?.some((m) => m.id === modelId)
      ? existingCfg.models
      : [{ id: modelId }, ...(existingCfg?.models ?? [])],
  };

  const saved = await saveProviderToUserFile(name, cfg, { makeDefault });
  process.stdout.write(`Logged in to ${name} (${saved.summary} -> ${saved.path})\n`);
}

async function runLogoutCli(argv: string[]): Promise<void> {
  let all = false;
  let target: string | undefined;
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      printLogoutHelp();
      return;
    } else if (a === "--all" || a === "all") {
      all = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown logout flag: ${a}`);
    } else if (!target) {
      target = a;
    } else {
      throw new Error(`Unexpected logout argument: ${a}`);
    }
  }

  const auth = await loadAuth();
  const saved = Object.keys(auth);
  if (saved.length === 0) {
    process.stdout.write("No saved provider credentials found in ~/.kern/auth.json.\n");
    return;
  }

  if (all) {
    for (const p of saved) await clearAuthKey(p);
    process.stdout.write(`Logged out of all providers (${saved.join(", ")}).\n`);
    return;
  }

  if (!target) {
    if (!process.stdin.isTTY) {
      throw new Error("Usage: kern logout <provider|--all>");
    }
    process.stderr.write("Logged-in providers:\n");
    saved.forEach((p, idx) => {
      process.stderr.write(`  ${idx + 1}. ${p} (${maskKey(auth[p]?.apiKey ?? "")})\n`);
    });
    const ans = await askCliLine('Provider number, name, or "all": ');
    if (!ans) throw new Error("Logout cancelled.");
    if (ans.toLowerCase() === "all") {
      for (const p of saved) await clearAuthKey(p);
      process.stdout.write(`Logged out of all providers (${saved.join(", ")}).\n`);
      return;
    }
    if (/^\d+$/.test(ans)) {
      const idx = Number.parseInt(ans, 10) - 1;
      if (idx < 0 || idx >= saved.length) throw new Error("Invalid selection.");
      target = saved[idx]!;
    } else {
      target = ans;
    }
  }

  if (!auth[target]) {
    process.stdout.write(`No saved credentials for "${target}" in ~/.kern/auth.json.\n`);
    return;
  }
  await clearAuthKey(target);
  process.stdout.write(`Logged out of ${target} (removed from ~/.kern/auth.json).\n`);
}

function parseKeyValuePair(raw: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Error(`Expected KEY=VALUE, got "${raw}"`);
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function printMcpHelp(): void {
  process.stdout.write(
    `kern mcp — manage MCP servers & external tool connectors\n\nUsage:\n  kern mcp list [--cwd DIR]\n  kern mcp presets\n  kern mcp add <name> <url-or-command> [args...] [--project] [--transport stdio|http|sse] [--deferred] [--env KEY=VAL] [--header KEY=VAL] [--cwd DIR]\n  kern mcp add --preset <id> [name] [--project] [--deferred] [--env KEY=VAL] [--header KEY=VAL] [--cwd DIR]\n  kern mcp remove <name> [--user|--project] [--cwd DIR]\n  kern mcp enable <name> [--cwd DIR]\n  kern mcp disable <name> [--cwd DIR]\n  kern mcp test [name] [--cwd DIR]\n  kern mcp trust <name> [--cwd DIR]\n`,
  );
}

async function runMcpCli(argv: string[], logger: ReturnType<typeof createLogger>): Promise<void> {
  const sub = (argv[0] ?? "list").toLowerCase();
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printMcpHelp();
    return;
  }

  if (sub === "presets") {
    for (const p of CONNECTOR_PRESETS) {
      const vars = p.variables?.length ? ` [vars: ${p.variables.map((v) => v.key).join(", ")}]` : "";
      process.stdout.write(`${p.id.padEnd(20)} ${p.transport.padEnd(6)} ${p.name} — ${p.description}${vars}\n`);
    }
    return;
  }

  let cwd = process.cwd();
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error("--cwd requires a directory");
      cwd = next;
    } else {
      rest.push(a);
    }
  }

  const mgr = new ConnectManager({ cwd, logger });
  try {
    if (sub === "list" || sub === "ls" || sub === "test") {
      const targetName = sub === "test" ? rest[0] : undefined;
      const { servers, warnings } = await mgr.discoverAndConnect();
      for (const w of warnings) process.stderr.write(`[mcp notice] ${w}\n`);
      const filtered = targetName ? servers.filter((s) => s.name === targetName) : servers;
      if (targetName && filtered.length === 0) {
        throw new Error(`MCP server "${targetName}" not found in configuration.`);
      }
      if (filtered.length === 0) {
        process.stdout.write("No MCP servers configured. Use `kern mcp add <name> <url-or-cmd>` or `kern mcp presets`.\n");
        return;
      }
      let hasFailure = false;
      for (const s of filtered) {
        if (sub === "test" && (s.state === "error" || s.state === "untrusted")) {
          hasFailure = true;
        }
        const deferredTag = s.deferred ? " [deferred]" : "";
        const badge =
          s.state === "connected"
            ? `${s.tools.length} tool(s)${deferredTag}`
            : s.state === "error"
              ? `error: ${s.error ?? "failed"}`
              : s.state;
        process.stdout.write(`${s.name}\t${s.transport}\t${s.origin}\t${s.state}\t${badge}\t${s.target}\n`);
        if (s.tools.length > 0) {
          process.stdout.write(`  tools: ${s.tools.map((t) => t.registeredName).join(", ")}\n`);
        }
        if (s.resources.length > 0) {
          process.stdout.write(`  resources: ${s.resources.length}\n`);
        }
        if (s.prompts.length > 0) {
          process.stdout.write(`  prompts: ${s.prompts.length}\n`);
        }
        if (s.warning) {
          process.stdout.write(`  warning: ${s.warning}\n`);
        }
      }
      if (hasFailure) {
        process.exitCode = 1;
      }
      return;
    }

    if (sub === "add") {
      let scope: "user" | "project" = "user";
      let transport: McpTransportType | undefined;
      let presetId: string | undefined;
      let deferred = false;
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const pos: string[] = [];

      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--project") scope = "project";
        else if (a === "--user") scope = "user";
        else if (a === "--deferred") deferred = true;
        else if (a === "--preset") {
          const next = rest[++i];
          if (!next) throw new Error("--preset requires a preset id (see `kern mcp presets`)");
          presetId = next;
        } else if (a === "--transport") {
          const next = rest[++i];
          if (next !== "stdio" && next !== "http" && next !== "sse") {
            throw new Error("--transport must be stdio, http, or sse");
          }
          transport = next;
        } else if (a === "--env") {
          const next = rest[++i];
          if (!next) throw new Error("--env requires KEY=VALUE");
          const [k, v] = parseKeyValuePair(next);
          env[k] = v;
        } else if (a === "--header") {
          const next = rest[++i];
          if (!next) throw new Error("--header requires KEY=VALUE");
          const [k, v] = parseKeyValuePair(next);
          headers[k] = v;
        } else {
          pos.push(a);
        }
      }

      let name: string;
      let entry: McpServerConfigEntry;
      if (presetId) {
        const preset = findConnectorPreset(presetId);
        if (!preset) {
          throw new Error(`Unknown MCP preset "${presetId}". Run \`kern mcp presets\` to list available presets.`);
        }
        name = pos[0] || preset.id;
        entry = {
          ...preset.entry,
          ...(preset.entry.args ? { args: [...preset.entry.args] } : {}),
          ...(preset.entry.env ? { env: { ...preset.entry.env, ...env } } : Object.keys(env).length > 0 ? { env } : {}),
          ...(preset.entry.headers
            ? { headers: { ...preset.entry.headers, ...headers } }
            : Object.keys(headers).length > 0
              ? { headers }
              : {}),
          ...(deferred ? { deferred: true } : {}),
        };
      } else {
        name = pos[0] ?? "";
        const target = pos[1];
        if (!name || !target) {
          throw new Error(
            "Usage: kern mcp add <name> <url-or-command> [args...] [--project] [--transport stdio|http|sse] [--deferred] [--env KEY=VAL] [--header KEY=VAL]",
          );
        }
        const args = pos.slice(2);
        const isRemote = /^https?:\/\//i.test(target) || transport === "http" || transport === "sse";
        entry = isRemote
          ? {
              transport: transport ?? (/\/sse(?:[/?#]|$)/i.test(target) ? "sse" : "http"),
              url: target,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              ...(deferred ? { deferred: true } : {}),
            }
          : {
              transport: "stdio",
              command: target,
              ...(args.length > 0 ? { args } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
              ...(deferred ? { deferred: true } : {}),
            };
      }

      const status = await mgr.addServer(name, entry, { scope });
      process.stdout.write(
        `${status.name} (${status.transport}, ${scope}): ${status.state} — ${status.tools.length} tool(s)${status.deferred ? " [deferred]" : ""}\n`,
      );
      if (status.warning) process.stderr.write(`[mcp notice] ${status.warning}\n`);
      if (status.error) {
        process.stderr.write(`[mcp error] ${status.error}\n`);
        process.exitCode = 1;
      }
      if (status.tools.length > 0) {
        process.stdout.write(`Tools: ${status.tools.map((t) => t.registeredName).join(", ")}\n`);
      }
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const name = rest[0];
      if (!name) throw new Error(`Usage: kern mcp ${sub} <name>`);
      await mgr.discoverAndConnect();
      const status = await mgr.toggleServer(name, sub === "disable");
      process.stdout.write(`${status.name}: ${status.state} (${status.tools.length} tool(s))\n`);
      if (status.error) {
        process.stderr.write(`[mcp error] ${status.error}\n`);
        process.exitCode = 1;
      }
      return;
    }

    if (sub === "remove" || sub === "rm") {
      let scope: "user" | "project" | "both" = "both";
      const pos: string[] = [];
      for (const a of rest) {
        if (a === "--user") scope = "user";
        else if (a === "--project") scope = "project";
        else pos.push(a);
      }
      const name = pos[0];
      if (!name) throw new Error("Usage: kern mcp remove <name> [--user|--project]");
      await mgr.discoverAndConnect();
      const removed = await mgr.removeServer(name, { scope });
      process.stdout.write(removed ? `Removed MCP server "${name}".\n` : `MCP server "${name}" was not configured.\n`);
      return;
    }

    if (sub === "trust") {
      const name = rest[0];
      if (!name) throw new Error("Usage: kern mcp trust <name>");
      await mgr.discoverAndConnect();
      const status = await mgr.trustServer(name);
      process.stdout.write(`Trusted "${name}": ${status.state} (${status.tools.length} tool(s))\n`);
      if (status.error) {
        process.stderr.write(`[mcp error] ${status.error}\n`);
        process.exitCode = 1;
      }
      return;
    }

    throw new Error(`Unknown mcp subcommand: ${sub}. Run \`kern mcp --help\` for usage.`);
  } finally {
    await mgr.dispose();
  }
}

function printAgentsHelp(): void {
  process.stdout.write(
    `kern agents — manage opt-in team specialists & remote A2A agents\n\nUsage:\n  kern agents list [--cwd DIR]\n  kern agents presets\n  kern agents format\n  kern agents init <name> [--preset <id>] [--format md|yaml|json] [--project|--user] [--cwd DIR]\n  kern agents add <name> [options]\n  kern agents add --preset <id> [name] [--project] [--model provider/id] [--cwd DIR]\n  kern agents remove <name> [--user|--project] [--cwd DIR]\n  kern agents enable <name> [--cwd DIR]\n  kern agents disable <name> [--cwd DIR]\n  kern agents trust <name> [--cwd DIR]\n\nAdd / Init Options:\n  --preset <id>                  Use built-in template (explorer, reviewer, coder, researcher)\n  --format md|yaml|json          File format when saving (default: md)\n  --project                      Save to .kern/agents/ in current workspace (auto-trusted)\n  --user                         Save to ~/.kern/agents/ (default)\n  --mode readonly|write          Specialist tool capability mode (default: readonly)\n  --isolation readonly|exclusive|worktree  Workspace isolation policy\n  --model <provider/id>          Pin specialist model (falls back to parent unless --strict-model)\n  --strict-model                 Fail instead of falling back to parent model\n  --tools <t1,t2,...>            Restrict built-in tools (or shorthand: readonly|coding|research)\n  --mcp <s1,s2,...>              Allowlist parent MCP server names to share with specialist\n  --a2a <url>                    Register a remote A2A agent endpoint URL\n  --header KEY=VAL               HTTP header for remote A2A calls (supports \${ENV_VAR})\n  --description TEXT             Routing summary visible to root orchestrator\n  --instruction TEXT             Specialist system instruction\n  --max-turns N                  Cap specialist turns per delegation\n  --max-cost N                   Cap specialist USD cost per delegation\n  --allow-delegation             Allow specialist to sub-delegate (depth <= 2)\n`,
  );
}

async function runAgentsCli(argv: string[], logger: ReturnType<typeof createLogger>): Promise<void> {
  const sub = (argv[0] ?? "list").toLowerCase();
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printAgentsHelp();
    return;
  }

  if (sub === "format" || sub === "formats" || sub === "guide") {
    process.stdout.write(`${SUBAGENT_FORMAT_GUIDE}\n`);
    return;
  }

  if (sub === "presets") {
    for (const p of SUBAGENT_PRESETS) {
      const mode = p.entry.mode ?? "readonly";
      const iso = p.entry.isolation ?? "readonly";
      process.stdout.write(`${p.id.padEnd(14)} ${mode.padEnd(9)} ${iso.padEnd(10)} ${p.name} — ${p.description}\n`);
    }
    return;
  }

  let cwd = process.cwd();
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error("--cwd requires a directory");
      cwd = next;
    } else {
      rest.push(a);
    }
  }

  const mgr = new SubagentManager({ cwd, logger });
  try {
    if (sub === "list" || sub === "ls" || sub === "status") {
      const { agents, warnings } = await mgr.discover();
      for (const w of warnings) process.stderr.write(`[agents notice] ${w}\n`);
      if (agents.length === 0) {
        process.stdout.write(
          "No subagents or A2A agents configured (core loop runs solo with zero delegation overhead).\n" +
            "Use `kern agents presets` or `kern agents add --preset explorer` to add opt-in specialists.\n",
        );
        return;
      }
      for (const a of agents) {
        const cap = a.type === "a2a" ? `a2a(${a.url ?? ""})` : `${a.mode}/${a.isolation}`;
        const modelTag = a.model ? ` model=${a.model}` : "";
        process.stdout.write(`${a.name}\t${a.type}\t${a.origin}\t${a.state}\t${cap}${modelTag}\t${a.description}\n`);
        if (a.skills?.length) {
          process.stdout.write(`  skills: ${a.skills.map((sk) => sk.name).join(", ")}\n`);
        }
        if (a.warning) {
          process.stdout.write(`  warning: ${a.warning}\n`);
        }
      }
      return;
    }

    if (sub === "add" || sub === "init" || sub === "new") {
      const isInit = sub === "init" || sub === "new";
      let scope: "user" | "project" = isInit ? "project" : "user";
      let format: SubagentFileFormat | undefined = isInit ? "md" : undefined;
      let presetId: string | undefined;
      let mode: SubagentMode | undefined;
      let isolation: SubagentIsolation | undefined;
      let model: string | undefined;
      let strictModel = false;
      let tools: string[] | undefined;
      let mcpServers: string[] | undefined;
      let a2aUrl: string | undefined;
      let description: string | undefined;
      let instruction: string | undefined;
      let maxTurns: number | undefined;
      let maxCost: number | undefined;
      let allowDelegation = false;
      const headers: Record<string, string> = {};
      const pos: string[] = [];

      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--project") scope = "project";
        else if (a === "--user") scope = "user";
        else if (a === "--strict-model") strictModel = true;
        else if (a === "--allow-delegation") allowDelegation = true;
        else if (a === "--format") {
          const next = rest[++i]?.toLowerCase();
          if (next !== "md" && next !== "yaml" && next !== "json") {
            throw new Error("--format must be md, yaml, or json");
          }
          format = next;
        } else if (a === "--preset") {
          const next = rest[++i];
          if (!next) throw new Error("--preset requires a preset id (see `kern agents presets`)");
          presetId = next;
        } else if (a === "--mode") {
          const next = rest[++i];
          if (next !== "readonly" && next !== "write") throw new Error("--mode must be readonly or write");
          mode = next;
        } else if (a === "--isolation") {
          const next = rest[++i];
          if (next !== "readonly" && next !== "exclusive" && next !== "worktree") {
            throw new Error("--isolation must be readonly, exclusive, or worktree");
          }
          isolation = next;
        } else if (a === "--model") {
          const next = rest[++i];
          if (!next) throw new Error("--model requires provider/id or id");
          model = next;
        } else if (a === "--tools") {
          const next = rest[++i];
          if (!next) throw new Error("--tools requires comma-separated tool names");
          tools = next.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (a === "--mcp") {
          const next = rest[++i];
          if (!next) throw new Error("--mcp requires comma-separated MCP server names");
          mcpServers = next.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (a === "--a2a" || a === "--url") {
          const next = rest[++i];
          if (!next) throw new Error(`${a} requires an http(s) URL`);
          a2aUrl = next;
        } else if (a === "--header") {
          const next = rest[++i];
          if (!next) throw new Error("--header requires KEY=VALUE");
          const [k, v] = parseKeyValuePair(next);
          headers[k] = v;
        } else if (a === "--description") {
          const next = rest[++i];
          if (!next) throw new Error("--description requires text");
          description = next;
        } else if (a === "--instruction") {
          const next = rest[++i];
          if (!next) throw new Error("--instruction requires text");
          instruction = next;
        } else if (a === "--max-turns") {
          const res = parsePositiveInt(rest, i, "--max-turns");
          maxTurns = res.value;
          i = res.nextIndex;
        } else if (a === "--max-cost") {
          const next = rest[++i];
          const n = next !== undefined ? Number(next) : NaN;
          if (!Number.isFinite(n) || n <= 0) throw new Error("--max-cost requires a positive number");
          maxCost = n;
        } else if (a.startsWith("--")) {
          throw new Error(`Unknown agents add flag: ${a}`);
        } else {
          pos.push(a);
        }
      }

      let entry: SubagentConfigEntry;
      if (presetId) {
        const preset = findSubagentPreset(presetId);
        if (!preset) {
          throw new Error(`Unknown subagent preset "${presetId}". Run \`kern agents presets\` to list available presets.`);
        }
        entry = {
          ...preset.entry,
          ...(pos[0] ? { name: pos[0] } : {}),
          ...(mode ? { mode } : {}),
          ...(isolation ? { isolation } : {}),
          ...(model ? { model } : {}),
          ...(strictModel ? { strictModel: true } : {}),
          ...(tools ? { tools } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          ...(description ? { description } : {}),
          ...(instruction ? { instruction } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(maxCost !== undefined ? { maxCost } : {}),
          ...(allowDelegation ? { allowDelegation: true } : {}),
        };
      } else {
        const name = pos[0] ?? "";
        if (!name) {
          throw new Error("Usage: kern agents add <name> [--a2a URL | --description TEXT] [--mode readonly|write]");
        }
        if (a2aUrl) {
          entry = {
            name,
            type: "a2a",
            url: a2aUrl,
            description: description || `Remote A2A agent at ${a2aUrl}`,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        } else {
          entry = {
            name,
            type: "local",
            description: description || `${name} specialist agent`,
            ...(instruction ? { instruction } : {}),
            ...(mode ? { mode } : {}),
            ...(isolation ? { isolation } : {}),
            ...(model ? { model } : {}),
            ...(strictModel ? { strictModel: true } : {}),
            ...(tools ? { tools } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(maxCost !== undefined ? { maxCost } : {}),
            ...(allowDelegation ? { allowDelegation: true } : {}),
          };
        }
      }

      const status = await mgr.addSubagent(entry, { scope, format, templateComments: isInit });
      process.stdout.write(
        `${status.name} (${status.type}, ${scope}): ${status.state}${status.sourcePath ? ` -> ${status.sourcePath}` : ""}\n`,
      );
      if (isInit && status.sourcePath) {
        process.stdout.write(`Edit ${status.sourcePath} to customize prompt, tools, or model, then run \`kern agents list\` or \`/agents reload\`.\n`);
      }
      if (status.warning) process.stderr.write(`[agents notice] ${status.warning}\n`);
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const name = rest[0];
      if (!name) throw new Error(`Usage: kern agents ${sub} <name>`);
      await mgr.discover();
      const status = await mgr.toggleSubagent(name, sub === "disable");
      process.stdout.write(`${status.name}: ${status.state}\n`);
      return;
    }

    if (sub === "remove" || sub === "rm") {
      let scope: "user" | "project" | "both" = "both";
      const pos: string[] = [];
      for (const a of rest) {
        if (a === "--user") scope = "user";
        else if (a === "--project") scope = "project";
        else pos.push(a);
      }
      const name = pos[0];
      if (!name) throw new Error("Usage: kern agents remove <name> [--user|--project]");
      await mgr.discover();
      const removed = await mgr.removeSubagent(name, { scope });
      process.stdout.write(removed ? `Removed subagent "${name}".\n` : `Subagent "${name}" was not configured.\n`);
      return;
    }

    if (sub === "trust") {
      const name = rest[0];
      if (!name) throw new Error("Usage: kern agents trust <name>");
      await mgr.discover();
      const status = await mgr.trustSubagent(name);
      process.stdout.write(`Trusted "${name}": ${status.state}\n`);
      return;
    }

    throw new Error(`Unknown agents subcommand: ${sub}. Run \`kern agents --help\` for usage.`);
  } finally {
    await mgr.dispose();
  }
}

/** Validate configuration files. */
async function validateConfig(configPath: string | undefined, cwd: string, _logger: ReturnType<typeof createLogger>): Promise<void> {
  const { resolve, join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { readFile, stat } = await import("node:fs/promises");

  let modelsPath: string;
  if (configPath) {
    const candidate = resolve(cwd, configPath);
    if (candidate.endsWith(".json")) {
      modelsPath = candidate;
    } else {
      const kernModels = resolve(candidate, ".kern", "models.json");
      const directModels = resolve(candidate, "models.json");
      let chosen = directModels;
      try {
        await stat(kernModels);
        chosen = kernModels;
      } catch {
        // fall back to directModels
      }
      modelsPath = chosen;
    }
  } else {
    const projectModels = join(resolve(cwd), ".kern", "models.json");
    const userModels = join(homedir(), ".kern", "models.json");
    let chosen = userModels;
    try {
      await stat(projectModels);
      chosen = projectModels;
    } catch {
      // fall back to ~/.kern/models.json (matches --help)
    }
    modelsPath = chosen;
  }

  try {
    await stat(modelsPath);
  } catch {
    throw new Error(`Config file not found: ${modelsPath}`);
  }

  let file: Awaited<ReturnType<typeof loadModelsFile>>;
  try {
    const raw = await readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Top-level config must be a JSON object");
    }
    file = parsed as Awaited<ReturnType<typeof loadModelsFile>>;
  } catch (error) {
    throw new Error(`Invalid JSON in ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const errors: string[] = [];

  for (const [name, cfg] of Object.entries(file.providers ?? {})) {
    if (!cfg.baseUrl) errors.push(`Provider "${name}" missing baseUrl`);
    if (cfg.apiKey && cfg.apiKey.startsWith("$")) {
      const match = cfg.apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
      const envVar = match?.[1] ?? cfg.apiKey.slice(1);
      if (envVar && !process.env[envVar] && !cfg.apiKeyEnv) {
        errors.push(`Provider "${name}" references unset env var ${cfg.apiKey}`);
      }
    }
    if (!cfg.models || cfg.models.length === 0) {
      errors.push(`Provider "${name}" has no models configured`);
    }
  }

  const providerNames = Object.keys(file.providers ?? {});
  if (!file.defaultProvider && providerNames.length > 0) {
    errors.push("No defaultProvider set");
  } else if (file.defaultProvider && providerNames.length > 0 && !file.providers?.[file.defaultProvider]) {
    errors.push(`defaultProvider "${file.defaultProvider}" is not defined in providers`);
  }

  if (Array.isArray(file.fallbackModels)) {
    for (const entry of file.fallbackModels) {
      let fbProvider: string | undefined;
      let fbModel: string | undefined;
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.includes("/")) {
          const [p, ...rest] = trimmed.split("/");
          fbProvider = p;
          fbModel = rest.join("/");
        } else {
          fbProvider = file.defaultProvider;
          fbModel = trimmed;
        }
      } else if (entry && typeof entry === "object") {
        fbProvider = typeof entry.provider === "string" ? entry.provider : undefined;
        fbModel = typeof entry.model === "string" ? entry.model : undefined;
      }
      if (!fbProvider || !fbModel) {
        errors.push(`Invalid fallbackModels entry: ${JSON.stringify(entry)}`);
      } else if (providerNames.length > 0 && !file.providers?.[fbProvider]) {
        errors.push(`fallbackModels references unknown provider "${fbProvider}"`);
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`[error] ${e}\n`);
    throw new Error("Configuration validation failed");
  }

  process.stdout.write(`Configuration valid: ${modelsPath}\n`);
  process.stdout.write(`  Providers: ${providerNames.join(", ") || "none"}\n`);
  process.stdout.write(`  Default provider: ${file.defaultProvider ?? "none"}\n`);
  process.stdout.write(`  Default model: ${file.defaultModel ?? "none"}\n`);
}

/** JSON-RPC mode for programmatic use. */
async function runRpcMode(
  flags: CliFlags,
  file: Awaited<ReturnType<typeof loadModelsFile>>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const provider = flags.provider ?? process.env["KERN_PROVIDER"];
  let model = flags.model ?? process.env["KERN_MODEL"];
  const baseUrl = flags.baseUrl ?? process.env["KERN_BASE_URL"];
  const apiKey = flags.apiKey ?? process.env["KERN_API_KEY"];

  let providerName = provider ?? file.defaultProvider;
  if (model && model.includes("/")) {
    const [p, ...rest] = model.split("/");
    providerName = p;
    model = rest.join("/");
  }
  model ??= file.defaultModel;

  let adapter = undefined;
  let fallbackModels: Awaited<ReturnType<typeof resolveFallbackAdapters>> = [];
  if (providerName && model) {
    adapter = await createModelRuntime(file, { provider: providerName, model, baseUrl, apiKey }, logger);
    fallbackModels = await resolveFallbackAdapters(file, { provider: providerName, model }, logger);
  } else if (baseUrl && model) {
    adapter = await createModelRuntime(file, { model, baseUrl, apiKey }, logger);
    fallbackModels = await resolveFallbackAdapters(file, { provider: providerName, model }, logger);
  }

  const budgets = buildBudgets(flags);
  const sessionOptions = {
    cwd: flags.cwd,
    logger,
    loadResources: !flags.noResources,
    enableCompaction: !flags.noCompaction,
    enableConnects: !flags.noMcp,
    enableSubagents: !flags.noAgents,
    resume: flags.resume,
    ...(flags.resumeSession ? { resumeSession: flags.resumeSession } : {}),
    policy: flags.readOnly ? { allowlistTools: READ_ONLY_TOOLS } : undefined,
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
    ...(flags.safetyMode ? { safetyMode: flags.safetyMode } : {}),
    ...(adapter ? { model: adapter } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
  };

  const { session, manager } = await createAgentSession(sessionOptions);
  session.subscribe((ev) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: ev }) + "\n");
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let requestId = 0;
  let closed = false;
  let resolveDone: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const shutdownRpc = async () => {
    if (closed) return;
    closed = true;
    await session.subagents?.dispose().catch(() => {});
    await session.connects?.dispose().catch(() => {});
    session.dispose();
    resolveDone?.();
  };
  rl.once("close", () => {
    void shutdownRpc();
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req: { id?: number; method?: string; params?: unknown } = {};
    try {
      req = JSON.parse(line);
      const id = req.id ?? ++requestId;
      const method = req.method;
      const params = (req.params ?? {}) as Record<string, unknown>;

      let result: unknown;
      switch (method) {
        case "prompt": {
          await session.prompt((params.text as string) ?? "");
          result = { ok: true };
          break;
        }
        case "steer": {
          await session.steeredPrompt?.((params.text as string) ?? "");
          result = { ok: true };
          break;
        }
        case "follow_up": {
          await session.followUp?.((params.text as string) ?? "");
          result = { ok: true };
          break;
        }
        case "tools": {
          result = { tools: session.toolNames() };
          break;
        }
        case "session": {
          result = { id: manager.sessionId, name: session.sessionName(), model: session.modelInfo(), safetyMode: session.safetyMode() };
          break;
        }
        case "history": {
          result = { messages: manager.getActiveMessages().map((e) => e.message) };
          break;
        }
        case "set_safety": {
          const mode = params.mode as "strict" | "balanced" | "restricted" | "autonomous";
          if (!["strict", "balanced", "restricted", "autonomous"].includes(mode)) {
            throw new Error(`Invalid safety mode: ${String(mode)}`);
          }
          result = { ok: session.setSafetyMode(mode), safetyMode: session.safetyMode() };
          break;
        }
        case "budget": {
          result = { usage: session.budgetUsage(), limits: session.budgetLimits?.() };
          break;
        }
        case "compact": {
          const res = await session.compact(params.instructions as string | undefined);
          result = res ?? { ok: false, reason: "nothing to compact" };
          break;
        }
        case "connects_list": {
          result = {
            servers: session.connects?.listStatuses() ?? [],
            warnings: session.connects?.getWarnings() ?? [],
            presets: CONNECTOR_PRESETS,
          };
          break;
        }
        case "connects_add": {
          if (!session.connects) throw new Error("Connects manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          const entry = params.entry as McpServerConfigEntry | undefined;
          const scope = (params.scope === "project" || params.scope === "memory" ? params.scope : "user") as "user" | "project" | "memory";
          if (!name || !entry || typeof entry !== "object") {
            throw new Error("name and entry are required");
          }
          const server = await session.connects.addServer(name, entry, { scope });
          result = { ok: true, server, tools: session.toolNames() };
          break;
        }
        case "connects_remove": {
          if (!session.connects) throw new Error("Connects manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const scope = (params.scope === "user" || params.scope === "project" ? params.scope : "both") as "user" | "project" | "both";
          const removed = await session.connects.removeServer(name, { scope });
          result = { removed, tools: session.toolNames() };
          break;
        }
        case "connects_reconnect": {
          if (!session.connects) throw new Error("Connects manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const server = await session.connects.reconnectServer(name);
          result = { server, tools: session.toolNames() };
          break;
        }
        case "connects_toggle": {
          if (!session.connects) throw new Error("Connects manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const server = await session.connects.toggleServer(name, Boolean(params.disabled));
          result = { server, tools: session.toolNames() };
          break;
        }
        case "connects_trust": {
          if (!session.connects) throw new Error("Connects manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const server = await session.connects.trustServer(name);
          result = { server, tools: session.toolNames() };
          break;
        }
        case "agents_list": {
          result = {
            agents: session.subagents?.listStatuses() ?? [],
            backgroundJobs: session.subagents?.listBackgroundJobs() ?? [],
            warnings: session.subagents?.getWarnings() ?? [],
            presets: SUBAGENT_PRESETS,
            formatGuide: SUBAGENT_FORMAT_GUIDE,
          };
          break;
        }
        case "agents_add": {
          if (!session.subagents) throw new Error("Subagent manager unavailable");
          const scope = (params.scope === "project" || params.scope === "memory" ? params.scope : "user") as "user" | "project" | "memory";
          const format =
            params.format === "yaml" || params.format === "json" || params.format === "md"
              ? (params.format as SubagentFileFormat)
              : undefined;
          let entry = params.entry as SubagentConfigEntry | undefined;
          if (typeof params.rawContent === "string" && params.rawContent.trim()) {
            const parsed = parseSubagentFile(
              params.rawContent,
              format ? `.${format}` : "",
              typeof params.name === "string" ? params.name.trim() : "custom-agent",
            );
            if (!parsed) {
              throw new Error("Could not parse subagent definition (expected name & description in .md, .yaml, or .json format)");
            }
            entry = parsed;
          }
          if (!entry || typeof entry !== "object" || !entry.name) {
            throw new Error("entry with name (or rawContent) is required");
          }
          const agent = await session.subagents.addSubagent(entry, { scope, ...(format ? { format } : {}) });
          result = { ok: true, agent, tools: session.toolNames() };
          break;
        }
        case "agents_remove": {
          if (!session.subagents) throw new Error("Subagent manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const scope = (params.scope === "user" || params.scope === "project" ? params.scope : "both") as "user" | "project" | "both";
          const removed = await session.subagents.removeSubagent(name, { scope });
          result = { removed, tools: session.toolNames() };
          break;
        }
        case "agents_toggle": {
          if (!session.subagents) throw new Error("Subagent manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const agent = await session.subagents.toggleSubagent(name, Boolean(params.disabled));
          result = { agent, tools: session.toolNames() };
          break;
        }
        case "agents_trust": {
          if (!session.subagents) throw new Error("Subagent manager unavailable");
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) throw new Error("name is required");
          const agent = await session.subagents.trustSubagent(name);
          result = { agent, tools: session.toolNames() };
          break;
        }
        case "agents_reload": {
          if (!session.subagents) throw new Error("Subagent manager unavailable");
          const res = await session.subagents.discover();
          result = { ...res, tools: session.toolNames() };
          break;
        }
        case "auth_status": {
          const auth = await loadAuth();
          result = {
            activeProvider: session.modelInfo().provider,
            loggedInProviders: Object.entries(auth).map(([p, entry]) => ({
              provider: p,
              maskedKey: maskKey(entry.apiKey ?? ""),
            })),
          };
          break;
        }
        case "login": {
          const provider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
          if (!provider) throw new Error("provider is required");
          const currentFile = await loadModelsFile(flags.cwd);
          const existing = currentFile.providers?.[provider];
          const preset = PROVIDER_PRESETS.find((p) => p.name === provider);
          const baseUrl = typeof params.baseUrl === "string" && params.baseUrl.trim()
            ? params.baseUrl.trim()
            : existing?.baseUrl ?? preset?.baseUrl ?? "";
          if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            throw new Error("valid baseUrl is required");
          }
          const modelId = typeof params.modelId === "string" && params.modelId.trim()
            ? params.modelId.trim()
            : existing?.models?.[0]?.id ?? "";
          const apiKey = typeof params.apiKey === "string" && params.apiKey.trim()
            ? params.apiKey.trim()
            : undefined;
          if (params.save !== false) {
            if (apiKey && !apiKey.startsWith("$") && !apiKey.startsWith("!")) {
              await saveAuthKey(provider, apiKey);
            }
            if (modelId) {
              const cfg: ProviderConfig = {
                baseUrl,
                ...(apiKey ? { apiKey } : {}),
                ...(existing?.apiKeyEnv || preset?.apiKeyEnv ? { apiKeyEnv: existing?.apiKeyEnv ?? preset?.apiKeyEnv } : {}),
                models: [{ id: modelId }],
              };
              await saveProviderToUserFile(provider, cfg, { makeDefault: Boolean(params.makeDefault) });
            }
          }
          if (modelId) {
            const refreshedFile = await loadModelsFile(flags.cwd);
            const nextAdapter = await createAdapterFor(refreshedFile, provider, modelId, { baseUrl, apiKey }, logger);
            await session.setModel(nextAdapter);
          }
          const auth = await loadAuth();
          result = {
            ok: true,
            model: session.modelInfo(),
            loggedInProviders: Object.keys(auth),
          };
          break;
        }
        case "logout": {
          const auth = await loadAuth();
          const targets = params.all
            ? Object.keys(auth)
            : typeof params.provider === "string" && params.provider.trim()
              ? [params.provider.trim()]
              : [];
          if (targets.length === 0) throw new Error("provider or all=true is required");
          const loggedOut: string[] = [];
          for (const p of targets) {
            if (auth[p]) {
              await clearAuthKey(p);
              loggedOut.push(p);
            }
          }
          const remaining = await loadAuth();
          result = { ok: true, loggedOut, loggedInProviders: Object.keys(remaining) };
          break;
        }
        case "close": {
          await shutdownRpc();
          result = { ok: true };
          break;
        }
        default: {
          throw new Error(`Unknown method: ${method}`);
        }
      }

      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      if (method === "close") rl.close();
    } catch (error) {
      const id = req?.id ?? ++requestId;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }) + "\n");
    }
  });

  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready", params: { sessionId: manager.sessionId, version: KERN_VERSION } }) + "\n");

  await donePromise;
}

export async function main() {
  const logger = createLogger(process.env["KERN_LOG"] === "debug" ? "debug" : "warn");
  if (process.argv[2] === "login") {
    await runLoginCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "logout") {
    await runLogoutCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "mcp") {
    await runMcpCli(process.argv.slice(3), logger);
    return;
  }
  if (process.argv[2] === "agents") {
    await runAgentsCli(process.argv.slice(3), logger);
    return;
  }
  const flags = parseArgs(process.argv.slice(2));
  const provider = flags.provider ?? process.env["KERN_PROVIDER"];
  let model = flags.model ?? process.env["KERN_MODEL"];
  const baseUrl = flags.baseUrl ?? process.env["KERN_BASE_URL"];
  const apiKey = flags.apiKey ?? process.env["KERN_API_KEY"];
  const file = await loadModelsFile(flags.cwd);
  const approvalHook: { current: ((prompt: string, meta?: { toolName: string }) => Promise<boolean | "session">) | null } = { current: null };
  const askUserHook: { current: ((req: AskUserRequest) => Promise<string | null>) | null } = { current: null };

  if (flags.listModels) {
    const models = await discoverModels(file, { provider, baseUrl, apiKey });
    for (const m of models) {
      const mark = m.authenticated ? "" : " (no credentials)";
      process.stdout.write(`${m.provider}/${m.id}${mark} [${m.source}]\n`);
    }
    return;
  }

  if (flags.validateConfig) {
    await validateConfig(flags.config, flags.cwd, logger);
    return;
  }

  if (flags.rpc) {
    await runRpcMode(flags, file, logger);
    return;
  }

  // `--model provider/id` splits; `--provider` + `--model id` also works.
  let providerName = provider ?? file.defaultProvider;
  if (model && model.includes("/")) {
    const [p, ...rest] = model.split("/");
    providerName = p;
    model = rest.join("/");
  }
  model ??= file.defaultModel;
  let adapter = undefined;
  let fallbackModels: Awaited<ReturnType<typeof resolveFallbackAdapters>> = [];
  if (providerName && model) {
    adapter = await createModelRuntime(file, { provider: providerName, model, baseUrl, apiKey }, logger);
    fallbackModels = await resolveFallbackAdapters(file, { provider: providerName, model }, logger);
    process.stderr.write(`[model ${providerName}/${model}]\n`);
  } else if (baseUrl && model) {
    adapter = await createModelRuntime(file, { model, baseUrl, apiKey }, logger);
    fallbackModels = await resolveFallbackAdapters(file, { provider: providerName, model }, logger);
    process.stderr.write(`[model ${providerName ?? "custom"}/${model} @ ${baseUrl}]\n`);
  }
  const budgets = buildBudgets(flags);
  const sessionOptions = {
    cwd: flags.cwd,
    logger,
    loadResources: !flags.noResources,
    enableCompaction: !flags.noCompaction,
    enableConnects: !flags.noMcp,
    enableSubagents: !flags.noAgents,
    resume: flags.resume,
    ...(flags.resumeSession ? { resumeSession: flags.resumeSession } : {}),
    policy: flags.readOnly ? { allowlistTools: READ_ONLY_TOOLS } : undefined,
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
    ...(flags.safetyMode ? { safetyMode: flags.safetyMode } : {}),
    requestApproval: (prompt: string, meta?: { toolName: string }) => (approvalHook.current ? approvalHook.current(prompt, meta) : askApproval(prompt)),
    ...(process.stdin.isTTY ? {
      askUser: (req: AskUserRequest) => (askUserHook.current ? askUserHook.current(req) : askUserCli(req)),
    } : {}),
    ...(adapter ? { model: adapter } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
  };
  const startSession = () => createAgentSession({ ...sessionOptions });
  const { session, manager } = await startSession();
  if (!flags.noMcp && !flags.json && session.connects) {
    const statuses = session.connects.listStatuses();
    for (const s of statuses) {
      if (s.state === "connected") {
        process.stderr.write(`[mcp ${s.name}: ${s.tools.length} tool(s)]\n`);
      } else if (s.state === "untrusted" || s.state === "error") {
        process.stderr.write(`[mcp ${s.name}: ${s.state}${s.error ? ` (${s.error})` : s.warning ? ` (${s.warning})` : ""}]\n`);
      }
    }
  }
  if (!flags.noAgents && !flags.json && session.subagents) {
    const agents = session.subagents.listStatuses();
    for (const a of agents) {
      if (a.state === "ready") {
        process.stderr.write(`[agent ${a.name}: ${a.type === "a2a" ? "a2a" : a.mode}]\n`);
      } else if (a.state === "untrusted" || a.state === "error") {
        process.stderr.write(`[agent ${a.name}: ${a.state}${a.warning ? ` (${a.warning})` : ""}]\n`);
      }
    }
  }

  const canUseTui = process.stdin.isTTY && process.stdout.isTTY;
  const wantInteractive = !flags.print && (flags.interactive || canUseTui);
  if (wantInteractive) {
    if (!canUseTui) throw new Error("Interactive mode requires a TTY");
    const { runInteractive } = await import("@kern/tui");
    await runInteractive({
      session,
      manager,
      newSession: startSession,
      modelsFile: file,
      providerName: providerName,
      baseUrl,
      apiKey,
      cwd: flags.cwd,
      logger,
      approvalHook,
      askUserHook,
      ...(flags.hadPrompt ? { initialPrompt: flags.prompt } : {}),
    });
    return;
  }

  let prompt = flags.prompt || "What is in README.md?";
  if (prompt.trim().startsWith("/skill:")) {
    const resolvedSkill = await resolveSkillInvocation(prompt, flags.cwd);
    if (resolvedSkill.matched) {
      if (resolvedSkill.error) {
        throw new Error(resolvedSkill.error);
      }
      if (resolvedSkill.expandedPrompt) prompt = resolvedSkill.expandedPrompt;
    }
  }
  session.subscribe((ev) => {
    if (flags.json) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      return;
    }
    switch (ev.type) {
      case "text_delta":
        process.stdout.write(ev.delta);
        break;
      case "message_end":
        if (ev.message.role === "assistant") process.stdout.write("\n");
        break;
      case "tool_execution_start":
        process.stderr.write(`[tool ${ev.toolName}]\n`);
        break;
      case "tool_input_repaired":
        process.stderr.write(`[tool ${ev.toolName} args repaired: ${ev.repairs.join(", ")}]\n`);
        break;
      case "tool_execution_end":
        if (ev.isError) process.stderr.write(`[tool ${ev.toolName} failed]\n`);
        break;
      case "model_fallback":
        process.stderr.write(`[fallback ${ev.fromProvider}/${ev.fromModel} -> ${ev.toProvider}/${ev.toModel}: ${ev.reason}]\n`);
        break;
      case "budget_warning":
        process.stderr.write(`[budget warning (${ev.kind}): ${ev.message}]\n`);
        break;
      case "budget_exceeded":
        process.stderr.write(`[budget exceeded (${ev.kind}): ${ev.message}]\n`);
        break;
      case "auto_compaction_start":
        process.stderr.write(`[compacting (${ev.phase})…]\n`);
        break;
      case "auto_compaction_end":
        process.stderr.write(`[compacted]\n`);
        break;
      case "auto_retry_start":
        process.stderr.write(`[retry ${ev.attempt} (${ev.reason}) in ${ev.delayMs}ms]\n`);
        break;
      case "agent_error":
        process.stderr.write(`[error ${ev.error.code}: ${ev.error.message}]\n`);
        break;
    }
  });
  try {
    await session.prompt(prompt);
  } finally {
    await session.subagents?.dispose().catch(() => {});
    await session.connects?.dispose().catch(() => {});
    session.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
