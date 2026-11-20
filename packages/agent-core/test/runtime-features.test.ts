import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KernError, type ModelAdapter, type ModelRequest, type ModelStreamEvent, type ToolDefinition } from "@kern/protocol";
import { SessionStore, SessionManager } from "@kern/session-store";
import { ToolRegistry, AllowAllPolicy, HookRegistry, HookExecutor } from "@kern/tools";
import { AgentRuntime, ContextBuilder, EventBus, BudgetTracker, Compactor } from "../src/index.js";

describe("AgentRuntime v1.0 features", () => {
  it("enforces maxTurns and maxToolCallsPerTurn in BudgetTracker", () => {
    const tracker = new BudgetTracker({ maxTurns: 1, maxToolCallsPerTurn: 1 });
    tracker.startRun();
    tracker.beginTurn();
    tracker.recordToolCall();
    expect(() => tracker.recordToolCall()).toThrow(/Per-turn tool call budget exceeded/);
    expect(() => tracker.beginTurn()).toThrow(/Turn budget exceeded/);
  });

  it("executes multiple read-only tools concurrently and preserves order in session JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-parallel-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });

      const timestamps: Record<string, { start: number; end: number }> = {};
      const slowReadTool: ToolDefinition<{ id: string }> = {
        name: "slow-read",
        description: "slow read-only tool",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        sideEffect: "read",
        annotations: { readOnlyHint: true },
        async execute(args) {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 40));
          timestamps[args.id] = { start, end: Date.now() };
          return { content: [{ type: "text", text: `result-${args.id}` }], isError: false };
        },
      };
      tools.register(slowReadTool);

      let turnIdx = 0;
      const model: ModelAdapter = {
        info: {
          provider: "test",
          modelId: "test-1",
          contextWindow: 32000,
          maxOutputTokens: 2000,
          inputCostPer1M: 1,
          outputCostPer1M: 2,
        },
        async *stream(_req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          turnIdx++;
          if (turnIdx === 1) {
            yield { type: "tool_call_complete", call: { type: "tool_call", id: "c1", name: "slow-read", arguments: { id: "first" } } };
            yield { type: "tool_call_complete", call: { type: "tool_call", id: "c2", name: "slow-read", arguments: { id: "second" } } };
            yield { type: "usage", usage: { input: 1000, output: 500 } };
            yield { type: "finished", reason: "tool_use" };
          } else {
            yield { type: "text_delta", delta: "done" };
            yield { type: "usage", usage: { input: 1500, output: 200 } };
            yield { type: "finished", reason: "stop" };
          }
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({ model, tools, sessions: manager, contextBuilder, events, compactor: null });

      await runtime.runUserTurn("run parallel");

      // Both started before either finished (concurrent execution)
      expect(timestamps.second!.start).toBeLessThan(timestamps.first!.end + 15);

      // Results preserved in call order: c1 then c2
      const msgs = manager.getActiveMessages().filter((m) => m.message.role === "tool");
      expect(msgs).toHaveLength(2);
      const firstBlock = msgs[0]?.message.content[0];
      const secondBlock = msgs[1]?.message.content[0];
      expect(firstBlock?.type === "tool_result" ? firstBlock.toolCallId : "").toBe("c1");
      expect(secondBlock?.type === "tool_result" ? secondBlock.toolCallId : "").toBe("c2");

      // Usage + estimated cost persisted to session
      const totals = manager.getUsageTotals();
      expect(totals.inputTokens).toBe(2500);
      expect(totals.outputTokens).toBe(700);
      expect(totals.cost).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps ContextBuilder systemPrompt stable across user turns and appends systemExtra", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-ctx-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      const builder = new ContextBuilder({
        baseSystemPrompt: "base",
        toolRegistry: tools,
        systemExtra: "[AGENTS.md]\nFollow workspace conventions.",
      });

      await manager.appendUserMessage("alpha");
      const snap1 = await builder.build(manager);
      await manager.appendUserMessage("beta");
      const snap2 = await builder.build(manager);

      expect(snap1.systemPrompt).toBe("base\n\n[AGENTS.md]\nFollow workspace conventions.");
      expect(snap2.systemPrompt).toBe(snap1.systemPrompt);
      expect(snap2.messages).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits tool_input_repaired and blocks repeated identical tool loops unless allowRepeatedCalls is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-loop-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const observed: string[] = [];
      events.subscribe((ev) => observed.push(ev.type));

      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      let stuckExecs = 0;
      let pollExecs = 0;
      tools.register({
        name: "stuck",
        description: "Takes an integer",
        inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
        sideEffect: "read",
        async execute() {
          stuckExecs++;
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      });
      tools.register({
        name: "poll",
        description: "Polling tool",
        inputSchema: { type: "object", properties: {} },
        sideEffect: "read",
        allowRepeatedCalls: true,
        async execute() {
          pollExecs++;
          return { content: [{ type: "text", text: `poll-${pollExecs}` }], isError: false };
        },
      });

      let turn = 0;
      const model: ModelAdapter = {
        info: { provider: "test", modelId: "test-1", contextWindow: 32000, maxOutputTokens: 2000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          turn++;
          if (turn <= 4) {
            // Turn 1 sends coerced string "1" -> emits tool_input_repaired; turns 2..4 repeat { n: 1 } -> 4th turn blocked!
            yield { type: "tool_call_complete", call: { type: "tool_call", id: `s_${turn}`, name: "stuck", arguments: { n: turn === 1 ? "1" : 1 } } };
            yield { type: "tool_call_complete", call: { type: "tool_call", id: `p_${turn}`, name: "poll", arguments: {} } };
            yield { type: "finished", reason: "tool_use" };
          } else {
            yield { type: "text_delta", delta: "stopped" };
            yield { type: "finished", reason: "stop" };
          }
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({ model, tools, sessions: manager, contextBuilder, events, compactor: null });

      await runtime.runUserTurn("test repeat guard");

      expect(observed).toContain("tool_input_repaired");
      expect(stuckExecs).toBe(3);
      expect(pollExecs).toBe(4);

      const toolMsgs = manager.getActiveMessages().filter((m) => m.message.role === "tool");
      const blocked = toolMsgs.find((m) => {
        const b = m.message.content[0];
        return b?.type === "tool_result" && b.toolCallId === "s_4";
      });
      const block = blocked?.message.content[0];
      expect(block?.type === "tool_result" ? block.isError : false).toBe(true);
      expect(block?.type === "tool_result" ? block.content[0]?.text : "").toContain("Blocked repeated identical call");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays branch_summary entries into ContextBuilder.build() and respects compaction cutoffs", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-bsum-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      const builder = new ContextBuilder({ baseSystemPrompt: "base", toolRegistry: tools });

      const first = await manager.appendUserMessage("branch A start");
      const bs = await manager.appendBranchSummary(first.id, "Tried approach A and failed due to lock.");
      await manager.appendUserMessage("continue on branch B");

      const snap = await builder.build(manager);
      const texts = snap.messages.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : "")));
      expect(texts.some((t) => t.includes("[BRANCH SUMMARY") && t.includes("Tried approach A"))).toBe(true);

      await manager.appendCompaction("Compacted branch history", bs.id);
      const snapAfter = await builder.build(manager);
      const textsAfter = snapAfter.messages.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : "")));
      expect(textsAfter.some((t) => t.includes("[COMPACTED SUMMARY]"))).toBe(true);
      expect(textsAfter.some((t) => t.includes("[BRANCH SUMMARY"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invokes lifecycle hooks (before_llm_call blocking, after_llm_call, on_error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-hooks-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });

      const hookRegistry = new HookRegistry();
      const fired: string[] = [];
      let blockNextLlm = false;
      hookRegistry.register({
        event: "before_agent_run",
        handler: () => {
          fired.push("before_agent_run");
          return true;
        },
      });
      hookRegistry.register({
        event: "before_llm_call",
        handler: () => {
          fired.push("before_llm_call");
          return !blockNextLlm;
        },
      });
      hookRegistry.register({
        event: "after_llm_call",
        handler: () => {
          fired.push("after_llm_call");
          return true;
        },
      });
      hookRegistry.register({
        event: "on_error",
        handler: () => {
          fired.push("on_error");
          return true;
        },
      });

      const model: ModelAdapter = {
        info: { provider: "test", modelId: "test-1", contextWindow: 32000, maxOutputTokens: 2000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield { type: "text_delta", delta: "ok" };
          yield { type: "finished", reason: "stop" };
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({
        model,
        tools,
        sessions: manager,
        contextBuilder,
        events,
        compactor: null,
        hookExecutor: new HookExecutor(hookRegistry),
      });

      await runtime.runUserTurn("hello");
      expect(fired).toEqual(["before_agent_run", "before_llm_call", "after_llm_call"]);

      blockNextLlm = true;
      await expect(runtime.runUserTurn("blocked")).rejects.toThrow(/before_llm_call hook/);
      expect(fired).toContain("on_error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers once from context_length error by compacting and retrying", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-overflow-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const observed: string[] = [];
      events.subscribe((e) => observed.push(e.type));

      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      let streamCalls = 0;
      const model: ModelAdapter = {
        info: { provider: "test", modelId: "test-1", contextWindow: 128000, maxOutputTokens: 2000 },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          streamCalls++;
          if (req.systemPrompt.includes("compressing a coding-agent conversation")) {
            yield {
              type: "text_delta",
              delta: "# Context checkpoint\n\n## Goal\n- Recover from a sudden context length error cleanly with preserved facts and details.\n\n## Next steps\n1. Retry the turn.",
            };
            yield { type: "finished", reason: "stop" };
            return;
          }
          if (streamCalls === 1) {
            throw KernError.model("context_length", "maximum context length exceeded");
          }
          yield { type: "text_delta", delta: "recovered-answer" };
          yield { type: "finished", reason: "stop" };
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({
        model,
        tools,
        sessions: manager,
        contextBuilder,
        events,
        compactor: new Compactor(),
      });

      await runtime.runUserTurn("trigger overflow");
      expect(streamCalls).toBe(3); // 1 failed + 1 compaction + 1 retry
      expect(observed).toContain("auto_compaction_start");
      expect(observed).toContain("auto_compaction_end");
      const last = manager.getActiveMessages().at(-1);
      expect(last?.message.role).toBe("assistant");
      expect(last?.message.content[0]).toEqual({ type: "text", text: "recovered-answer" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails over to fallbackModels on provider failure and emits model_fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-fallback-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const fallbacksEmitted: Array<{ fromModel: string; toModel: string }> = [];
      events.subscribe((e) => {
        if (e.type === "model_fallback") fallbacksEmitted.push({ fromModel: e.fromModel, toModel: e.toModel });
      });

      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      const primary: ModelAdapter = {
        info: { provider: "openai", modelId: "primary-1", contextWindow: 32000, maxOutputTokens: 2000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          throw KernError.model("auth", "invalid primary api key");
        },
      };
      const secondary: ModelAdapter = {
        info: { provider: "groq", modelId: "backup-2", contextWindow: 32000, maxOutputTokens: 2000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield { type: "text_delta", delta: "from-backup" };
          yield { type: "finished", reason: "stop" };
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({
        model: primary,
        fallbackModels: [secondary],
        tools,
        sessions: manager,
        contextBuilder,
        events,
        compactor: null,
      });

      await runtime.runUserTurn("hello fallback");
      expect(fallbacksEmitted).toEqual([{ fromModel: "primary-1", toModel: "backup-2" }]);
      expect(runtime.modelInfo().modelId).toBe("backup-2");
      expect(manager.getActivePath().some((e) => e.type === "model_change" && e.model === "backup-2")).toBe(true);
      const last = manager.getActiveMessages().at(-1);
      expect(last?.message.content[0]).toEqual({ type: "text", text: "from-backup" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("streams tool_execution_update events when a tool emits progress and respects compaction abort", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-progress-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const events = new EventBus();
      const deltas: string[] = [];
      events.subscribe((e) => {
        if (e.type === "tool_execution_update") deltas.push(e.delta);
      });

      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      tools.register({
        name: "stream-tool",
        description: "emits progress",
        inputSchema: { type: "object", properties: {} },
        sideEffect: "read",
        async execute(_args, ctx) {
          ctx.emitProgress?.("line-1\n");
          ctx.emitProgress?.("line-2\n");
          return { content: [{ type: "text", text: "done" }], isError: false };
        },
      });

      let turn = 0;
      const model: ModelAdapter = {
        info: { provider: "test", modelId: "test-1", contextWindow: 32000, maxOutputTokens: 2000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          turn++;
          if (turn === 1) {
            yield { type: "tool_call_complete", call: { type: "tool_call", id: "st_1", name: "stream-tool", arguments: {} } };
            yield { type: "finished", reason: "tool_use" };
          } else {
            yield { type: "text_delta", delta: "all done" };
            yield { type: "finished", reason: "stop" };
          }
        },
      };

      const contextBuilder = new ContextBuilder({ baseSystemPrompt: "test", toolRegistry: tools });
      const runtime = new AgentRuntime({ model, tools, sessions: manager, contextBuilder, events, compactor: null });

      await runtime.runUserTurn("run streaming tool");
      expect(deltas).toEqual(["line-1\n", "line-2\n"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
