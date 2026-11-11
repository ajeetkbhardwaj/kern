# Plan: Budgets & Code-Mode Token Economy for Kern (TypeScript Adaptation)

## Overview

Adapt docker-agents' sessions cost tracking and agent-config budget fields (Chapter 13 code-mode / token economy synergy) as kern's budget layer. Provides per-session hard caps on monetary cost and token counts (input/output/total), with fail-closed `E_BUDGET_EXCEEDED` aborts and best-effort live usage stats surfaced in the TUI. Turn/tool-call/wall-time limits are intentionally excluded — those are provider/token-economics concerns, not user-facing constraints.

## TypeScript Adaptation Goals

### 1. Budget Limits & Usage (analogue to docker-agent session cost + `max_cost`/`max_tokens` limit kinds)

Define consumable resource caps checked before every model call:

```typescript
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

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Per-model attribution: model id -> { input, output, cost }. */
  byModel: Record<string, { input: number; output: number; cost: number }>;
}
```

Defaults: all `0` (unlimited). Limits are overridable per session/agent via config flags (`--max-cost`, `--max-input-tokens`, `--max-output-tokens`, `--max-total-tokens`) or `/budget` in the TUI.

### 2. BudgetTracker (analogue to sessions token-cost tracking)

A `BudgetTracker` started per session records input/output tokens and cost per model, checks limits before each model call, and throws `KernError("E_BUDGET_EXCEEDED", ...)` with a `details.budget` tag when a cap is exceeded. The runtime converts this into a diagnostic and aborts the turn with no partial state.

Checks:

- `recordUsage(input, output, cost, model)` — records model usage, attributed per model; emits `token_usage` event
- `checkCostLimits()` — checks `maxCost`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`; warns at 80% of limit (`budget_warning`), fails at 100% (`budget_exceeded`)

### 3. Fail-Closed Behavior

- Budget exceeded → `E_BUDGET_EXCEEDED` diagnostic, turn aborts, no partial state persisted.
- Budgets checked before each model call (defense in depth).
- Best-effort live usage (`inputTokens`, `outputTokens`, `cost`, `byModel`) shown in TUI status bar and sidebar under Session → Usage / Budgets.

### 4. Integration with Existing Kern Components

- **Agent-core**: `AgentRuntime` constructs a `BudgetTracker` per session from config limits; `streamModel` captures model `usage` events and records them via `budgets.recordUsage()`.
- **TUI**: `/budget` command shows current limits + usage + per-model breakdown; status bar shows `$cost · tokens in/out`; `budget_warning` shows toast; `E_BUDGET_EXCEEDED` shows detailed diagnostic.
- **CLI**: `--max-cost`, `--max-input-tokens`, `--max-output-tokens`, `--max-total-tokens` flags; `--config` config file supplies budget block.
- **Protocol**: `ChatMessage` has `cost?: number` and `model?: string`; new `AgentEvent` types: `budget_warning`, `budget_exceeded`, `token_usage`; new `CostSnapshot` type; `BudgetLimitKind` = `"max_cost" | "max_tokens"`.
- **Policy & Safety**: budget exhaustion is treated as a fail-closed safety boundary.

## Implementation Priority

**HIGH** — you flagged the budget system as not good from both provider and user perspectives; cost/token economics is what matters, not arbitrary turn/tool/wall counts.

## Files to Create/Modify

- `packages/protocol/src/core.ts` — `cost`/`model` on `ChatMessage`; `BudgetLimitKind`, `CostSnapshot`; `budget_warning`/`budget_exceeded`/`token_usage` event types
- `packages/protocol/src/schemas.ts` — Zod schemas for new types
- `packages/agent-core/src/budgets.ts` — `BudgetLimits`, `DEFAULT_BUDGET_LIMITS`, `BudgetUsage`, `BudgetTracker` (cost/token-only; no turns/tools/wall)
- `packages/agent-core/src/agent.ts` — wire `BudgetTracker` into `AgentRuntime.streamModel`
- `packages/cli/src/main.ts` — budget-limit CLI flags (`--max-cost`, `--max-input-tokens`, `--max-output-tokens`, `--max-total-tokens`)
- `packages/tui/src/tui.ts` — `/budget` command, status bar budget stats, per-model sidebar
- `packages/coding-agent/src/create-agent-session.ts` — `AgentSession.budgetUsage()` returns `BudgetUsage`
- `docs/configuration/budgets.md` — user-facing budget config docs.

## Reference from docker-agents

- `docs/features/sessions` — sessions track "every message, tool call, sub-agent run, and cost"; token cost is a core session concern.
- `docs/configuration/agents/index.md` — agent budget fields: `max_cost`, `max_tokens` limit kinds; `max_old_tool_call_tokens`, `max_tool_result_tokens` for truncation.
- Chapter 13 code-mode synergy — deferred loading and token economy; tool-call batching saves budget.
- Commit/DCO: `git commit -S -s`, Conventional Commits.
