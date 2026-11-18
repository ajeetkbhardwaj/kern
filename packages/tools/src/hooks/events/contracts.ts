/**
 * @kern/tools/hooks/events/contracts — Hook event contract definitions.
 *
 * Adapted from docker-agents Chapter 12 (Hooks System) for TypeScript/kern.
 * Provides typed interception points at every lifecycle moment, enabling
 * safety, redaction, context injection, and routing customization.
 */

import type { ToolResult } from "@kern/protocol";
import type { PolicyDecision, PolicyInput } from "@kern/protocol";

/** Hook execution result. Returning false blocks the pipeline. */
export type HookVerdict = boolean;

/** Hook handler signature. Return false to block the pipeline. */
export type HookHandler<Params extends unknown[] = unknown[]> = (
  ...params: Params
) => HookVerdict | Promise<HookVerdict>;

/** Transform hook handler signature returning replacement `[ctx, params]` tuple (or void/unchanged). */
export type TransformHookHandler<Params extends unknown[] = unknown[]> = (
  ...params: Params
) => Params | void | Promise<Params | void>;

/** Hook registration. Scope by tool-name patterns via `matcher`. */
export interface HookRegistration {
  /** Event name this hook listens to. */
  event: string;
  /** Handler function. */
  handler: HookHandler | TransformHookHandler;
  /** Optional glob-like matcher for tool names (e.g. "shell*", "bash"). */
  matcher?: string;
  /** Priority (lower runs first). Defaults to 0. */
  priority?: number;
  /** Whether this hook can block execution. */
  canBlock?: boolean;
}

/** Hook context passed to all handlers. */
export interface HookContext {
  sessionId?: string;
  toolName?: string;
  origin?: PolicyInput["origin"];
  timestamp: string;
}

/** Hook execution result after running all handlers for an event. */
export interface HookPipelineResult {
  /** Whether execution should proceed (true) or be blocked (false). */
  proceed: boolean;
  /** Transformed/replacement params (for transform hooks). */
  modifiedParams?: unknown[];
  /** Aggregate verdict from all handlers. */
  verdicts: Array<{ event: string; matched: boolean; decision: HookVerdict }>;
}

/** Transformed hook params for transform-style hooks. */
export interface TransformResult {
  /** Whether the hook transformed the params. */
  transformed: boolean;
  /** New params if transformed. */
  params?: unknown[];
}

// =============================================================================
// Tool Pipeline Events
// =============================================================================

/** tool_input_transform - Runs even on auto-approved calls; rewrites tool input *before* guards. */
export interface ToolInputTransformParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
}
export type ToolInputTransformHandler = (
  ctx: HookContext,
  params: ToolInputTransformParams,
) => [HookContext, ToolInputTransformParams] | Promise<[HookContext, ToolInputTransformParams]>;

/** pre_tool_use - Sequential; can block; rewrites tool input. */
export interface PreToolUseParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
}
export type PreToolUseHandler = (
  ctx: HookContext,
  params: PreToolUseParams,
) => HookVerdict | Promise<HookVerdict>;

/** tool_guard - Mandatory checks; evaluator-backed → OpenAI-style decision. */
export interface ToolGuardParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
  sideEffect: string;
}
export type ToolGuardHandler = (
  ctx: HookContext,
  params: ToolGuardParams,
) => PolicyDecision | Promise<PolicyDecision>;

/** permission_request - Observes/approves the ask-UI round-trip. */
export interface PermissionRequestParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
  policyDecision: PolicyDecision;
}
export type PermissionRequestHandler = (
  ctx: HookContext,
  params: PermissionRequestParams,
) => boolean | Promise<boolean>;

/** on_tool_approval_decision - Records user's verdicts. */
export interface ToolApprovalDecisionParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
  approved: boolean;
  reason?: string;
}
export type ToolApprovalDecisionHandler = (
  ctx: HookContext,
  params: ToolApprovalDecisionParams,
) => void | Promise<void>;

/** post_tool_use - After execution. */
export interface PostToolUseParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
  result: ToolResult;
  durationMs: number;
}
export type PostToolUseHandler = (
  ctx: HookContext,
  params: PostToolUseParams,
) => HookVerdict | Promise<HookVerdict>;

/** tool_response_transform - Scrub/rewrite output before emission & persistence. */
export interface ToolResponseTransformParams {
  toolName: string;
  args: unknown;
  origin: PolicyInput["origin"];
  result: ToolResult;
}
export type ToolResponseTransformHandler = (
  ctx: HookContext,
  params: ToolResponseTransformParams,
) => [HookContext, ToolResponseTransformParams] | Promise<[HookContext, ToolResponseTransformParams]>;

