import { createAgentSession } from "@kern/coding-agent";
import { createLogger } from "@kern/protocol";
import { discoverModels, loadModelsFile, createModelRuntime, resolveFallbackAdapters } from "@kern/model";
import { createInterface } from "node:readline";

export const KERN_VERSION = "1.0.0";

const READ_ONLY_TOOLS = ["read", "grep", "find", "git-status", "git-diff", "git-log"];

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
    `kern v${KERN_VERSION} — minimal coding agent kernel\n\nUsage:\n  kern [flags] [prompt]\n\nFlags:\n  --read-only                   Only allow read-only tools (read, grep, find, git-status/diff/log)\n  --max-cost N                  Cap session cost in USD\n  --max-input-tokens N          Cap input tokens for the session\n  --max-output-tokens N         Cap output tokens for the session\n  --max-total-tokens N          Cap total tokens for the session\n  --max-turns N                 Cap model turns per user run\n  --max-wall-time-ms N          Cap wall-clock duration (ms) per user run\n  --max-tool-calls-per-turn N   Cap tool calls in a single turn\n  --max-total-tool-calls N      Cap total tool calls in a user run\n  --cwd DIR                     Workspace root (default: cwd)\n  --no-resources                Skip AGENTS.md / skill discovery\n  --no-compaction               Disable automatic compaction\n  --resume                      Resume the most recent session\n  --session ID|PATH             Resume a specific session by ID or JSONL file path\n  --interactive, -i             Start interactive TUI\n  --print                       Force single-prompt print mode (no TUI)\n  --json                        Emit NDJSON agent events in non-interactive mode (implies --print)\n  --list-models                 List available models (configured + live) and exit\n  --provider NAME               Provider from models.json (or KERN_PROVIDER)\n  --model ID                    Model id, optionally provider/id (or KERN_MODEL)\n  --base-url URL                Override endpoint base URL (or KERN_BASE_URL)\n  --api-key KEY                 Override API key (or KERN_API_KEY)\n  --safety MODE                 Safety mode: strict, balanced, restricted, autonomous (default: balanced)\n  --rpc                         JSON-RPC mode (stdin/stdout)\n  --validate-config             Validate config files and exit\n  --config PATH                 Config file path (default: ~/.kern/models.json)\n  --version, -v                 Show version and exit\n  --help, -h                    This message\n\nBehavior:\n  On a TTY, Kern starts the TUI by default. Use --print for non-interactive output.\n  If a prompt is provided with the TUI, it is sent as the first message.\n`,
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

