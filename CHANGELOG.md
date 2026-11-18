# Changelog

## [1.0.0] - 2026-11-18

### First Production Release (GitHub v1.0.0)

Kern `1.0.0` promotes the modular coding-agent kernel, CLI, TUI, and web workbench to its first stable release.

### Highlights & New Features

- **`@kern/protocol` (`v2` Session Format + Annotations + Pricing)**
  - Bumped `SESSION_ENTRY_VERSION` to `2` with `UsageEntry` persistence and `tokensBefore` / `tokensAfter` compaction metadata.
  - Added MCP-compatible `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on `ToolDefinition` and `PolicyInput`.
  - Added optional per-1M token pricing (`inputCostPer1M`, `outputCostPer1M`) on `ModelInfo` and expanded `BudgetLimitKind` for turn, tool-call, and wall-time limits.
  - Hardened output redaction with Google `AIza*` and HTTP `Bearer` token rules.
- **`@kern/session-store` (Versioned Migrations & Usage Totals)**
  - Added `migrateSessionEntries()` supporting `v1` → `v2` upgrades with fail-closed `E_SESSION_MIGRATION` on unsupported future formats.
  - Added `appendUsage()` and `getUsageTotals()` on `SessionManager`.
- **`@kern/tools` (Workspace Search, Real Loopback Serve, Sync `.agentignore`, Hardened Policy)**
  - Added built-in read-only **`grep`** and **`find`** tools respecting `.agentignore` and binary/size limits.
  - Fixed `git-diff` and `git-checkout` argument passing (`git git ...`) and fail-closed `E_TOOL_DENIED` path resolution across all git and filesystem tools.
  - Hardened `rm` (blocks removing workspace root), `cat`/`head`/`tail` (directory, binary, and size bounds), `test`/`type-check`/`format` (npm/npx workspace compatibility), and `serve` (real loopback `node:http` static server with start/status/stop).
  - Persisted `memory`, `plan`, and `todo` tools to `.kern/*.json` in the workspace.
  - Fixed `DefaultPolicy.updatePermissionRules` sibling-rule clobbering, added annotation-aware policy checks, enforced synchronous `.agentignore` loading in `safeResolveSync`, and sanitized API key env vars from child shell processes.
- **`@kern/agent-core` (Enforced Run Budgets, Parallel Read-Only Tools, True Steering, Cost Persistence)**
  - Enforced `maxTurns`, `maxToolCallsPerTurn`, `maxTotalToolCalls`, and `maxWallTimeMs` in `BudgetTracker` and `AgentRuntime`.
  - Executed batches of all-read-only tool calls concurrently while maintaining deterministic session ordering and sequential execution for mutating tools.
  - Implemented true mid-run steering queue injection before finalizing turns, automatic usage/cost persistence across turns, and usage restoration on session resume.
  - Fixed `ContextBuilder` to re-run `repoResolver` whenever the task query changes and compute deterministic compaction cutoffs.
- **`@kern/model`, `@kern/repo-index`, `@kern/coding-agent`, `@kern/cli`, `@kern/tui`**
  - Added `gemini` and `groq` OpenAI-compatible presets, multi-`tool_result` mapping in `openai.ts`, and code-extension/size guards in `RepoIndex`.
  - Registered `grep` and `find` tools in `createAgentSession` and exposed `usageSummary()` / `exportMarkdown()`.
  - Added `--version`/`-v`, `--json` (NDJSON event stream), `--max-turns`, `--max-wall-time-ms`, `--max-tool-calls-per-turn`, `--max-total-tool-calls`, expanded `--read-only` tool allowlist, and live event streaming + `set_safety`/`history`/`steer`/`follow_up` methods in `--rpc` mode.

## [0.5.0] - 2026-11-11

### Pre-release baseline

- Initial modular workspace (`@kern/protocol`, `@kern/model`, `@kern/session-store`, `@kern/tools`, `@kern/agent-core`, `@kern/coding-agent`, `@kern/cli`, `@kern/tui`, and repo-aware indexing packages).