// =============================================================================
// Conversation/Session Events
// =============================================================================

export interface SessionStartParams {
  sessionId: string;
}
export type SessionStartHandler = (
  ctx: HookContext,
  params: SessionStartParams,
) => void | Promise<void>;

export interface SessionEndParams {
  sessionId: string;
}
export type SessionEndHandler = (
  ctx: HookContext,
  params: SessionEndParams,
) => void | Promise<void>;

export interface UserPromptSubmitParams {
  prompt: string;
  sessionId: string;
}
export type UserPromptSubmitHandler = (
  ctx: HookContext,
  params: UserPromptSubmitParams,
) => HookVerdict | Promise<HookVerdict>;

export interface TurnStartParams {
  turn: number;
  sessionId: string;
}
export type TurnStartHandler = (
  ctx: HookContext,
  params: TurnStartParams,
) => void | Promise<void>;

export interface TurnEndParams {
  turn: number;
  sessionId: string;
}
export type TurnEndHandler = (
  ctx: HookContext,
  params: TurnEndParams,
) => void | Promise<void>;

// =============================================================================
// LLM Events
// =============================================================================

export interface BeforeLLMCallParams {
  messages: Array<{ role: string; content: string }>;
  model: string;
}
export type BeforeLLMCallHandler = (
  ctx: HookContext,
  params: BeforeLLMCallParams,
) => HookVerdict | Promise<HookVerdict>;

export interface AfterLLMCallParams {
  response: string;
  model: string;
  tokens?: { input: number; output: number };
}
export type AfterLLMCallHandler = (
  ctx: HookContext,
  params: AfterLLMCallParams,
) => void | Promise<void>;

// =============================================================================
// Compaction Events
// =============================================================================

export interface PreCompactParams {
  sessionId: string;
  tokenCount: number;
  maxTokens: number;
}
export type PreCompactHandler = (
  ctx: HookContext,
  params: PreCompactParams,
) => HookVerdict | Promise<HookVerdict>;

export interface BeforeCompactionParams {
  sessionId: string;
  summary?: string;
}
export type BeforeCompactionHandler = (
  ctx: HookContext,
  params: BeforeCompactionParams,
) => { veto: boolean; summary?: string } | Promise<{ veto: boolean; summary?: string }>;

export interface AfterCompactionParams {
  sessionId: string;
  summary: string;
  replacedThroughId: string;
}
export type AfterCompactionHandler = (
  ctx: HookContext,
  params: AfterCompactionParams,
) => void | Promise<void>;

// =============================================================================
// Agent/Team Events
// =============================================================================

export interface SubAgentStopParams {
  agentId: string;
  sessionId: string;
}
export type SubAgentStopHandler = (
  ctx: HookContext,
  params: SubAgentStopParams,
) => void | Promise<void>;

export interface AgentSwitchParams {
  fromAgent: string;
  toAgent: string;
  sessionId: string;
}
export type AgentSwitchHandler = (
  ctx: HookContext,
  params: AgentSwitchParams,
) => HookVerdict | Promise<HookVerdict>;

export interface BeforeAgentRunParams {
  agentId: string;
  sessionId: string;
}
export type BeforeAgentRunHandler = (
  ctx: HookContext,
  params: BeforeAgentRunParams,
) => HookVerdict | Promise<HookVerdict>;

export interface AfterAgentCompleteParams {
  agentId: string;
  sessionId: string;
  success: boolean;
}
export type AfterAgentCompleteHandler = (
  ctx: HookContext,
  params: AfterAgentCompleteParams,
) => void | Promise<void>;

// =============================================================================
// Content Vetting Events
// =============================================================================

export interface SkillContentGuardParams {
  skillName: string;
  content: string;
}
export type SkillContentGuardHandler = (
  ctx: HookContext,
  params: SkillContentGuardParams,
) => { pass: boolean; reason?: string } | Promise<{ pass: boolean; reason?: string }>;

export interface PromptFileGuardParams {
  filePath: string;
  content: string;
}
export type PromptFileGuardHandler = (
  ctx: HookContext,
  params: PromptFileGuardParams,
) => { pass: boolean; reason?: string } | Promise<{ pass: boolean; reason?: string }>;

// =============================================================================
// Error Events
// =============================================================================

export interface OnErrorParams {
  error: Error;
  context?: string;
}
export type OnErrorHandler = (
  ctx: HookContext,
  params: OnErrorParams,
) => void | Promise<void>;

export interface OnMaxIterationsParams {
  iterations: number;
  maxIterations: number;
  sessionId: string;
}
export type OnMaxIterationsHandler = (
  ctx: HookContext,
  params: OnMaxIterationsParams,
) => HookVerdict | Promise<HookVerdict>;