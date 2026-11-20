import { nullLogger, textResult, type Logger, type ToolDefinition, type ToolResult } from "@kern/protocol";
import { discoverA2ACard, invokeA2AAgent } from "./a2a.js";
import {
  loadSubagentConfigs,
  removeSubagentConfig,
  saveSubagentConfig,
  setSubagentDisabledInFile,
  trustProjectSubagent,
  type LoadSubagentsOptions,
} from "./config.js";
import { runLocalSubagent } from "./runner.js";
import type {
  A2ASkillInfo,
  BackgroundDelegationStatus,
  DelegateExecutionContext,
  ResolvedSubagentDef,
  SubagentConfigEntry,
  SubagentFileFormat,
  SubagentIsolation,
  SubagentMode,
  SubagentRuntimeHost,
  SubagentStatus,
  SubagentToolRegistryLike,
} from "./types.js";

const MAX_DEPTH = 2;
const MAX_CONCURRENT_BACKGROUND = 4;

interface ManagedSubagent {
  def: ResolvedSubagentDef;
  status: SubagentStatus;
}

interface BackgroundDelegation {
  jobId: string;
  agent: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  turns: number;
  lastProgress?: string;
  output?: string;
  error?: string;
  exitReason?: "completed" | "failed" | "aborted";
  abortController: AbortController;
  promise: Promise<void>;
}

export interface SubagentManagerOptions extends LoadSubagentsOptions {
  cwd: string;
  logger?: Logger;
  maxConcurrentBackground?: number;
  /** Allow core orchestrator to propose `create-subagent` (always requires user permission). Defaults to true. */
  allowSelfCreatedSubagents?: boolean;
}

export class SubagentManager {
  private readonly cwd: string;
  private readonly logger: Logger;
  private readonly configOpts: LoadSubagentsOptions;
  private readonly maxConcurrent: number;
  private readonly allowSelfCreated: boolean;
  private readonly agents = new Map<string, ManagedSubagent>();
  private readonly backgroundJobs = new Map<string, BackgroundDelegation>();
  private registry: SubagentToolRegistryLike | null = null;
  private host: SubagentRuntimeHost | null = null;
  private registeredToolNames: string[] = [];
  private warnings: string[] = [];
  private bgSeq = 0;

  // Serial exclusive write lock (queues concurrent write-mode subagents cleanly)
  private writeLockTail: Promise<void> = Promise.resolve();

