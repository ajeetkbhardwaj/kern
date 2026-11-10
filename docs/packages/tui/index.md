# @kern/tui — Interactive Terminal UI

> **Package:** `packages/tui`
> **Subproject:** `docs/packages/tui/index.md`

---

## 1. First-Principle Question

How does the user interact with Kern in a full-screen terminal interface — streaming answers, tool cards, approval dialogs, model picker, session switching, history, and compaction — while observing agent events without coupling to the agent core internals?

---

## 2. Mental Model

`@kern/tui` is an interactive orchestrator built on `@earendil-works/pi-tui`. It observes `AgentEvent`s from the `AgentSession` and renders them into a transcript with streaming Markdown, reasoning blocks, tool cards (with `◈` in-flight, `✔` done, `✖` failed), a live activity line, a status bar (model, mode, context %, turns/calls/wall time), and a docked prompt editor.

The TUI acts **only via `AgentSession`** — it never touches agent-core internals. It provides slash commands (`/help`, `/model`, `/switch`, `/connect`, `/keys`, `/new`, `/compact`, `/diff`, `/export`, `/clear`, `/quit`, `/name`, `/branch`, `/budget`), an approval dialog (Yes once / Yes session / No, with danger styling for destructive patterns), a model picker (configured + live models, sorted with authenticated first), a connect wizard (preset → key → test → model → save), re-auth (`/keys`), session switcher, transcript export, and `@mention` file expansion.

The layout is Pi-style: scrollable transcript on top, a dock at the bottom with queue panel, toast line, activity line, editor, and status bar. Overlays are centered dialogs with an `OverlayDialog` wrapper that forwards keys to the interactive child (since pi-tui focuses the overlay root).

---

## 3. Architecture Diagram

```mermaid
flowchart TD
    User["User"] --> Editor["Editor: prompt input"]
    Editor -->|submit text| Session["AgentSession.prompt(text)"]
    Session -->|AgentEvent| Subscribe["session.subscribe"]
    Subscribe --> Render["TUI renders events"]
  
    Render --> Transcript["ScrollView transcript: user/assistant/tool blocks"]
    Render --> Activity["Activity line: thinking/writing/compressing/ready"]
    Render --> ToolCards["Tool cards: in flight done failed"]
    Render --> StatusBar["Status bar: model, mode, ctx %, turns/calls/time"]
    Render --> Toasts["Toast line: transient notices"]
  
    Editor -->|slash command| Commands["Slash commands: /help /model /switch /connect /keys /new /compact /diff /export /clear /quit /name /branch /budget"]
    Commands -->|/model| ModelPicker["Model picker overlay"]
    Commands -->|/connect| ConnectWizard["Connect wizard: preset/key/test/model/save"]
    Commands -->|/keys| Reauth["Re-auth dialog"]
    Commands -->|/compact| Compact["Session.compact()"]
    Commands -->|/export| Export["Transcript export to Markdown"]
    Commands -->|/switch| SessionSwitcher["Session switcher overlay"]
  
    Session -->|requestApproval| ApprovalDialog["Approval overlay: once/session/no"]
    ApprovalDialog -->|result| Session
  
    Editor -->|@mention| MentionExpansion["@file expansion: read file, inject content"]
  
    subgraph Layout
    VStack["VStack: transcript (grow) + dock (auto)"]
    Dock["Dock: queue + toast + activity + editor + status"]
    end
  
    Transcript -.-> VStack
    Dock -.-> VStack
```

---

## 4. Components

### `runInteractive(options)` (`tui.ts`)

Main entry point. Sets up:

- `TuiAltScreen` + `ProcessTerminal` (fullscreen).
- `Container` transcript, `StatusBar`, `Editor` with autocomplete.
- `ScrollView` for transcript; `VStack` dock layout.
- Event subscription (`session.subscribe`) dispatching to renderers.

Event → render mapping:

| Event                         | Render Action                                       |
| ----------------------------- | --------------------------------------------------- |
| `text_delta`                | Append to streaming Markdown block                  |
| `reasoning_delta`           | Append to reasoning block (muted text)              |
| `message_end`               | Close assistant/reasoning blocks, settle tool cards |
| `tool_execution_start`      | Show tool card (`◈ running`)                     |
| `tool_execution_update`     | Append output to tool card                          |
| `tool_execution_end`        | Finish tool card (`✔` or `✖`)                 |
| `auto_compaction_start/end` | Toast "compacting context…" / "context compacted"  |
| `auto_retry_start`          | Toast "retry N (reason) in Xms"                     |
| `agent_error`               | Error line; if `E_MODEL_AUTH`, show auth card     |
| `agent_settled`             | Settle cards, set activity "ready"                  |

