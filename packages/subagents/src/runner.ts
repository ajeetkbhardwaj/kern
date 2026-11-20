import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentRuntime,
  ContextBuilder,
  EventBus,
} from "@kern/agent-core";
import { createAdapterFor, loadModelsFile } from "@kern/model";
import {
  boundText,
  nullLogger,
  redact,
  textResult,
  type ModelAdapter,
  type ToolDefinition,
  type ToolResult,
} from "@kern/protocol";
import { SessionManager, SessionStore } from "@kern/session-store";
import {
  BackgroundJobManager,
  DEFAULT_SAFETY_POLICY_CONFIG,
  DefaultPolicy,
  ToolRegistry,
  createBashStatusTool,
  createBashStopTool,
  createBashTool,
  createEditTool,
  createFindTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  createGrepTool,
  createReadTool,
  createWebFetchTool,
  createWriteTool,
  safeResolveSync,
} from "@kern/tools";
import type {
  ResolvedSubagentDef,
  SubagentRuntimeHost,
} from "./types.js";

const execFileAsync = promisify(execFile);

const READONLY_BUILTIN_NAMES = new Set([
  "read",
  "grep",
  "find",
  "git-status",
  "git-diff",
  "git-log",
  "web-fetch",
]);

const WRITE_BUILTIN_NAMES = new Set([
  "write",
  "edit",
  "bash",
  "bash-status",
  "bash-stop",
]);

