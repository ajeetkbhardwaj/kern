import type { EventBus } from "./event-bus.js";
import { ContextBuilder } from "./context-builder.js";
import { Compactor } from "./compaction.js";
import { BudgetTracker, type BudgetLimits } from "./budgets.js";
import { withRetry, DEFAULT_RETRY_CONFIG, type RetryConfig } from "./retry.js";
import type {
  Logger,
  ModelAdapter,
  ModelInfo,
  ChatMessage,
  ToolResultBlock,
  ToolCallBlock,
  ModelErrorKind,
  CompactionPhase,
  ThinkingLevel,
  TokenCounts,
} from "@kern/protocol";
import type { ContextUsage } from "./tokens.js";
import {
  nullLogger,
  AssistantMessageAssembler,
  getToolCalls,
  now,
  serializeError,
  KernError,
  redact,
  classifyModelError,
} from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry, type HookExecutor } from "@kern/tools";

export interface AgentRuntimeOptions {
  model: ModelAdapter;
  fallbackModels?: ModelAdapter[];
  tools: ToolRegistry;
  sessions: SessionManager;
  contextBuilder: ContextBuilder;
  events: EventBus;
  logger?: Logger;
  budgets?: Partial<BudgetLimits>;
  compactor?: Compactor | null;
  retry?: RetryConfig;
  defaultThinkingLevel?: ThinkingLevel;
  hookExecutor?: HookExecutor;
  /** Optional parent budget tracker so subagent token/cost usage shares the root wallet. */
  parentBudgetTracker?: BudgetTracker;
  /** Called when policy demands approval. Absent = deny. */
  requestApproval?: (prompt: string, meta?: import("@kern/tools").ApprovalMeta) => Promise<boolean | "session">;
}

export interface RunTurnOptions {
  signal?: AbortSignal;
  /** Queue this prompt after the current turn+tools complete (injects mid-run before the next model call). */
  steer?: boolean;
  /** Queue this prompt after the entire current run completes. */
  followUp?: boolean;
}

