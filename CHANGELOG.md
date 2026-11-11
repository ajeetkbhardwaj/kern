# Changelog

## [0.5.0] - 2026-11-11

### First stable release

Kern is a minimal, from-first-principles terminal coding agent kernel. It runs in an interactive TUI by default, executes tools with explicit policy/approval checks, persists sessions locally, and works with OpenAI-compatible model endpoints (cloud or local).

### Packages

- `@kern/protocol` — shared types and contracts (narrow waist, zero runtime)
- `@kern/model` — provider-neutral model adapter + discovery/auth
- `@kern/session-store` — append-only JSONL session persistence with branch tree
- `@kern/tools` — tool contract, registry, policy engine, built-in read/write/edit/bash, MCP bridge
- `@kern/agent-core` — agent loop: turn runner, context builder, compactor, budgets, retry, event bus
- `@kern/coding-agent` — composition root: `createAgentSession`, `AgentSession` facade
- `@kern/repo-index` — workspace indexing: file records, imports/exports, FileGraph
- `@kern/symbol-store` — lightweight TS/JS symbol extraction and lookup
- `@kern/semantic-search` — repo-aware retrieval + ranking
- `@kern/project-memory` — explicit project notes (decision/architecture/bug/pattern/task)
- `@kern/cli` — CLI entry point: flags, print mode, TUI bootstrap, RPC mode, config validation
- `@kern/tui` — interactive terminal UI: transcript, tool cards, approval dialog, slash commands

### Key features

- Interactive TUI by default on TTY terminals (streaming responses, collapsible tool details, session sidebar)
- Session management via `/session` (list/switch/rename/create/export)
- Tool execution with policy and approvals (read, write, edit, bash)
- Local session persistence (JSONL session history, resume/switch/export)
- Model-provider flexibility through OpenAI-compatible adapter and model discovery/config flow
- Cost/token budgeting (maxCost, maxInputTokens, maxOutputTokens, maxTotalTokens)
- Safety modes (strict/balanced/restricted/autonomous) with B/A key switching
- Approval pattern memory ("always allow this pattern")
- `.agentignore` support for path exclusion
- YAML hook config + hooks.d/ directory support
- JSON-RPC mode (`--rpc`), config validation (`--validate-config`), config override (`--config`)
- Server hardening: env sanitization, sandbox opt-in with plain-spawn fallback