/** Opt-in MCP plugin: mcp.json files (project + user) plus env overrides. Unset/unconfigured = core unchanged. Fail-closed. */
async function loadMcpExtraTools(cwd: string, logger: ReturnType<typeof createLogger>): Promise<{ extraTools?: import("@kern/protocol").ToolDefinition[] }> {
  try {
    const { discoverMcpFileTools } = await import("@kern/tools");
    const { tools, warnings } = await discoverMcpFileTools(cwd);
    for (const w of warnings) {
      logger.warn("mcp_bridge_notice", { message: w });
      process.stderr.write(`[mcp ${w}]\n`);
    }
    if (tools.length > 0) process.stderr.write(`[mcp ${tools.length} tool(s)]\n`);
    return tools.length > 0 ? { extraTools: tools } : {};
  } catch (error) {
    logger.warn("mcp_bridge_disabled", { message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`[mcp bridge disabled: ${error instanceof Error ? error.message : String(error)}]\n`);
    return {};
  }
}

/** Validate configuration files. */
async function validateConfig(configPath: string, _logger: ReturnType<typeof createLogger>): Promise<void> {
  const { resolve } = await import("node:path");
  const { readFile, stat } = await import("node:fs/promises");

  let modelsPath = configPath;
  if (!modelsPath.endsWith(".json")) {
    modelsPath = resolve(configPath, "models.json");
  }

  try {
    await stat(modelsPath);
  } catch {
    throw new Error(`Config file not found: ${modelsPath}`);
  }

  try {
    const raw = await readFile(modelsPath, "utf8");
    JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const file = await loadModelsFile(configPath);
  const errors: string[] = [];

  for (const [name, cfg] of Object.entries(file.providers ?? {})) {
    if (!cfg.baseUrl) errors.push(`Provider "${name}" missing baseUrl`);
    if (cfg.apiKey && cfg.apiKey.startsWith("$")) {
      const envVar = cfg.apiKey.slice(1);
      if (!process.env[envVar] && !cfg.apiKeyEnv) {
        errors.push(`Provider "${name}" references unset env var $${envVar}`);
      }
    }
    if (!cfg.models || cfg.models.length === 0) {
      errors.push(`Provider "${name}" has no models configured`);
    }
  }

  if (!file.defaultProvider && Object.keys(file.providers ?? {}).length > 0) {
    errors.push("No defaultProvider set");
  }

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`[error] ${e}\n`);
    throw new Error("Configuration validation failed");
  }

  process.stdout.write(`Configuration valid: ${modelsPath}\n`);
  process.stdout.write(`  Providers: ${Object.keys(file.providers ?? {}).join(", ") || "none"}\n`);
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
    resume: flags.resume,
    ...(flags.resumeSession ? { resumeSession: flags.resumeSession } : {}),
    policy: flags.readOnly ? { allowlistTools: READ_ONLY_TOOLS } : undefined,
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
    ...(flags.safetyMode ? { safetyMode: flags.safetyMode } : {}),
    ...(adapter ? { model: adapter } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    ...(await loadMcpExtraTools(flags.cwd, logger)),
  };

  const { session, manager } = await createAgentSession(sessionOptions);
  session.subscribe((ev) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: ev }) + "\n");
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let requestId = 0;

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
        case "close": {
          session.dispose();
          result = { ok: true };
          break;
        }
        default: {
          throw new Error(`Unknown method: ${method}`);
        }
      }

      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
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

  await new Promise(() => {});
}

export async function main() {
  const logger = createLogger(process.env["KERN_LOG"] === "debug" ? "debug" : "warn");
  const flags = parseArgs(process.argv.slice(2));
  const provider = flags.provider ?? process.env["KERN_PROVIDER"];
  let model = flags.model ?? process.env["KERN_MODEL"];
  const baseUrl = flags.baseUrl ?? process.env["KERN_BASE_URL"];
  const apiKey = flags.apiKey ?? process.env["KERN_API_KEY"];
  const file = await loadModelsFile(flags.cwd);
  const approvalHook: { current: ((prompt: string, meta?: { toolName: string }) => Promise<boolean | "session">) | null } = { current: null };

  if (flags.listModels) {
    const models = await discoverModels(file, { provider, baseUrl, apiKey });
    for (const m of models) {
      const mark = m.authenticated ? "" : " (no credentials)";
      process.stdout.write(`${m.provider}/${m.id}${mark} [${m.source}]\n`);
    }
    return;
  }

  if (flags.validateConfig) {
    await validateConfig(flags.config ?? flags.cwd, logger);
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
    resume: flags.resume,
    ...(flags.resumeSession ? { resumeSession: flags.resumeSession } : {}),
    policy: flags.readOnly ? { allowlistTools: READ_ONLY_TOOLS } : undefined,
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
    ...(flags.safetyMode ? { safetyMode: flags.safetyMode } : {}),
    requestApproval: (prompt: string, meta?: { toolName: string }) => (approvalHook.current ? approvalHook.current(prompt, meta) : askApproval(prompt)),
    ...(adapter ? { model: adapter } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    ...await loadMcpExtraTools(flags.cwd, logger),
  };
  const startSession = () => createAgentSession({ ...sessionOptions });
  const { session, manager } = await startSession();

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
      ...(flags.hadPrompt ? { initialPrompt: flags.prompt } : {}),
    });
    return;
  }

  const prompt = flags.prompt || "What is in README.md?";
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
  await session.prompt(prompt);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