export class AgentRuntime {
  private model: ModelAdapter;
  private readonly fallbackModels: ModelAdapter[];
  private readonly tools: ToolRegistry;
  private readonly sessions: SessionManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly events: EventBus;
  private readonly logger: Logger;
  private readonly budgets: BudgetTracker;
  private readonly compactor: Compactor | null;
  private readonly retry: RetryConfig;
  private readonly hookExecutor?: HookExecutor;
  private readonly requestApproval?: (prompt: string, meta?: import("@kern/tools").ApprovalMeta) => Promise<boolean | "session">;
  private busy = false;
  private turn = 0;
  private lastUsage: ContextUsage | null = null;
  private disposed = false;
  private activeAbortController: AbortController | null = null;
  private steerQueue: string[] = [];
  private followUpQueue: Array<{ text: string; opts: RunTurnOptions }> = [];
  private thinkingLevel: ThinkingLevel;

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model;
    this.fallbackModels = options.fallbackModels ?? [];
    this.tools = options.tools;
    this.sessions = options.sessions;
    this.contextBuilder = options.contextBuilder;
    this.events = options.events;
    this.logger = options.logger ?? nullLogger;
    this.budgets = new BudgetTracker(options.budgets ?? {}, (event) => this.events.emit(event), options.parentBudgetTracker);
    this.budgets.restoreUsage(this.sessions.getUsageTotals());
    this.compactor = options.compactor === undefined ? new Compactor({ logger: this.logger }) : options.compactor;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
    this.hookExecutor = options.hookExecutor;
    this.thinkingLevel = options.defaultThinkingLevel ?? "medium";
    if (options.requestApproval !== undefined) this.requestApproval = options.requestApproval;
  }

  budgetTracker(): BudgetTracker {
    return this.budgets;
  }

  budgetUsage() {
    return this.budgets.usage();
  }

  budgetLimits(): BudgetLimits {
    return this.budgets.limitsSnapshot;
  }

  setBudgetLimits(limits: Partial<BudgetLimits>): BudgetLimits {
    return this.budgets.updateLimits(limits);
  }

  /** Token usage of the most recent context build (null before first turn). */
  contextUsage(): ContextUsage | null {
    return this.lastUsage;
  }

  /** Approval-mode + session-allow passthroughs (Shift+Tab cycling, dialogs). */
  approvalMode(): string {
    let mode = "ask";
    this.tools.configurePolicy((p) => {
      mode = p.approvalMode();
    });
    return mode;
  }

  setApprovalMode(mode: "ask" | "never" | "auto-allowlist"): boolean {
    return this.tools.configurePolicy((p) => p.setApprovalMode(mode));
  }

  allowToolForSession(toolName: string): boolean {
    return this.tools.configurePolicy((p) => p.allowForSession(toolName));
  }

  toolNames(): string[] {
    return this.tools.toolNames();
  }

  /** Direct tool call with user origin (shell mode). */
  callToolAsUser(name: string, args: unknown, signal?: AbortSignal) {
    return this.tools.callTool(name, args, { origin: "user", signal, requestApproval: this.requestApproval });
  }

  isBusy(): boolean {
    return this.busy;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  modelInfo(): ModelInfo {
    return this.model.info;
  }

  thinkingMode(): ThinkingLevel {
    return this.thinkingLevel;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.thinkingLevel = level;
    await this.sessions.appendModelChange(this.model.info.provider, this.model.info.modelId, level);
  }

  /** Switch adapter mid-session. Records a model_change entry. Fails while busy. */
  async setModel(adapter: ModelAdapter): Promise<void> {
    if (this.busy) throw new Error("Cannot switch model while a turn is running");
    this.model = adapter;
    await this.sessions.appendModelChange(adapter.info.provider, adapter.info.modelId, this.thinkingLevel);
    this.logger.info("model_changed", { provider: adapter.info.provider, model: adapter.info.modelId });
  }

  dispose(): void {
    this.disposed = true;
    this.steerQueue = [];
    this.followUpQueue = [];
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.events.clear();
  }

  async runUserTurn(userText: string, opts: RunTurnOptions = {}): Promise<void> {
    if (this.disposed) throw new Error("Session runtime has been disposed");
    if (this.busy) {
      if (opts.steer) {
        this.steerQueue.push(userText);
        return;
      }
      if (opts.followUp) {
        this.followUpQueue.push({ text: userText, opts });
        return;
      }
      throw new Error("A turn is already running; pass { steer: true } or { followUp: true } to queue it.");
    }
    this.busy = true;
    this.events.emit({ type: "agent_start" });
    this.turn = 0;
    this.budgets.startRun();
    this.activeAbortController = opts.signal ? null : new AbortController();
    const signal = opts.signal ?? this.activeAbortController?.signal;
    const callCounts = new Map<string, number>();
    let pendingQueuedFlush = false;
    let caughtError: unknown;
    const sessionId = this.sessions.sessionId ?? "unknown";
    try {
      if (this.hookExecutor) {
        const ctx = this.hookContext();
        const beforeRun = await this.hookExecutor.run("before_agent_run", ctx, { agentId: "kern", sessionId });
        if (!beforeRun.proceed) {
          throw new KernError("E_TOOL_DENIED", "Agent run blocked by before_agent_run hook");
        }
        const promptCheck = await this.hookExecutor.run("user_prompt_submit", ctx, { prompt: userText, sessionId });
        if (!promptCheck.proceed) {
          throw new KernError("E_TOOL_DENIED", "Prompt blocked by user_prompt_submit hook");
        }
      }
      await this.sessions.appendUserMessage(userText);
      await this.ensureCompactIfNeeded("before_prompt", signal);

      while (true) {
        this.throwIfAborted(signal);
        if (this.steerQueue.length > 0) {
          const steered = this.steerQueue.splice(0, this.steerQueue.length);
          for (const text of steered) {
            await this.sessions.appendUserMessage(text);
          }
        }
        this.budgets.beginTurn();
        this.turn += 1;
        this.events.emit({ type: "turn_start", turn: this.turn });
        if (this.hookExecutor) {
          await this.hookExecutor.runNotify("turn_start", this.hookContext(), { turn: this.turn, sessionId });
        }

        let ctx = await this.contextBuilder.build(this.sessions);
        this.lastUsage = ctx.usage;
        if (this.hookExecutor) {
          const llmGuard = await this.hookExecutor.run("before_llm_call", this.hookContext(), {
            messages: ctx.messages.map((m) => ({
              role: m.role,
              content: m.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("\n"),
            })),
            model: this.model.info.modelId,
          });
          if (!llmGuard.proceed) {
            throw new KernError("E_TOOL_DENIED", "LLM call blocked by before_llm_call hook");
          }
        }

        const buildRequest = (snap: typeof ctx) => ({
          systemPrompt: snap.systemPrompt,
          messages: snap.messages,
          tools: snap.tools,
          maxOutputTokens: this.model.info.maxOutputTokens,
          thinkingLevel: this.thinkingLevel,
          signal,
        });

        let streamed: { message: ChatMessage; usage: TokenCounts; cost: number };
        try {
          streamed = await this.streamWithRecoveryAndFallback(ctx, buildRequest, signal);
        } catch (err) {
          if (
            classifyError(err) === "context_length" &&
            this.compactor &&
            this.sessions.getActiveMessages().length > 0
          ) {
            this.logger.warn("context_length_overflow_compacting", { turn: this.turn, model: this.model.info.modelId });
            const compacted = await this.forceCompactForOverflow(ctx.usage.totalTokens, signal);
            if (!compacted) throw err;
            ctx = await this.contextBuilder.build(this.sessions);
            this.lastUsage = ctx.usage;
            streamed = await this.streamWithRecoveryAndFallback(ctx, buildRequest, signal);
          } else {
            throw err;
          }
        }

        const { message: assistant, usage: turnUsage, cost: turnCost } = streamed;
        this.throwIfAborted(signal);
        if (this.hookExecutor) {
          const responseText = assistant.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
          await this.hookExecutor.runNotify("after_llm_call", this.hookContext(), {
            response: responseText,
            model: this.model.info.modelId,
            tokens: { input: turnUsage.input, output: turnUsage.output },
          });
        }
        await this.sessions.appendAssistantMessage(assistant);
        if (turnUsage.input > 0 || turnUsage.output > 0 || turnCost > 0) {
          await this.sessions.appendUsage({
            provider: this.model.info.provider,
            model: this.model.info.modelId,
            usage: turnUsage,
            cost: turnCost,
            source: "turn",
          });
        }

        const toolCalls = getToolCalls(assistant);
        if (toolCalls.length === 0) {
          if (this.hookExecutor) {
            await this.hookExecutor.runNotify("turn_end", this.hookContext(), { turn: this.turn, sessionId });
          }
          if (this.steerQueue.length > 0) {
            continue;
          }
          this.events.emit({ type: "agent_end", reason: "final_response" });
          await this.ensureCompactIfNeeded("after_agent_end", signal);
          if (this.hookExecutor) {
            await this.hookExecutor.runNotify("after_agent_complete", this.hookContext(), {
              agentId: "kern",
              sessionId,
              success: true,
            });
          }
          this.events.emit({ type: "agent_settled" });
          pendingQueuedFlush = true;
          return;
        }

        const allReadOnly =
          toolCalls.length > 1 && toolCalls.every((call) => this.tools.isReadOnlyTool(call.name));

        if (allReadOnly) {
          for (let i = 0; i < toolCalls.length; i++) {
            this.throwIfAborted(signal);
            this.budgets.recordToolCall();
          }
          const toolMessages = await Promise.all(
            toolCalls.map((call) => this.executeTool(call, signal, callCounts)),
          );
          this.throwIfAborted(signal);
          for (const toolMsg of toolMessages) {
            await this.sessions.appendToolResult(toolMsg);
          }
        } else {
          for (const call of toolCalls) {
            this.throwIfAborted(signal);
            this.budgets.recordToolCall();
            const toolMsg = await this.executeTool(call, signal, callCounts);
            this.throwIfAborted(signal);
            await this.sessions.appendToolResult(toolMsg);
          }
        }
        if (this.hookExecutor) {
          await this.hookExecutor.runNotify("turn_end", this.hookContext(), { turn: this.turn, sessionId });
        }
      }
    } catch (error) {
      if (isCancelled(error, signal)) {
        await this.sessions.appendDiagnostic({
          severity: "warning",
          code: "E_CANCELLED",
          message: "Turn aborted by user",
        });
        this.events.emit({ type: "agent_end", reason: "aborted" });
        if (this.hookExecutor) {
          await this.hookExecutor.runNotify("after_agent_complete", this.hookContext(), {
            agentId: "kern",
            sessionId,
            success: false,
          });
        }
        this.events.emit({ type: "agent_settled" });
        pendingQueuedFlush = true;
        return;
      }
      const serialized = serializeError(error);
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("on_error", this.hookContext(), {
          error: error instanceof Error ? error : new Error(serialized.message),
          context: "runUserTurn",
        });
        await this.hookExecutor.runNotify("after_agent_complete", this.hookContext(), {
          agentId: "kern",
          sessionId,
          success: false,
        });
      }
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: serialized.code,
        message: serialized.message,
        details: serialized.details,
      });
      this.events.emit({ type: "agent_error", error: serialized });
      this.events.emit({ type: "agent_settled" });
      pendingQueuedFlush = true;
      caughtError = error;
    } finally {
      this.busy = false;
      this.activeAbortController = null;
    }
    if (pendingQueuedFlush) {
      await this.flushQueuedTurn();
    }
    if (caughtError !== undefined) {
      throw caughtError;
    }
  }

  private async flushQueuedTurn(): Promise<void> {
    if (this.steerQueue.length > 0) {
      const nextText = this.steerQueue.shift()!;
      await this.runUserTurn(nextText, { steer: true });
      return;
    }
    const next = this.followUpQueue.shift();
    if (!next) return;
    await this.runUserTurn(next.text, next.opts);
  }

  /**
   * Compact the active path on demand (e.g. `/compact [note]`).
   * Returns null — silently, not as an error — when there is nothing to
   * compact yet. Fails while a turn is running.
   */
  async compactNow(instructions?: string): Promise<{ summary: string; replacesThroughId: string } | null> {
    if (this.busy) throw new Error("Cannot compact while a turn is running");
    if (!this.compactor) throw new Error("Compaction is disabled for this session");
    if (!this.sessions.getActiveMessages().length) return null;
    const sessionId = this.sessions.sessionId ?? "unknown";
    this.events.emit({ type: "auto_compaction_start", phase: "before_prompt" });
    try {
      const beforeSnapshot = await this.contextBuilder.build(this.sessions);
      const tokensBefore: TokenCounts = { input: beforeSnapshot.usage.totalTokens, output: 0 };
      const { summary, replacesThroughId } = await this.compactor.compact(this.sessions, this.model, instructions);
      await this.sessions.appendCompaction(summary, replacesThroughId, { tokensBefore });
      this.events.emit({ type: "auto_compaction_end", summary, replacedThroughId: replacesThroughId });
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("after_compaction", this.hookContext(), {
          sessionId,
          summary,
          replacedThroughId: replacesThroughId,
        });
      }
      return { summary, replacesThroughId };
    } catch (error) {
      const serialized = serializeError(error);
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: "E_COMPACTION_FAILED",
        message: `Manual compaction failed: ${serialized.message}`,
        details: serialized.details,
      });
      this.events.emit({ type: "agent_error", error: serialized });
      throw error;
    }
  }

  private async ensureCompactIfNeeded(phase: CompactionPhase, signal?: AbortSignal): Promise<void> {
    if (!this.compactor) return;
    if (!this.sessions.getActiveMessages().length) return; // nothing yet — stay silent
    const snapshot = await this.contextBuilder.build(this.sessions);
    const decision = this.compactor.evaluate(snapshot, this.model.info.contextWindow);
    if (!decision.shouldCompact) return;
    const sessionId = this.sessions.sessionId ?? "unknown";
    if (this.hookExecutor) {
      const pre = await this.hookExecutor.run("pre_compact", this.hookContext(), {
        sessionId,
        tokenCount: decision.totalTokens,
        maxTokens: decision.budgetTokens,
      });
      if (!pre.proceed) {
        this.logger.info("compaction_vetoed_by_hook", { phase });
        return;
      }
    }
    this.events.emit({ type: "auto_compaction_start", phase });
    try {
      const tokensBefore: TokenCounts = { input: snapshot.usage.totalTokens, output: 0 };
      const { summary, replacesThroughId } = await this.compactor.compact(this.sessions, this.model, undefined, signal);
      this.throwIfAborted(signal);
      await this.sessions.appendCompaction(summary, replacesThroughId, { tokensBefore });
      this.events.emit({ type: "auto_compaction_end", summary, replacedThroughId: replacesThroughId });
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("after_compaction", this.hookContext(), {
          sessionId,
          summary,
          replacedThroughId: replacesThroughId,
        });
      }
    } catch (error) {
      if (isCancelled(error, signal)) throw error;
      const serialized = serializeError(error);
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: "E_COMPACTION_FAILED",
        message: `Compaction failed (${phase}): ${serialized.message}`,
        details: serialized.details,
      });
      // Fail open here: keep existing context rather than aborting the turn.
      this.logger.warn("compaction_failed", { phase, error: serialized.message });
    }
  }

  private async forceCompactForOverflow(totalTokens: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.compactor) return false;
    const sessionId = this.sessions.sessionId ?? "unknown";
    this.events.emit({ type: "auto_compaction_start", phase: "before_prompt" });
    try {
      const tokensBefore: TokenCounts = { input: totalTokens, output: 0 };
      const { summary, replacesThroughId } = await this.compactor.compact(this.sessions, this.model, undefined, signal);
      this.throwIfAborted(signal);
      await this.sessions.appendCompaction(summary, replacesThroughId, { tokensBefore });
      this.events.emit({ type: "auto_compaction_end", summary, replacedThroughId: replacesThroughId });
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("after_compaction", this.hookContext(), {
          sessionId,
          summary,
          replacedThroughId: replacesThroughId,
        });
      }
      return true;
    } catch (error) {
      if (isCancelled(error, signal)) throw error;
      const serialized = serializeError(error);
      this.logger.warn("overflow_compaction_failed", { error: serialized.message });
      return false;
    }
  }

  private hookContext() {
    return {
      sessionId: this.sessions.sessionId ?? undefined,
      timestamp: now(),
    };
  }

  private async streamWithRecoveryAndFallback(
    ctx: Awaited<ReturnType<ContextBuilder["build"]>>,
    buildRequest: (snap: typeof ctx) => Parameters<ModelAdapter["stream"]>[0],
    signal?: AbortSignal,
  ): Promise<{ message: ChatMessage; usage: TokenCounts; cost: number }> {
    const candidates: ModelAdapter[] = [this.model];
    for (const fb of this.fallbackModels) {
      if (!candidates.some((c) => c.info.provider === fb.info.provider && c.info.modelId === fb.info.modelId)) {
        candidates.push(fb);
      }
    }

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (candidate !== this.model) {
        const prev = this.model;
        this.model = candidate;
        await this.sessions.appendModelChange(candidate.info.provider, candidate.info.modelId, this.thinkingLevel);
        this.events.emit({
          type: "model_fallback",
          fromProvider: prev.info.provider,
          fromModel: prev.info.modelId,
          toProvider: candidate.info.provider,
          toModel: candidate.info.modelId,
          reason: lastError instanceof Error ? lastError.message : String(lastError),
        });
      }
      try {
        return await this.streamModel(buildRequest(ctx), signal);
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        if (kind === "cancelled" || kind === "context_length" || i === candidates.length - 1) {
          throw err;
        }
        this.logger.warn("model_fallback_triggered", {
          fromProvider: candidate.info.provider,
          fromModel: candidate.info.modelId,
          toProvider: candidates[i + 1]!.info.provider,
          toModel: candidates[i + 1]!.info.modelId,
          reason: kind,
        });
      }
    }
    throw lastError;
  }

  private estimateCost(usage: TokenCounts): number {
    const inRate = this.model.info.inputCostPer1M ?? 0;
    const outRate = this.model.info.outputCostPer1M ?? 0;
    return (usage.input * inRate + usage.output * outRate) / 1_000_000;
  }

  private async streamModel(
    request: Parameters<ModelAdapter["stream"]>[0],
    signal?: AbortSignal,
  ): Promise<{ message: ChatMessage; usage: TokenCounts; cost: number }> {
    return withRetry(
      async (attempt) => {
        const assembler = new AssistantMessageAssembler();
        const turnUsage: TokenCounts = { input: 0, output: 0 };
        let turnCost = 0;
        this.events.emit({ type: "message_start", message: { role: "assistant" } });
        try {
          for await (const event of this.model.stream(request)) {
            this.throwIfAborted(signal);
            switch (event.type) {
              case "text_delta":
                this.events.emit({ type: "text_delta", delta: event.delta });
                break;
              case "reasoning_delta":
                this.events.emit({ type: "reasoning_delta", delta: event.delta });
                break;
              case "usage": {
                const cost = this.estimateCost(event.usage);
                turnUsage.input += event.usage.input;
                turnUsage.output += event.usage.output;
                if (event.usage.cacheRead !== undefined) {
                  turnUsage.cacheRead = (turnUsage.cacheRead ?? 0) + event.usage.cacheRead;
                }
                if (event.usage.cacheWrite !== undefined) {
                  turnUsage.cacheWrite = (turnUsage.cacheWrite ?? 0) + event.usage.cacheWrite;
                }
                turnCost += cost;
                this.budgets.recordUsage(event.usage.input, event.usage.output, cost, this.model.info.modelId);
                break;
              }
              case "tool_call_complete":
              case "tool_call_delta":
              case "finished":
                break;
            }
            assembler.apply(event);
          }
          const message = assembler.finalize(now());
          message.model = this.model.info.modelId;
          if (turnCost > 0) message.cost = turnCost;
          this.events.emit({ type: "message_end", message });
          return { message, usage: turnUsage, cost: turnCost };
        } catch (error) {
          if (attempt < this.retry.maxAttempts && classifyError(error) !== "cancelled") {
            const reason = classifyError(error);
            void reason;
          }
          throw error;
        }
      },
      classifyError,
      this.retry,
      {
        onRetry: (attempt, kind, delayMs) => {
          this.events.emit({ type: "auto_retry_start", attempt, reason: kind, delayMs });
        },
        onSettled: (attempt, success, kind) => {
          if (!success) {
            this.events.emit({ type: "auto_retry_end", attempt, success, reason: kind ?? "unknown" });
            return;
          }
          if (attempt > 1) this.events.emit({ type: "auto_retry_end", attempt, success, reason: kind ?? "success" });
        },
      },
      signal,
    );
  }

  private async executeTool(
    call: ToolCallBlock,
    signal?: AbortSignal,
    callCounts?: Map<string, number>,
  ): Promise<ChatMessage> {
    this.events.emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
    });

    if (callCounts && !this.tools.allowsRepeatedCalls(call.name)) {
      const sig = `${call.name}:${stableSerialize(call.arguments)}`;
      const seen = (callCounts.get(sig) ?? 0) + 1;
      callCounts.set(sig, seen);
      if (seen >= 3) {
        const block: ToolResultBlock = {
          type: "tool_result",
          toolCallId: call.id,
          content: [{
            type: "text",
            text: `Blocked repeated identical call to "${call.name}" (${seen} times) to prevent an infinite loop. Change arguments or use a different approach.`,
          }],
          isError: true,
          details: { code: "E_TOOL_DENIED", repeatCount: seen },
        };
        this.events.emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          result: block,
        });
        return { role: "tool", content: [block], timestamp: now() };
      }
    }

    const effectiveSignal = signal ?? new AbortController().signal;
    const result = await this.tools.execute(call.name, call.arguments, effectiveSignal, {
      origin: "model",
      requestApproval: this.requestApproval,
      onArgRepair: (repairs) => {
        this.events.emit({
          type: "tool_input_repaired",
          toolCallId: call.id,
          toolName: call.name,
          repairs,
        });
      },
      onProgress: (delta) => {
        this.events.emit({
          type: "tool_execution_update",
          toolCallId: call.id,
          toolName: call.name,
          delta: redact(delta),
        });
      },
    });
    const safeContent = result.content.map((c) => ({ type: "text" as const, text: redact(c.text) }));
    const block: ToolResultBlock = {
      type: "tool_result",
      toolCallId: call.id,
      content: safeContent,
      isError: result.isError,
      details: result.details,
    };
    this.events.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError,
      result: block,
    });
    return { role: "tool", content: [block], timestamp: now() };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw KernError.cancelled();
  }
}

function classifyError(error: unknown): ModelErrorKind {
  if (error instanceof KernError && error.kind) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return classifyModelError(error);
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof KernError && error.code === "E_CANCELLED") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(rec[k])}`).join(",")}}`;
}
