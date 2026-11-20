import { describe, expect, it } from "vitest";
import { Compactor } from "../src/compaction.js";

function snapshot(totalTokens: number) {
  return {
    systemPrompt: "",
    messages: [],
    tools: [],
    usage: {
      systemTokens: 0,
      toolTokens: 0,
      historyTokens: 0,
      reserveTokens: 0,
      messageTokens: 0,
      totalTokens,
    },
  } as any;
}

describe("Compactor", () => {
  it("does not compact when within budget", () => {
    const compactor = new Compactor({ threshold: 0.75, outputReserve: 1000 });
    const decision = compactor.evaluate(snapshot(1000), 10000);
    expect(decision.shouldCompact).toBe(false);
  });

  it("compacts when total tokens exceed budget", () => {
    const compactor = new Compactor({ threshold: 0.75, outputReserve: 1000 });
    const decision = compactor.evaluate(snapshot(9000), 10000);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.totalTokens).toBe(9000);
  });

  it("flags weak summaries", () => {
    const compactor = new Compactor();
    const quality = compactor.assessSummaryQuality("too short");
    expect(quality.isWeak).toBe(true);
  });

  it("accepts sufficiently detailed summaries", () => {
    const compactor = new Compactor();
    const summary = `# Context checkpoint

## Goal
- Implement feature X and keep behavior stable.

## Progress
- Updated parser and added tests.
- Verified with targeted runs.

## Next steps
1. Continue with integration checks and fix regressions if found.`;
    const quality = compactor.assessSummaryQuality(summary);
    expect(quality.isWeak).toBe(false);
  });

  it("handles tiny or invalid context windows safely", () => {
    const compactor = new Compactor({ threshold: 0.75, outputReserve: 1000 });
    const decision = compactor.evaluate(snapshot(10), 500);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.budgetTokens).toBeLessThanOrEqual(0);
  });

  it("does not request compaction for empty context even with tiny window", () => {
    const compactor = new Compactor({ threshold: 0.75, outputReserve: 1000 });
    const decision = compactor.evaluate(snapshot(0), 0);
    expect(decision.shouldCompact).toBe(false);
  });

  it("propagates AbortSignal and rejects when compaction is aborted", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { SessionStore, SessionManager } = await import("@kern/session-store");
    const root = mkdtempSync(join(tmpdir(), "kern-compact-abort-"));
    try {
      const store = new SessionStore({ storageRoot: join(root, "sessions") });
      const mgr = await SessionManager.create(store, root);
      await mgr.appendUserMessage("hello");
      const ac = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const model = {
        info: { provider: "t", modelId: "m", contextWindow: 8000, maxOutputTokens: 1000 },
        async *stream(req: { signal?: AbortSignal }) {
          receivedSignal = req.signal;
          ac.abort();
          yield { type: "text_delta" as const, delta: "partial" };
        },
      };
      const compactor = new Compactor();
      await expect(compactor.compact(mgr, model as any, undefined, ac.signal)).rejects.toThrow(/aborted/i);
      expect(receivedSignal).toBe(ac.signal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
