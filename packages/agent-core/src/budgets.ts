import { KernError, type CostSnapshot, type BudgetLimitKind, type AgentEvent } from "@kern/protocol";

export interface BudgetLimits {
  /** Monetary cost limit in USD. 0 = unlimited. */
  maxCost: number;
  /** Input token limit. 0 = unlimited. */
  maxInputTokens: number;
  /** Output token limit. 0 = unlimited. */
  maxOutputTokens: number;
  /** Total token limit (input + output). 0 = unlimited. */
  maxTotalTokens: number;
  /** Maximum turns per user run. 0 / undefined = unlimited. */
  maxTurns?: number;
  /** Maximum tool calls within a single model turn. 0 / undefined = unlimited. */
  maxToolCallsPerTurn?: number;
  /** Maximum tool calls across a single user run. 0 / undefined = unlimited. */
  maxTotalToolCalls?: number;
  /** Maximum wall clock duration (ms) for a user run. 0 / undefined = unlimited. */
  maxWallTimeMs?: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxCost: 0,
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxTotalTokens: 0,
};

export interface ModelBudgetUsage {
  input: number;
  output: number;
  cost: number;
}

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  byModel: Record<string, ModelBudgetUsage>;
}

/** Warning fires at 80% of a limit by default. */
const WARNING_RATIO = 0.8;

export class BudgetTracker {
  private readonly limits: BudgetLimits;
  private runStartedAt = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;
  private turns = 0;
  private turnToolCalls = 0;
  private totalToolCalls = 0;
  private readonly byModel: Record<string, ModelBudgetUsage> = {};
  private readonly onEvent?: (event: AgentEvent) => void;

