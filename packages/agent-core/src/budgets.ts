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
  private readonly startedAt = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;
  private readonly byModel: Record<string, ModelBudgetUsage> = {};
  private readonly onEvent?: (event: AgentEvent) => void;

  constructor(limits: Partial<BudgetLimits> = {}, onEvent?: (event: AgentEvent) => void) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
    this.onEvent = onEvent;
  }

  get limitsSnapshot(): BudgetLimits {
    return { ...this.limits };
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
