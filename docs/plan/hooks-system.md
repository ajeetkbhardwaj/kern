# Plan: Hooks System for Kern (TypeScript Adaptation)

## Overview
Adapt docker-agents' 34-event hooks system (Chapter 12) as the primary extension mechanism for kern. Hooks provide interception points at every lifecycle moment, enabling safety, redaction, context injection, and routing customization without modifying core logic.

## TypeScript Adaptation Goals

### 1. Hook Event Contract (analogue to `pkg/hooks/events/contracts.go`)
Define a typed event system that covers all runtime lifecycle points:

**Tool Pipeline Events** (analogue to tool pipeline):
- `tool_input_transform` - Rewrite tool input before guards (even auto-approved calls)
- `pre_tool_use` - Sequential; can block; rewrites tool input
- `tool_guard` - Mandatory checks; can use evaluator-backed OpenAI-style decision
- `permission_request` - Observes/approves the ask-UI round-trip
- `on_tool_approval_decision` - Records user's verdicts
- `post_tool_use` - After execution
- `tool_response_transform` - Scrub/rewrite output before emission & persistence

**Conversation/Session Events**:
- `session_start`, `session_end`
- `user_prompt_submit`, `user_steering_messages_submit`, `user_followup_submit`
- `turn_start`, `turn_end`
- `on_user_input`, `stop`, `notification`, `on_error`, `on_max_iterations`

**LLM Events**:
- `before_llm_call` (sequential; can block; rewrites messages)
- `after_llm_call`

**Compaction Events**:
- `pre_compact`, `before_compaction` (veto/custom summary), `after_compaction`

**Agent/Team Events**:
- `subagent_stop`, `on_agent_switch`, `on_session_resume`
- `before_agent_run` / `after_agent_complete` (both can block and route to another agent)

**Content Vetting**:
- `skill_content_guard` (inspect skill content before delivery)
- `prompt_file_guard` (AGENTS.md files before injection)

### 2. Hook Definition & Registration (analogue to `pkg/hooks/*.go`)
- Hooks defined in: YAML (shell commands with exit-code semantics), JS (via goja or JS eval), TypeScript handlers, evaluator handlers
- Hook matching by tool-name patterns (scope by tool, e.g., only `shell`)
- Global user-level hooks + `hooks.d/` drop-in directory merge with per-agent/per-config hooks

### 3. Execution Engine (analogue to `executor.go`)
- **Lanes**: Under `pre_tool_use` splits into sequential approval lane vs parallel metadata lane
- **Aggregation**: Multiple hooks produce one verdict (any block wins for guards; transforms compose left-to-right)
- **Matchers**: Hook registrations scope by tool-name patterns

### 4. Built-in Hooks (shipped with kern)
- `add_context` (template rendering)
- `add_date`
- `add_environment_info`
- `redact_secrets` (tri-state: `auto` detects likely secret presence, `always`, `never`)
- `limit_large_tool_results`
- `keep_awake`

### 5. Integration with Existing Kern Components
- **Safety**: Hooks drive the 4-layer safety model (permission rules → safety modes → hook enforcement → isolation)
- **Policy**: `tool_input_transform` → `tool_guard` → `permission_request` → approval UI → `tool_response_transform`
- **Redaction**: Runs regardless of safety mode (auto-detects secrets in args, messages, outputs)
- **TUI**: Hook events surface in TUI for user interaction (approval prompts, mode switching)

## Implementation Priority
**HIGH** - This is the foundational extension mechanism kern needs for all other adaptations.

## Files to Create/Modify
- `src/hooks/events/contracts.ts` - Event type definitions
- `src/hooks/*.ts` - Hook implementation files
- `src/policy.ts` - Integrate hook enforcement into policy engine
- `src/tools.ts` - Hook calls at tool execution points
- `tui/` - Hook event display in TUI

## Reference from docker-agents
- Chapter 12: Hooks System
- 34-event table from `events/contracts.go`
- `executor.go` for execution engine patterns
- Built-in hooks: `redact_secrets`, `add_context`, `add_date`