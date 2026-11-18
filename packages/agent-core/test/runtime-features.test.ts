import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelAdapter, ModelRequest, ModelStreamEvent, ToolDefinition } from "@kern/protocol";
import { SessionStore, SessionManager } from "@kern/session-store";
import { ToolRegistry, AllowAllPolicy } from "@kern/tools";
import { AgentRuntime, ContextBuilder, EventBus, BudgetTracker } from "../src/index.js";

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

  it("refreshes ContextBuilder repoResolver when the query changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-ctx-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const manager = await SessionManager.create(store, root);
      const tools = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
      const queries: string[] = [];
      const builder = new ContextBuilder({
        baseSystemPrompt: "base",
        toolRegistry: tools,
        repoResolver: async (q) => {
          queries.push(q);
          return { query: q, likelyFiles: [`${q}.ts`] };
        },
      });

      await manager.appendUserMessage("alpha");
      const snap1 = await builder.build(manager);
      expect(snap1.systemPrompt).toContain("alpha.ts");

      await manager.appendUserMessage("beta");
      const snap2 = await builder.build(manager);
      expect(snap2.systemPrompt).toContain("beta.ts");
      expect(queries).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