  constructor(limits: Partial<BudgetLimits> = {}, onEvent?: (event: AgentEvent) => void) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
    this.onEvent = onEvent;
  }

  get limitsSnapshot(): BudgetLimits {
    return { ...this.limits };
  }

  updateLimits(partial: Partial<BudgetLimits>): BudgetLimits {
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) {
        (this.limits as unknown as Record<string, number>)[k] = v;
      }
    }
    return this.limitsSnapshot;
  }

  usage(): BudgetUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost,
      byModel: { ...this.byModel },
    };
  }

  costSnapshot(): CostSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost,
      byModel: { ...this.byModel },
    };
  }

  /** Restore cumulative usage totals from a persisted session snapshot without emitting warnings. */
  restoreUsage(snapshot: CostSnapshot): void {
    this.inputTokens = snapshot.inputTokens;
    this.outputTokens = snapshot.outputTokens;
    this.cost = snapshot.cost;
    for (const [model, data] of Object.entries(snapshot.byModel)) {
      this.byModel[model] = { ...data };
    }
  }

  /** Reset per-run counters (turns, tool calls, wall clock) at the start of a user turn. */
  startRun(): void {
    this.runStartedAt = Date.now();
    this.turns = 0;
    this.turnToolCalls = 0;
    this.totalToolCalls = 0;
  }

  /** Record start of a turn and enforce maxTurns and maxWallTimeMs. */
  beginTurn(): void {
    this.checkWallTime();
    this.turns += 1;
    this.turnToolCalls = 0;
    const maxTurns = this.limits.maxTurns ?? 0;
    if (maxTurns > 0 && this.turns > maxTurns) {
      this.failLimit("max_turns", this.turns, maxTurns, `Turn budget exceeded (${this.turns} > ${maxTurns})`);
    } else if (maxTurns > 0 && this.turns / maxTurns >= WARNING_RATIO - 0.001) {
      this.warnLimit("max_turns", this.turns, maxTurns, `Approaching turn budget (${this.turns} of ${maxTurns})`);
    }
  }

  /** Record a tool call and enforce per-turn, total-run tool call limits, and wall clock. */
  recordToolCall(): void {
    this.checkWallTime();
    this.turnToolCalls += 1;
    this.totalToolCalls += 1;

    const maxPerTurn = this.limits.maxToolCallsPerTurn ?? 0;
    if (maxPerTurn > 0 && this.turnToolCalls > maxPerTurn) {
      this.failLimit(
        "max_tool_calls",
        this.turnToolCalls,
        maxPerTurn,
        `Per-turn tool call budget exceeded (${this.turnToolCalls} > ${maxPerTurn})`,
      );
    }

    const maxTotal = this.limits.maxTotalToolCalls ?? 0;
    if (maxTotal > 0 && this.totalToolCalls > maxTotal) {
      this.failLimit(
        "max_tool_calls",
        this.totalToolCalls,
        maxTotal,
        `Total tool call budget exceeded (${this.totalToolCalls} > ${maxTotal})`,
      );
    } else if (maxTotal > 0 && this.totalToolCalls / maxTotal >= WARNING_RATIO - 0.001) {
      this.warnLimit(
        "max_tool_calls",
        this.totalToolCalls,
        maxTotal,
        `Approaching total tool call budget (${this.totalToolCalls} of ${maxTotal})`,
      );
    }
  }

  /** Check elapsed wall time against maxWallTimeMs. */
  checkWallTime(): void {
    const maxWall = this.limits.maxWallTimeMs ?? 0;
    if (maxWall <= 0) return;
    const elapsed = Date.now() - this.runStartedAt;
    if (elapsed > maxWall) {
      this.failLimit("max_wall_time", elapsed, maxWall, `Wall time budget exceeded (${elapsed}ms > ${maxWall}ms)`);
    }
  }

  /** Record token usage and cost from a model response, attributed to a model. */
  recordUsage(input: number, output: number, cost: number, model: string): void {
    this.inputTokens += input;
    this.outputTokens += output;
    this.cost += cost;
    const m = this.byModel[model] ?? { input: 0, output: 0, cost: 0 };
    m.input += input;
    m.output += output;
    m.cost += cost;
    this.byModel[model] = m;

    this.emitTokenUsage(input, output, cost, model);
    this.checkCostLimits();
  }

  private checkCostLimits(): void {
    const totalTokens = this.inputTokens + this.outputTokens;

    if (this.limits.maxCost > 0 && this.cost > this.limits.maxCost) {
      this.failLimit("max_cost", this.cost, this.limits.maxCost, `Cost budget exceeded ($${this.cost.toFixed(4)} > $${this.limits.maxCost.toFixed(4)})`);
    } else if (this.limits.maxCost > 0 && this.cost / this.limits.maxCost >= WARNING_RATIO - 0.001) {
      this.warnLimit("max_cost", this.cost, this.limits.maxCost, `Approaching cost budget ($${this.cost.toFixed(4)} of $${this.limits.maxCost.toFixed(4)})`);
    }

    if (this.limits.maxTotalTokens > 0 && totalTokens > this.limits.maxTotalTokens) {
      this.failLimit("max_tokens", totalTokens, this.limits.maxTotalTokens, `Token budget exceeded (${totalTokens} > ${this.limits.maxTotalTokens})`);
    } else if (this.limits.maxTotalTokens > 0 && totalTokens / this.limits.maxTotalTokens >= WARNING_RATIO - 0.001) {
      this.warnLimit("max_tokens", totalTokens, this.limits.maxTotalTokens, `Approaching token budget (${totalTokens} of ${this.limits.maxTotalTokens})`);
    }

    if (this.limits.maxInputTokens > 0 && this.inputTokens > this.limits.maxInputTokens) {
      this.failLimit("max_tokens", this.inputTokens, this.limits.maxInputTokens, `Input token budget exceeded (${this.inputTokens} > ${this.limits.maxInputTokens})`);
    }
    if (this.limits.maxOutputTokens > 0 && this.outputTokens > this.limits.maxOutputTokens) {
      this.failLimit("max_tokens", this.outputTokens, this.limits.maxOutputTokens, `Output token budget exceeded (${this.outputTokens} > ${this.limits.maxOutputTokens})`);
    }
  }

  private warnLimit(kind: BudgetLimitKind, current: number, limit: number, message: string): void {
    this.emit({ type: "budget_warning", kind, current, limit, message });
  }

  private failLimit(kind: BudgetLimitKind, current: number, limit: number, message: string): never {
    this.emit({ type: "budget_exceeded", kind, current, limit, message });
    throw new KernError("E_BUDGET_EXCEEDED", message, {
      details: { budget: kind, current, limit, ...this.usage() },
    });
  }

  private emitTokenUsage(input: number, output: number, cost: number, model: string): void {
    this.emit({ type: "token_usage", input, output, cost, model });
  }

  private emit(event: AgentEvent): void {
    if (this.onEvent) this.onEvent(event);
  }
}
