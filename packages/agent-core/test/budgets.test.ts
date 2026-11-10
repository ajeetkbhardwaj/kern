import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budgets.js";

describe("BudgetTracker", () => {
  it("throws when turn budget is exceeded", () => {
    const budgets = new BudgetTracker({ maxTurns: 1 });
    expect(() => budgets.checkTurn(1)).not.toThrow();
    expect(() => budgets.checkTurn(2)).toThrow(/Turn budget exceeded/);
  });

  it("throws when per-turn tool-call budget is exceeded", () => {
    const budgets = new BudgetTracker({ maxToolCallsPerTurn: 2 });
    expect(() => budgets.checkToolBatch(3)).toThrow(/Per-turn tool-call budget exceeded/);
  });

  it("throws when total tool-call budget is exceeded", () => {
    const budgets = new BudgetTracker({ maxTotalToolCalls: 3, maxToolCallsPerTurn: 5 });
    budgets.recordToolCalls(2);
    expect(() => budgets.checkToolBatch(2)).toThrow(/Total tool-call budget exceeded/);
  });

  it("tracks usage", () => {
    const budgets = new BudgetTracker({ maxTurns: 10, maxTotalToolCalls: 10 });
    budgets.checkTurn(1);
    budgets.checkToolBatch(2);
    budgets.recordToolCalls(2);
    const usage = budgets.usage();
    expect(usage.turns).toBe(1);
    expect(usage.totalToolCalls).toBe(2);
    expect(usage.wallTimeMs).toBeGreaterThanOrEqual(0);
  });
});