  constructor(options: SubagentManagerOptions) {
    this.cwd = options.cwd;
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrent = options.maxConcurrentBackground ?? MAX_CONCURRENT_BACKGROUND;
    this.allowSelfCreated = options.allowSelfCreatedSubagents !== false;
    this.configOpts = {
      userAgentsDir: options.userAgentsDir,
      userAgentsJsonPath: options.userAgentsJsonPath,
      trustFilePath: options.trustFilePath,
      allowProjectUntrusted: options.allowProjectUntrusted,
      envSource: options.envSource,
    };
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Bind parent ToolRegistry and runtime host so live team edits update schemas and <team> prompt context. */
  bindRuntime(registry: SubagentToolRegistryLike, host: SubagentRuntimeHost): void {
    this.registry = registry;
    this.host = host;
    this.syncRegistry();
  }

  /** Discover configured local specialists and remote A2A agents. Dormant when 0 exist. */
  async discover(): Promise<{ agents: SubagentStatus[]; warnings: string[] }> {
    const { defs, warnings } = await loadSubagentConfigs(this.cwd, this.configOpts);
    this.warnings = [...warnings];
    this.agents.clear();

    await Promise.all(defs.map((def) => this.registerResolvedDef(def)));
    this.syncRegistry();
    return { agents: this.listStatuses(), warnings: this.getWarnings() };
  }

  private async registerResolvedDef(def: ResolvedSubagentDef): Promise<SubagentStatus> {
    const base: SubagentStatus = {
      name: def.name,
      type: def.type,
      mode: def.mode,
      isolation: def.isolation,
      origin: def.origin,
      sourcePath: def.sourcePath,
      description: def.description,
      ...(def.model ? { model: def.model } : {}),
      ...(def.tools ? { tools: def.tools } : {}),
      ...(def.mcpServers ? { mcpServers: def.mcpServers } : {}),
      ...(def.url ? { url: def.url } : {}),
      state: "ready",
      trusted: def.trusted,
      disabled: def.disabled,
    };

    if (def.disabled) {
      base.state = "disabled";
      this.agents.set(def.name, { def, status: base });
      return base;
    }

    if (!def.trusted) {
      base.state = "untrusted";
      base.warning = def.trustReason;
      this.agents.set(def.name, { def, status: base });
      return base;
    }

    if (def.missingEnvVars.length > 0) {
      base.warning = `Missing env var(s): ${def.missingEnvVars.join(", ")}`;
    }

    if (def.type === "a2a" && def.url) {
      try {
        const { skills } = await discoverA2ACard(def.url, def.headers ?? {}, Math.min(def.timeoutMs, 5_000));
        if (skills.length > 0) base.skills = skills;
      } catch (err) {
        // Record reachable warning/error without crashing startup; user can inspect/test
        base.warning = err instanceof Error ? err.message : String(err);
      }
    }

    this.agents.set(def.name, { def, status: base });
    return base;
  }

  listStatuses(): SubagentStatus[] {
    return [...this.agents.values()].map((m) => m.status);
  }

  getStatus(name: string): SubagentStatus | undefined {
    return this.agents.get(name)?.status;
  }

  listBackgroundJobs(): BackgroundDelegationStatus[] {
    return [...this.backgroundJobs.values()].map((j) => ({
      jobId: j.jobId,
      agent: j.agent,
      task: j.task,
      running: j.endedAt === undefined,
      ...(j.exitReason ? { exitReason: j.exitReason } : {}),
      startedAt: j.startedAt,
      ...(j.endedAt !== undefined ? { endedAt: j.endedAt } : {}),
      turns: j.turns,
      ...(j.lastProgress ? { lastProgress: j.lastProgress } : {}),
      ...(j.output !== undefined ? { output: j.output } : {}),
      ...(j.error !== undefined ? { error: j.error } : {}),
    }));
  }

  /** Build the concise `<team>` system prompt section, or `""` when no specialists are active. */
  buildTeamPromptSection(): string {
    const active = this.listStatuses().filter((s) => s.state === "ready");
    if (active.length === 0) return "";
    const rows = active.map((s) => {
      const caps = [
        s.type === "a2a" ? "remote-a2a" : s.mode,
        s.model ? `model:${s.model}` : "",
        s.skills?.length ? `skills:[${s.skills.map((sk) => sk.name).join(", ")}]` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${s.name} (${caps}): ${s.description}`;
    });
    return [
      "<team>",
      "You are the root orchestrator. You can delegate focused subtasks to configured specialists below using `delegate`:",
      ...rows,
      "Use `delegate` with a concrete `task` and `expectedOutput`. Prefer `background: true` only for parallel read-only tasks.",
      "</team>",
    ].join("\n");
  }

  /** Sync delegation tools + `<team>` context section cleanly (`delegate*` registered only when active specialists exist). */
  syncRegistry(): void {
    const reg = this.registry;
    if (this.host?.contextBuilder) {
      this.host.contextBuilder.setDynamicSection("team", this.buildTeamPromptSection());
    }
    if (!reg) return;

    for (const prev of this.registeredToolNames) {
      reg.unregister(prev);
    }
    this.registeredToolNames = [];

    if (!this.host) return;

    if (this.allowSelfCreated && !reg.has("create-subagent")) {
      reg.register(this.createCreateSubagentTool() as unknown as ToolDefinition);
      this.registeredToolNames.push("create-subagent");
    }

    const activeNames = this.listStatuses()
      .filter((s) => s.state === "ready")
      .map((s) => s.name);

    if (activeNames.length === 0) {
      return;
    }

    const delegateTool = this.createDelegateTool({ depth: 0, ancestors: new Set<string>() });
    if (!reg.has("delegate")) {
      reg.register(delegateTool as unknown as ToolDefinition);
      this.registeredToolNames.push("delegate");
    }
    if (!reg.has("delegate-status")) {
      reg.register(this.createDelegateStatusTool() as unknown as ToolDefinition);
      this.registeredToolNames.push("delegate-status");
    }
    if (!reg.has("delegate-stop")) {
      reg.register(this.createDelegateStopTool() as unknown as ToolDefinition);
      this.registeredToolNames.push("delegate-stop");
    }
  }

  async addSubagent(
    entry: SubagentConfigEntry,
    opts: { scope?: "user" | "project" | "memory"; format?: SubagentFileFormat; templateComments?: boolean } = {},
  ): Promise<SubagentStatus> {
    const scope = opts.scope ?? "user";
    if (scope === "user" || scope === "project") {
      await saveSubagentConfig(scope, this.cwd, entry, {
        userAgentsDir: this.configOpts.userAgentsDir,
        userAgentsJsonPath: this.configOpts.userAgentsJsonPath,
        format: opts.format,
        templateComments: opts.templateComments,
      });
      if (scope === "project") {
        await trustProjectSubagent(this.cwd, entry.name, entry, this.configOpts.trustFilePath);
      }
      await this.discover();
      return this.getStatus(entry.name)!;
    }

    // In-memory only
    const def: ResolvedSubagentDef = {
      name: entry.name,
      description: entry.description,
      instruction: entry.instruction?.trim() || entry.description,
      type: entry.type ?? (entry.url ? "a2a" : "local"),
      mode: entry.mode === "write" ? "write" : "readonly",
      isolation:
        entry.type === "a2a"
          ? "readonly"
          : entry.isolation ?? (entry.mode === "write" ? "exclusive" : "readonly"),
      origin: "memory",
      tools: entry.tools,
      mcpServers: entry.mcpServers,
      model: entry.model,
      strictModel: entry.strictModel === true,
      thinkingLevel: entry.thinkingLevel,
      maxTurns: entry.maxTurns ?? 12,
      maxTotalToolCalls: entry.maxTotalToolCalls ?? 30,
      maxWallTimeMs: entry.maxWallTimeMs ?? 120_000,
      maxCost: entry.maxCost,
      allowDelegation: entry.allowDelegation === true,
      disabled: entry.disabled === true,
      trusted: true,
      missingEnvVars: [],
      url: entry.url,
      headers: entry.headers,
      timeoutMs: entry.timeoutMs ?? 60_000,
      rawEntry: entry,
    };
    const status = await this.registerResolvedDef(def);
    this.syncRegistry();
    return status;
  }

  async removeSubagent(name: string, opts: { scope?: "user" | "project" | "both" } = {}): Promise<boolean> {
    const hadMem = this.agents.delete(name);
    const scope = opts.scope ?? "both";
    let removedFile = false;
    if (scope === "user" || scope === "both") {
      if (await removeSubagentConfig("user", this.cwd, name, this.configOpts)) removedFile = true;
    }
    if (scope === "project" || scope === "both") {
      if (await removeSubagentConfig("project", this.cwd, name, this.configOpts)) removedFile = true;
    }
    this.syncRegistry();
    return hadMem || removedFile;
  }

  async toggleSubagent(name: string, disabled: boolean): Promise<SubagentStatus> {
    const existing = this.agents.get(name);
    if (!existing) throw new Error(`Unknown subagent: ${name}`);
    await setSubagentDisabledInFile(existing.def, disabled);
    const nextDef: ResolvedSubagentDef = { ...existing.def, disabled };
    const status = await this.registerResolvedDef(nextDef);
    this.syncRegistry();
    return status;
  }

  async trustSubagent(name: string): Promise<SubagentStatus> {
    const existing = this.agents.get(name);
    if (!existing) throw new Error(`Unknown subagent: ${name}`);
    await trustProjectSubagent(this.cwd, name, existing.def.rawEntry, this.configOpts.trustFilePath);
    const nextDef: ResolvedSubagentDef = { ...existing.def, trusted: true, trustReason: undefined };
    const status = await this.registerResolvedDef(nextDef);
    this.syncRegistry();
    return status;
  }

  private async withWriteLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.writeLockTail;
    this.writeLockTail = new Promise<void>((res) => {
      release = res;
    });

    try {
      await Promise.race([
        prev,
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("Aborted while waiting for workspace write lock"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Aborted while waiting for workspace write lock")), {
            once: true,
          });
        }),
      ]);
      return await fn();
    } finally {
      release();
    }
  }

  private async executeDelegation(
    params: {
      agent: string;
      task: string;
      expectedOutput?: string;
      context?: string;
      files?: string[];
      taskId?: string;
      background?: boolean;
    },
    execCtx: DelegateExecutionContext,
    signal: AbortSignal,
    emitProgress?: (delta: string) => void,
  ): Promise<ToolResult> {
    const host = this.host;
    if (!host) {
      return textResult("Subagent manager is not bound to an active runtime.", true, { code: "E_TOOL_FAILED" });
    }
    const managed = this.agents.get(params.agent);
    if (!managed) {
      const available = this.listStatuses().filter((s) => s.state === "ready").map((s) => s.name);
      return textResult(
        `Unknown subagent "${params.agent}". Active team members: ${available.join(", ") || "none"}.`,
        true,
        { code: "E_TOOL_INVALID_ARGS" },
      );
    }

    const { def, status } = managed;
    if (status.state !== "ready") {
      return textResult(
        `Subagent "${def.name}" is ${status.state}${status.warning ? `: ${status.warning}` : ""}.`,
        true,
        { code: "E_TOOL_DENIED" },
      );
    }

    if (execCtx.ancestors.has(def.name)) {
      return textResult(
        `Refusing recursive cycle: subagent "${def.name}" is already active in call chain.`,
        true,
        { code: "E_TOOL_DENIED" },
      );
    }
    if (execCtx.depth >= MAX_DEPTH) {
      return textResult(
        `Maximum delegation depth (${MAX_DEPTH}) exceeded.`,
        true,
        { code: "E_TOOL_DENIED" },
      );
    }

    // Remote A2A agent
    if (def.type === "a2a") {
      if (params.background) {
        return this.launchBackgroundDelegation(params, execCtx);
      }
      // Require approval before sending workspace context to an external A2A server when approval is enabled
      if (host.requestApproval && host.getSafetyMode() !== "autonomous") {
        const approved = await host.requestApproval(
          `Send task to external A2A agent "${def.name}" (${def.url})?`,
          { toolName: "delegate", origin: "model" },
        );
        if (!approved) {
          return textResult(`Denied sending task to remote A2A agent "${def.name}".`, true, {
            code: "E_TOOL_DENIED",
          });
        }
      }
      const promptParts = [params.task.trim()];
      if (params.expectedOutput?.trim()) promptParts.push(`Expected Output:\n${params.expectedOutput.trim()}`);
      if (params.context?.trim()) promptParts.push(`Context:\n${params.context.trim()}`);
      try {
        return await invokeA2AAgent({
          url: def.url!,
          headers: def.headers,
          timeoutMs: def.timeoutMs,
          prompt: promptParts.join("\n\n"),
          taskId: params.taskId,
          signal,
          onProgress: (line) => emitProgress?.(`[${def.name}] ${line}`),
        });
      } catch (err) {
        return textResult(
          `A2A agent "${def.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
          { code: "E_TOOL_FAILED" },
        );
      }
    }

    // Local subagent
    if (params.background) {
      return this.launchBackgroundDelegation(params, execCtx);
    }

    const extraTools: ToolDefinition[] = [];
    if (def.allowDelegation && execCtx.depth + 1 < MAX_DEPTH) {
      const nextAncestors = new Set(execCtx.ancestors);
      nextAncestors.add(def.name);
      extraTools.push(
        this.createDelegateTool({ depth: execCtx.depth + 1, ancestors: nextAncestors }) as unknown as ToolDefinition,
      );
    }

    const run = () =>
      runLocalSubagent({
        def,
        host,
        task: params.task,
        expectedOutput: params.expectedOutput,
        context: params.context,
        files: params.files,
        background: false,
        signal,
        onProgress: emitProgress,
        extraTools,
      });

    if (def.mode === "write" && def.isolation === "exclusive") {
      emitProgress?.(`[${def.name}] acquiring workspace write lock...`);
      return this.withWriteLock(signal, run);
    }
    return run();
  }

  private launchBackgroundDelegation(
    params: {
      agent: string;
      task: string;
      expectedOutput?: string;
      context?: string;
      files?: string[];
      taskId?: string;
    },
    execCtx: DelegateExecutionContext,
  ): ToolResult {
    const activeCount = [...this.backgroundJobs.values()].filter((j) => j.endedAt === undefined).length;
    if (activeCount >= this.maxConcurrent) {
      return textResult(
        `Background subagent concurrency limit reached (${activeCount}/${this.maxConcurrent}). Wait or stop an active job via delegate-status / delegate-stop.`,
        true,
        { code: "E_TOOL_DENIED" },
      );
    }

    const managed = this.agents.get(params.agent)!;
    const { def } = managed;
    if (def.mode === "write" && def.isolation === "exclusive") {
      // Allow queueing cleanly via withWriteLock, but note foreground is preferred if approvals are needed
    }

    const jobId = `sub_${++this.bgSeq}`;
    const ctrl = new AbortController();
    const job: BackgroundDelegation = {
      jobId,
      agent: def.name,
      task: params.task,
      startedAt: Date.now(),
      turns: 0,
      abortController: ctrl,
      promise: Promise.resolve(),
    };

    const runWork = async () => {
      try {
        let result: ToolResult;
        if (def.type === "a2a") {
          const promptParts = [params.task.trim()];
          if (params.expectedOutput?.trim()) promptParts.push(`Expected Output:\n${params.expectedOutput.trim()}`);
          if (params.context?.trim()) promptParts.push(`Context:\n${params.context.trim()}`);
          result = await invokeA2AAgent({
            url: def.url!,
            headers: def.headers,
            timeoutMs: def.timeoutMs,
            prompt: promptParts.join("\n\n"),
            taskId: params.taskId,
            signal: ctrl.signal,
            onProgress: (line) => {
              job.lastProgress = line;
            },
          });
        } else {
          const runLocal = () =>
            runLocalSubagent({
              def,
              host: this.host!,
              task: params.task,
              expectedOutput: params.expectedOutput,
              context: params.context,
              files: params.files,
              background: true,
              signal: ctrl.signal,
              onTurn: (t) => {
                job.turns = t;
              },
              onProgress: (line) => {
                job.lastProgress = line;
              },
            });
          result =
            def.mode === "write" && def.isolation === "exclusive"
              ? await this.withWriteLock(ctrl.signal, runLocal)
              : await runLocal();
        }
        job.endedAt = Date.now();
        const text = result.content.map((c) => c.text).join("\n");
        if (result.isError) {
          job.error = text;
          job.exitReason = ctrl.signal.aborted ? "aborted" : "failed";
        } else {
          job.output = text;
          job.exitReason = "completed";
        }
      } catch (err) {
        job.endedAt = Date.now();
        job.error = err instanceof Error ? err.message : String(err);
        job.exitReason = ctrl.signal.aborted ? "aborted" : "failed";
      }
    };

    job.promise = runWork();
    this.backgroundJobs.set(jobId, job);

    return {
      content: [
        {
          type: "text",
          text: `Started background delegation ${jobId} for "${def.name}" (${def.type === "a2a" ? "a2a" : def.isolation}).\nUse delegate-status(jobId="${jobId}") to check progress/results or delegate-stop(jobId="${jobId}") to cancel.`,
        },
      ],
      isError: false,
      details: { jobId, agent: def.name, background: true, execDepth: execCtx.depth },
    };
  }

  private createDelegateTool(execCtx: DelegateExecutionContext): ToolDefinition<{
    agent: string;
    task: string;
    expectedOutput?: string;
    context?: string;
    files?: string[];
    taskId?: string;
    background?: boolean;
  }> {
    return {
      name: "delegate",
      description:
        "Delegate a focused subtask to a configured specialist subagent or remote A2A team member. Returns the specialist's bounded report.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Configured team member name from <team>" },
          task: { type: "string", description: "Clear, self-contained task assignment" },
          expectedOutput: { type: "string", description: "Requested output format/fields (recommended)" },
          context: { type: "string", description: "Concise background context needed by the specialist" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Optional workspace file paths to highlight",
          },
          taskId: { type: "string", description: "Optional A2A taskId when continuing an input-required remote task" },
          background: {
            type: "boolean",
            default: false,
            description: "Run asynchronously in the background (best for parallel read-only tasks)",
          },
        },
        required: ["agent", "task"],
      },
      sideEffect: "read",
      annotations: { readOnlyHint: false, openWorldHint: true },
      allowRepeatedCalls: true,
      execute: async (args, ctx) => {
        if (!args.agent || !args.task) {
          return textResult("agent and task are required", true, { code: "E_TOOL_INVALID_ARGS" });
        }
        return this.executeDelegation(args, execCtx, ctx.signal, ctx.emitProgress);
      },
    };
  }

  private createDelegateStatusTool(): ToolDefinition<{ jobId?: string; waitMs?: number }> {
    return {
      name: "delegate-status",
      description: "Check status or collect completed output from background team delegations.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Background delegation ID (omit to list all)" },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: 30000,
            description: "Optional milliseconds to wait for completion before returning current status",
          },
        },
      },
      sideEffect: "read",
      annotations: { readOnlyHint: true },
      allowRepeatedCalls: true,
      execute: async (args, ctx) => {
        if (!args.jobId) {
          const jobs = this.listBackgroundJobs();
          if (jobs.length === 0) {
            return { content: [{ type: "text", text: "(no background subagent runs)" }], isError: false };
          }
          const lines = jobs.map(
            (j) =>
              `${j.jobId} [${j.running ? "running" : j.exitReason ?? "done"}] agent=${j.agent} turns=${j.turns}${j.lastProgress ? ` · ${j.lastProgress}` : ""}`,
          );
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false, details: { jobs } };
        }

        const job = this.backgroundJobs.get(args.jobId);
        if (!job) {
          return textResult(`Unknown background delegation job: ${args.jobId}`, true, { code: "E_TOOL_FAILED" });
        }

        if (job.endedAt === undefined && args.waitMs && args.waitMs > 0) {
          await Promise.race([
            job.promise,
            new Promise<void>((r) => setTimeout(r, args.waitMs)),
            new Promise<void>((r) => {
              if (ctx.signal.aborted) r();
              else ctx.signal.addEventListener("abort", () => r(), { once: true });
            }),
          ]);
        }

        const running = job.endedAt === undefined;
        const lines = [
          `Job ${job.jobId} (${job.agent}): ${running ? "running" : job.exitReason ?? "done"} · turns=${job.turns}`,
        ];
        if (job.lastProgress) lines.push(`Progress: ${job.lastProgress}`);
        if (job.output) lines.push(`\nOutput:\n${job.output}`);
        if (job.error) lines.push(`\nError:\n${job.error}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: !running && job.exitReason === "failed",
          details: { jobId: job.jobId, agent: job.agent, running, exitReason: job.exitReason, turns: job.turns },
        };
      },
    };
  }

  private createDelegateStopTool(): ToolDefinition<{ jobId: string }> {
    return {
      name: "delegate-stop",
      description: "Abort a running background team delegation job.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Background delegation ID to stop" },
        },
        required: ["jobId"],
      },
      sideEffect: "execute",
      annotations: { destructiveHint: false },
      execute: async (args) => {
        const job = this.backgroundJobs.get(args.jobId);
        if (!job) {
          return textResult(`Unknown background delegation job: ${args.jobId}`, true, { code: "E_TOOL_FAILED" });
        }
        if (job.endedAt !== undefined) {
          return {
            content: [{ type: "text", text: `Job ${args.jobId} already finished (${job.exitReason}).` }],
            isError: false,
          };
        }
        job.abortController.abort();
        await Promise.race([job.promise, new Promise<void>((r) => setTimeout(r, 1_500))]);
        return {
          content: [{ type: "text", text: `Stopped background delegation ${args.jobId} (${job.agent}).` }],
          isError: false,
        };
      },
    };
  }

  private createCreateSubagentTool(): ToolDefinition<{
    name: string;
    description: string;
    instruction: string;
    mode?: SubagentMode;
    isolation?: SubagentIsolation;
    tools?: string[];
    mcpServers?: string[];
    model?: string;
    maxTurns?: number;
    maxTotalToolCalls?: number;
    maxCost?: number;
    scope?: "memory" | "project" | "user";
    format?: SubagentFileFormat;
    reason?: string;
    task?: string;
    expectedOutput?: string;
    context?: string;
    files?: string[];
    background?: boolean;
  }> {
    return {
      name: "create-subagent",
      description:
        "Propose creating a specialized subagent (and optionally running an initial task) ONLY when a complex task genuinely needs isolated specialist expertise. Always asks the user for explicit permission first.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short unique name ([A-Za-z0-9_.-]{1,64})" },
          description: { type: "string", description: "Concise routing summary of the specialist role" },
          instruction: { type: "string", description: "Focused system instruction for the specialist" },
          mode: { type: "string", enum: ["readonly", "write"], default: "readonly" },
          isolation: { type: "string", enum: ["readonly", "exclusive", "worktree"] },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Allowed built-in tools (defaults to minimal role set)",
          },
          mcpServers: {
            type: "array",
            items: { type: "string" },
            description: "Optional live parent MCP server names to share",
          },
          model: { type: "string", description: "Optional provider/modelId override" },
          maxTurns: { type: "integer", minimum: 1, maximum: 50, default: 12 },
          maxTotalToolCalls: { type: "integer", minimum: 1, maximum: 200, default: 30 },
          maxCost: { type: "number", minimum: 0, description: "Optional USD cost cap" },
          scope: {
            type: "string",
            enum: ["memory", "project", "user"],
            default: "memory",
            description: "memory (this session only), project (.kern/agents/), or user (~/.kern/agents/)",
          },
          format: { type: "string", enum: ["md", "yaml", "json"], default: "md" },
          reason: { type: "string", description: "Why this difficult task benefits from creating this subagent" },
          task: { type: "string", description: "Optional initial task to immediately delegate once user approves" },
          expectedOutput: { type: "string", description: "Expected output format if task is provided" },
          context: { type: "string", description: "Background context for initial task" },
          files: { type: "array", items: { type: "string" }, description: "Relevant workspace files for initial task" },
          background: { type: "boolean", default: false },
        },
        required: ["name", "description", "instruction"],
      },
      sideEffect: "write",
      annotations: { destructiveHint: false, readOnlyHint: false },
      execute: async (args, ctx) => {
        const host = this.host;
        if (!host) {
          return textResult("Subagent manager is not bound to an active runtime.", true, { code: "E_TOOL_FAILED" });
        }
        const name = args.name?.trim();
        const description = args.description?.trim();
        const instruction = args.instruction?.trim();
        if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !description || !instruction) {
          return textResult("Invalid subagent proposal: valid name ([A-Za-z0-9_.-]), description, and instruction are required.", true, {
            code: "E_TOOL_INVALID_ARGS",
          });
        }

        const mode: SubagentMode = args.mode === "write" ? "write" : "readonly";
        const isolation: SubagentIsolation =
          mode === "readonly"
            ? "readonly"
            : args.isolation === "worktree" || args.isolation === "exclusive"
              ? args.isolation
              : "exclusive";
        const scope: "memory" | "project" | "user" =
          args.scope === "project" || args.scope === "user" ? args.scope : "memory";
        const format: SubagentFileFormat =
          args.format === "yaml" || args.format === "json" ? args.format : "md";

        const promptLines = [
          `Allow creating${args.task ? " & running" : ""} subagent "${name}"?`,
          `Scope: ${scope === "memory" ? "memory (this session only)" : `${scope} (saves .${format} file)`}`,
          `Capability: mode=${mode}, isolation=${isolation}`,
          `Tools: ${args.tools?.length ? args.tools.join(", ") : `${mode} defaults`}${args.mcpServers?.length ? ` | MCP: ${args.mcpServers.join(", ")}` : ""}${args.model ? ` | Model: ${args.model}` : ""}`,
          ...(args.reason?.trim() ? [`Reason: ${args.reason.trim()}`] : []),
          `Description: ${description}`,
          `Instruction: ${instruction.length > 220 ? `${instruction.slice(0, 217)}...` : instruction}`,
          ...(args.task?.trim()
            ? [`Initial Task: ${args.task.trim().length > 180 ? `${args.task.trim().slice(0, 177)}...` : args.task.trim()}`]
            : []),
        ];
        const approvalPrompt = promptLines.join("\n");

        // Fail-closed mandatory permission gate (even in autonomous/never mode)
        const approver = host.requestApproval ?? ctx.requestApproval;
        let permitted = false;
        if (approver) {
          const decision = await approver(approvalPrompt, { toolName: "create-subagent", origin: "model" });
          permitted = decision === true || decision === "session";
        } else if (host.askUser ?? ctx.askUser) {
          const asker = (host.askUser ?? ctx.askUser)!;
          const answer = await asker({
            question: approvalPrompt,
            options: ["Approve", "Deny"],
            allowCustom: false,
          });
          permitted = answer?.toLowerCase() === "approve";
        } else {
          return textResult(
            `Permission required to create subagent "${name}", but no interactive approval handler is available (headless fail-closed).`,
            true,
            { code: "E_TOOL_DENIED", subagent: name },
          );
        }

        if (!permitted) {
          return textResult(
            `Permission denied by user: declined creating/running proposed subagent "${name}". Handle the task directly without creating this subagent.`,
            true,
            { code: "E_TOOL_DENIED", subagent: name },
          );
        }

        const entry: SubagentConfigEntry = {
          name,
          type: "local",
          description,
          instruction,
          mode,
          isolation,
          ...(args.tools?.length ? { tools: args.tools } : {}),
          ...(args.mcpServers?.length ? { mcpServers: args.mcpServers } : {}),
          ...(args.model?.trim() ? { model: args.model.trim() } : {}),
          ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
          ...(args.maxTotalToolCalls !== undefined ? { maxTotalToolCalls: args.maxTotalToolCalls } : {}),
          ...(args.maxCost !== undefined ? { maxCost: args.maxCost } : {}),
        };

        const status = await this.addSubagent(entry, { scope, format });
        ctx.emitProgress?.(`[create-subagent] approved & registered "${status.name}" (${scope})`);

        if (args.task?.trim()) {
          const runResult = await this.executeDelegation(
            {
              agent: status.name,
              task: args.task.trim(),
              expectedOutput: args.expectedOutput,
              context: args.context,
              files: args.files,
              background: args.background,
            },
            { depth: 0, ancestors: new Set<string>() },
            ctx.signal,
            ctx.emitProgress,
          );
          return {
            content: [
              {
                type: "text",
                text: `[created subagent="${status.name}" scope=${scope}${status.sourcePath ? ` file=${status.sourcePath}` : ""}]\n${runResult.content.map((c) => c.text).join("\n")}`,
              },
            ],
            isError: runResult.isError,
            details: {
              created: status,
              ...(runResult.details ?? {}),
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Created & activated subagent "${status.name}" (scope=${scope}, mode=${status.mode}, isolation=${status.isolation}${status.sourcePath ? `, file=${status.sourcePath}` : ""}). You can now call \`delegate\` with agent="${status.name}".`,
            },
          ],
          isError: false,
          details: { created: status },
        };
      },
    };
  }

  async dispose(): Promise<void> {
    const active = [...this.backgroundJobs.values()].filter((j) => j.endedAt === undefined);
    for (const j of active) {
      j.abortController.abort();
    }
    if (active.length > 0) {
      await Promise.race([
        Promise.allSettled(active.map((j) => j.promise)),
        new Promise<void>((r) => setTimeout(r, 1_500)),
      ]);
    }
    this.backgroundJobs.clear();
  }
}