async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function createTempWorktree(cwd: string): Promise<{ worktreeDir: string; cleanup: () => Promise<void> }> {
  const repoRoot = await gitTopLevel(cwd);
  if (!repoRoot) {
    throw new Error(`Worktree isolation requires a git repository (not found for ${cwd})`);
  }
  const baseTmp = mkdtempSync(join(tmpdir(), "kern-worktree-"));
  const worktreeDir = join(baseTmp, "wt");
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
      cwd: repoRoot,
      timeout: 15_000,
    });
  } catch (err) {
    rmSync(baseTmp, { recursive: true, force: true });
    throw new Error(`Failed creating git worktree: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    worktreeDir,
    cleanup: async () => {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
          cwd: repoRoot,
          timeout: 10_000,
        });
      } catch {
        /* ignore cleanup errors */
      }
      rmSync(baseTmp, { recursive: true, force: true });
    },
  };
}

async function collectWorktreeSummary(worktreeDir: string): Promise<string> {
  try {
    const [{ stdout: statusOut }, { stdout: diffOut }] = await Promise.all([
      execFileAsync("git", ["status", "--short"], { cwd: worktreeDir, timeout: 5_000 }),
      execFileAsync("git", ["diff", "--stat"], { cwd: worktreeDir, timeout: 5_000 }),
    ]);
    const parts: string[] = [];
    if (statusOut.trim()) parts.push(`git status --short:\n${statusOut.trim()}`);
    if (diffOut.trim()) parts.push(`git diff --stat:\n${diffOut.trim()}`);
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

async function resolveSpecialistModel(
  def: ResolvedSubagentDef,
  host: SubagentRuntimeHost,
): Promise<{ adapter: ModelAdapter; warning?: string }> {
  const parentModel = host.getModel();
  if (!def.model) return { adapter: parentModel };

  const spec = def.model.trim();
  const slash = spec.indexOf("/");
  const provider = slash > 0 ? spec.slice(0, slash) : parentModel.info.provider;
  const modelId = slash > 0 ? spec.slice(slash + 1) : spec;
  if (!modelId) return { adapter: parentModel };

  try {
    const file = await loadModelsFile(host.cwd);
    const adapter = await createAdapterFor(file, provider, modelId, {}, host.logger ?? nullLogger);
    return { adapter };
  } catch (err) {
    const msg = `Model "${spec}" unavailable for subagent "${def.name}" (${err instanceof Error ? err.message : String(err)})`;
    if (def.strictModel) {
      throw new Error(msg);
    }
    return { adapter: parentModel, warning: `${msg}; fell back to ${parentModel.info.provider}/${parentModel.info.modelId}` };
  }
}

export interface RunLocalSubagentOptions {
  def: ResolvedSubagentDef;
  host: SubagentRuntimeHost;
  task: string;
  expectedOutput?: string;
  context?: string;
  files?: string[];
  background: boolean;
  signal: AbortSignal;
  onProgress?: (delta: string) => void;
  onTurn?: (turn: number) => void;
  extraTools?: ToolDefinition[];
}

export async function runLocalSubagent(opts: RunLocalSubagentOptions): Promise<ToolResult> {
  const { def, host, background, signal } = opts;
  const logger = host.logger ?? nullLogger;

  if (signal.aborted) {
    return textResult(`Subagent "${def.name}" aborted before start`, true, { code: "E_CANCELLED" });
  }

  let runCwd = host.cwd;
  let cleanupWorktree: (() => Promise<void>) | null = null;
  if (def.isolation === "worktree" && def.mode === "write") {
    const wt = await createTempWorktree(host.cwd);
    runCwd = wt.worktreeDir;
    cleanupWorktree = wt.cleanup;
    opts.onProgress?.(`[${def.name}] created isolated git worktree`);
  }

  const tempSessionRoot = mkdtempSync(join(tmpdir(), "kern-subsession-"));
  const backgroundJobs = new BackgroundJobManager();
  let childRuntime: AgentRuntime | null = null;

  try {
    const { adapter: model, warning: modelWarning } = await resolveSpecialistModel(def, host);
    if (modelWarning) {
      logger.warn("subagent_model_fallback", { subagent: def.name, warning: modelWarning });
      opts.onProgress?.(`[${def.name}] ${modelWarning}`);
    }

    const store = new SessionStore({ storageRoot: tempSessionRoot, logger });
    const sessionManager = await SessionManager.create(store, runCwd);

    const policy = new DefaultPolicy(host.getPolicyConfig(), {
      ...DEFAULT_SAFETY_POLICY_CONFIG,
      mode: host.getSafetyMode(),
    });
    const permRules = host.getPermissionRules?.();
    if (permRules) policy.extendPermissionRules(permRules);

    const tools = new ToolRegistry({
      workspaceRoot: runCwd,
      policy,
      maxToolMs: Math.min(120_000, def.maxWallTimeMs),
      // Background subagents never block on interactive TTY/Web approval modals
      requestApproval: background
        ? undefined
        : host.requestApproval
          ? (prompt, meta) => host.requestApproval!(`[subagent:${def.name}] ${prompt}`, meta)
          : undefined,
      sessionId: sessionManager.sessionId ?? undefined,
    });

    const builtinFactories: Record<string, () => ToolDefinition> = {
      read: () => createReadTool(runCwd) as unknown as ToolDefinition,
      grep: () => createGrepTool(runCwd) as unknown as ToolDefinition,
      find: () => createFindTool(runCwd) as unknown as ToolDefinition,
      "git-status": () => createGitStatusTool(runCwd) as unknown as ToolDefinition,
      "git-diff": () => createGitDiffTool(runCwd) as unknown as ToolDefinition,
      "git-log": () => createGitLogTool(runCwd) as unknown as ToolDefinition,
      "web-fetch": () => createWebFetchTool() as unknown as ToolDefinition,
      write: () => createWriteTool(runCwd) as unknown as ToolDefinition,
      edit: () => createEditTool(runCwd) as unknown as ToolDefinition,
      bash: () => createBashTool({ root: runCwd, backgroundManager: backgroundJobs }) as unknown as ToolDefinition,
      "bash-status": () => createBashStatusTool(backgroundJobs) as unknown as ToolDefinition,
      "bash-stop": () => createBashStopTool(backgroundJobs) as unknown as ToolDefinition,
    };

    const allowedBuiltinNames = def.tools
      ? def.tools.filter((name) => {
          if (def.mode === "readonly" && WRITE_BUILTIN_NAMES.has(name)) return false;
          return READONLY_BUILTIN_NAMES.has(name) || (def.mode === "write" && WRITE_BUILTIN_NAMES.has(name));
        })
      : def.mode === "readonly"
        ? [...READONLY_BUILTIN_NAMES].filter((n) => n !== "web-fetch")
        : [...READONLY_BUILTIN_NAMES, ...WRITE_BUILTIN_NAMES];

    for (const toolName of allowedBuiltinNames) {
      const factory = builtinFactories[toolName];
      if (factory) tools.register(factory());
    }

    // Borrow live parent MCP tools cleanly without spawning duplicate processes
    if (def.mcpServers && def.mcpServers.length > 0 && host.connects) {
      const mcpTools = host.connects.getToolDefinitions({
        serverNames: def.mcpServers,
        readOnlyOnly: def.mode === "readonly",
      });
      for (const mt of mcpTools) {
        if (!tools.has(mt.name)) tools.register(mt);
      }
    }

    for (const extra of opts.extraTools ?? []) {
      if (!tools.has(extra.name)) tools.register(extra);
    }

    const systemPrompt = [
      `You are "${def.name}", a specialist team member delegated a focused task by the root orchestrator.`,
      `Mode: ${def.mode} (${def.isolation} workspace isolation). Work strictly within your role and report factual results.`,
      def.instruction,
    ].join("\n\n");

    const contextBuilder = new ContextBuilder({
      baseSystemPrompt: systemPrompt,
      toolRegistry: tools,
      logger,
    });

    const events = new EventBus(logger);
    let finalAssistantText = "";
    let streamedText = "";
    let turnsRun = 0;

    events.subscribe((ev) => {
      if (ev.type === "turn_start") {
        turnsRun = ev.turn;
        opts.onTurn?.(ev.turn);
        opts.onProgress?.(`[${def.name}] turn ${ev.turn}/${def.maxTurns}`);
      } else if (ev.type === "tool_execution_start") {
        opts.onProgress?.(`[${def.name}] -> ${ev.toolName}`);
      } else if (ev.type === "tool_execution_end" && ev.isError) {
        opts.onProgress?.(`[${def.name}] ! ${ev.toolName} error`);
      } else if (ev.type === "text_delta") {
        streamedText += ev.delta;
      } else if (ev.type === "message_end" && ev.message.role === "assistant") {
        const text = ev.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) finalAssistantText = text;
      }
    });

    childRuntime = new AgentRuntime({
      model,
      tools,
      sessions: sessionManager,
      contextBuilder,
      events,
      logger,
      parentBudgetTracker: host.getParentBudget(),
      budgets: {
        maxCost: def.maxCost ?? 0,
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxTotalTokens: 0,
        maxTurns: def.maxTurns,
        maxTotalToolCalls: def.maxTotalToolCalls,
        maxWallTimeMs: def.maxWallTimeMs,
      },
      defaultThinkingLevel: def.thinkingLevel ?? host.getThinkingLevel(),
      requestApproval: background ? undefined : host.requestApproval,
    });

    const promptSections: string[] = [`Task:\n${opts.task.trim()}`];
    if (opts.expectedOutput?.trim()) {
      promptSections.push(`Expected Output:\n${opts.expectedOutput.trim()}`);
    }
    if (opts.context?.trim()) {
      promptSections.push(`Context from Orchestrator:\n${opts.context.trim()}`);
    }
    if (opts.files && opts.files.length > 0) {
      const safeFiles: string[] = [];
      for (const f of opts.files.slice(0, 25)) {
        try {
          safeResolveSync(runCwd, f);
          safeFiles.push(f);
        } catch {
          /* ignore out-of-root paths */
        }
      }
      if (safeFiles.length > 0) {
        promptSections.push(`Focus Files:\n${safeFiles.map((f) => `- ${f}`).join("\n")}`);
      }
    }

    await childRuntime.runUserTurn(promptSections.join("\n\n"), { signal });

    if (signal.aborted) {
      return textResult(`Subagent "${def.name}" aborted.`, true, { code: "E_CANCELLED" });
    }

    // Check latest diagnostic or assistant output
    const entries = sessionManager.getActivePath();
    const lastDiag = [...entries].reverse().find((e) => e.type === "diagnostic" && e.severity === "error");
    if (lastDiag && lastDiag.type === "diagnostic") {
      return textResult(
        `Subagent "${def.name}" failed (${lastDiag.code}): ${lastDiag.message}`,
        true,
        { code: lastDiag.code, subagent: def.name, turns: turnsRun },
      );
    }

    let report = (finalAssistantText || streamedText).trim();
    if (!report) {
      const messages = sessionManager.getActiveMessages();
      const lastAssist = [...messages].reverse().find((e) => e.message.role === "assistant")?.message;
      if (lastAssist) {
        report = lastAssist.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
      }
    }

    if (cleanupWorktree) {
      const wtSummary = await collectWorktreeSummary(runCwd);
      if (wtSummary) {
        report = report ? `${report}\n\n<worktree_changes>\n${wtSummary}\n</worktree_changes>` : wtSummary;
      }
    }

    const usage = childRuntime.budgetUsage();
    const header = `[subagent=${def.name} model=${model.info.provider}/${model.info.modelId} turns=${turnsRun} tokens=${usage.inputTokens + usage.outputTokens}]`;
    const body = report || "(subagent completed without text output)";
    const bounded = boundText(redact(`${header}\n${body}`));

    return {
      content: [{ type: "text", text: bounded.text }],
      isError: false,
      details: {
        subagent: def.name,
        model: `${model.info.provider}/${model.info.modelId}`,
        turns: turnsRun,
        usage,
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    };
  } catch (err) {
    if (signal.aborted) {
      return textResult(`Subagent "${def.name}" aborted.`, true, { code: "E_CANCELLED" });
    }
    return textResult(
      `Subagent "${def.name}" error: ${err instanceof Error ? err.message : String(err)}`,
      true,
      { code: "E_TOOL_FAILED", subagent: def.name },
    );
  } finally {
    childRuntime?.dispose();
    await backgroundJobs.dispose().catch(() => {});
    if (cleanupWorktree) await cleanupWorktree().catch(() => {});
    rmSync(tempSessionRoot, { recursive: true, force: true });
  }
}