### Slash Commands

| Command             | Action                                                         |
| ------------------- | -------------------------------------------------------------- |
| `/help`           | Show command list                                              |
| `/name`           | Rename session                                                 |
| `/model`          | Model picker overlay                                           |
| `/switch`         | Session switcher overlay                                       |
| `/connect`        | Connect wizard (preset → key → test → save)                 |
| `/keys`           | Re-auth current provider                                       |
| `/new`            | New session                                                    |
| `/export`         | Export transcript to Markdown                                  |
| `/clear`          | Clear transcript                                               |
| `/quit`/`/exit` | Exit                                                           |
| `/compact`        | Manual compaction                                              |
| `/diff`           | `git diff --stat; git status --short` via `callToolAsUser` |
| `/budget`         | Show usage/status                                              |
| `/branch`         | Record branch summary                                          |

### Approval Dialog

When policy demands approval, a centered overlay shows:

- Prompt text (warn/error style).
- Arguments detail (truncated at 800 chars).
- Danger warning if destructive patterns matched (`rm -rf`, `git reset --hard`, `mkfs`, `dd`, `shutdown`, `DROP TABLE`, etc.).
- Choices: "Yes, run once" / "Yes, always allow [tool] (session)" / "No".
- Pending approvals are fail-closed (denied) on abort/exit.

### Model Picker

Shows configured + live models from `discoverModels`, sorted with authenticated first. Marks current and last-used. Selecting a model calls `createAdapterFor`, `session.setModel`, and `recordLastUsed`.

### Connect Wizard

5-step flow: preset picker → custom name/URL → key entry (enter/env/command/none) → test (`testProvider`) → model selection → save as default or not. Literal keys saved to `auth.json` via `saveAuthKey`; provider saved to `models.json` via `saveProviderToUserFile`.

### @Mention Expansion

`@path/to/file` in the editor is expanded to `<file path="...">\ncontent\n</file>` before sending. Binary files and files > 40KB are handled (truncated or sent literally).

### Layout Components (`components.ts`)

| Component     | Purpose                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `Box`       | Bordered container with title, padding, mood (default/info/accent/error/success) |
| `StatusBar` | Single-line muted status segments                                                |
| `ToolCard`  | Tool execution card with in-flight/done/failed states and output tail            |
| `Rule`      | Horizontal rule                                                                  |

### Theming (`theme.ts`)

Pi dark palette (`okhsl` colors): text, muted, violet (accent), blue, green, red, yellow, warmString. Markdown theme, select theme, editor theme, and code highlighting (keywords, functions, strings, numbers, types, comments).

---

## 5. Failure Modes

| Failure                          | Consequence                                | Safeguard                                                 |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Non-TTY                          | Error "Interactive mode requires a TTY"    | CLI falls back to print mode                              |
| Model discovery fails            | Error toast; no model picker               | User can still use `--model` / `--provider` flags     |
| Model switch fails               | Error toast; current model unchanged       | `setModel` failure caught and displayed                 |
| Connect wizard fails at any step | "Connect cancelled" toast; nothing written | Esc cancels at every step; partial state discarded        |
| Approval dialog aborted          | Denied (fail-closed)                       | `pendingApprovals` resolved with `null` on abort/exit |
| Export path escapes workspace    | Refused with error                         | Path validation before write                              |
| `@mention` file missing        | Sent literally; info toast                 | Try/catch on stat/read; missing tracked                   |

---

## 6. Design Rules

1. TUI acts only via `AgentSession` — never touches agent-core internals.
2. Events are the observation surface; `subscribe()` dispatches all rendering.
3. Layout: scrollable transcript + docked editor/status (Pi-style).
4. Overlays forward keys to interactive children via `OverlayDialog`.
5. Approvals are fail-closed (deny on abort/exit/non-response).
6. Destructive patterns get danger styling in approval dialogs.
7. Secrets are never echoed (API key prompts don't echo back).

---

## 7. Checkpoint

- [ ] `runInteractive` sets up fullscreen TUI with transcript, dock, editor, status bar
- [ ] Event → render mapping for all `AgentEvent` types
- [ ] Slash commands: /help /model /switch /connect /keys /new /compact /diff /export /clear /quit /name /branch /budget
- [ ] Approval dialog with once/session/no choices and danger styling
- [ ] Model picker (configured + live, authenticated first)
- [ ] Connect wizard (preset → key → test → model → save)
- [ ] Re-auth (`/keys`) with test-first flow
- [ ] @mention file expansion
- [ ] Pi dark theme with Markdown/select/editor themes
