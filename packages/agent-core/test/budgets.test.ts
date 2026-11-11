import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budgets.js";

describe("BudgetTracker", () => {
  it("throws when cost budget is exceeded", () => {
    const budgets = new BudgetTracker({ maxCost: 0.05 });
    budgets.recordUsage(100, 50, 0.03, "model-a");
    expect(() => budgets.recordUsage(10, 5, 0.03, "model-a")).toThrow(/Cost budget exceeded/);
  });

  it("throws when total token budget is exceeded", () => {
    const budgets = new BudgetTracker({ maxTotalTokens: 200 });
    budgets.recordUsage(100, 50, 0, "model-a");
    expect(() => budgets.recordUsage(100, 1, 0, "model-a")).toThrow(/Token budget exceeded/);
  });

  it("tracks usage per model", () => {
    const budgets = new BudgetTracker({});
    budgets.recordUsage(100, 50, 0.02, "model-a");
    budgets.recordUsage(200, 25, 0.01, "model-b");
    const usage = budgets.usage();
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(75);
    expect(usage.cost).toBe(0.03);
    expect(usage.byModel["model-a"]?.cost).toBe(0.02);
    expect(usage.byModel["model-b"]?.cost).toBe(0.01);
  });

  it("warns when approaching cost budget", () => {
    let warned = false;
    const budgets = new BudgetTracker({ maxCost: 0.10 }, (event) => {
      if (event.type === "budget_warning") warned = true;
    });
    budgets.recordUsage(100, 50, 0.08, "model-a");
    expect(warned).toBe(true);
  });

  it("emits token_usage events", () => {
    let emitted = false;
    const budgets = new BudgetTracker({}, (event) => {
      if (event.type === "token_usage") emitted = true;
    });
    budgets.recordUsage(100, 50, 0.02, "model-a");
    expect(emitted).toBe(true);
  });
});
