# @kern/tui — Interactive Terminal UI

Interactive terminal UI for the Kern coding agent. Built on `@earendil-works/pi-tui`.

## Features

### Core Interface
- **Fullscreen TUI** with native scrollback (alternate screen)
- **Clean transcript flow** (no per-message bounding boxes): lightweight labels for user/assistant/thinking with streamed Markdown responses
- **Collapsible thinking**: reasoning/thinking is shown as `[+] thinking` / `[-] thinking` (click header to expand/collapse; content streams while collapsed)
- **Collapsible tool cards**: in-flight/success/failure tool status with `[+]`/`[-]` output toggle (click header to expand/collapse tool output)
- **Activity line** with spinner showing agent phase (thinking/writing/compressing/ready)
- **Status bar** with model, mode, context %, turns/calls/wall-time
- **Docked prompt editor** with autocomplete (slash commands, file paths)
- **Toast line** for transient notices (auto-expire)
- **Batched rendering and transcript pruning** to keep scrolling/responsiveness smooth in longer sessions

### Slash Commands
| Command | Description |
|---------|-------------|
| `/help` | Show command list |
| `/session` | Session management: menu and subcommands (`list|switch|rename|new|info|id|export`) |
| `/model` | Pick provider/model (configured + live, authenticated first) |
| `/connect` | Connect/re-auth provider (5-step wizard) |
| `/keys` | Re-auth current provider (test-first) |
| `/undo` | Undo file changes from the last agent turn (best-effort, git workspace) |
| `/redo` | Redo previously undone file changes (best-effort, git workspace) |
| `/new` | Start fresh session |
| `/export` | Export transcript to Markdown |
| `/clear` | Clear transcript |
| `/compact` | Manual compaction |
| `/diff` | Show working-tree review (status, unstaged/staged diff stats) |
| `/budget` | Show usage, limits, and timing |
| `/branch` | Record branch summary |
| `/quit` | Exit |

### Approval System
- **Three choices**: Yes once / Yes session / No
- **Danger styling** for destructive patterns (`rm -rf`, `git reset --hard`, `mkfs`, `dd`, `shutdown`, `DROP TABLE`, etc.)
- **Fail-closed** on abort/exit/non-response
- Arguments truncated at 800 chars with expand option

### Model Management
- **Model picker**: Configured + live-discovered models, sorted authenticated first
- **Hot swap**: Switch models mid-session without losing context
- **Last-used tracking** with visual indicator
- **Connect wizard**: Preset → key → test → model → save (Esc cancels at any step)
- **Re-auth (`/keys`)**: Test-first flow, only prompts on 401/403

### Session Features
- **Session management (`/session`)**: menu and subcommands for switching, renaming, creating, inspecting (ID/name/path/model), and exporting sessions
- **Session switching** (`/session switch` or `/session list`) with history preserved; selected sessions are loaded from their saved session file path
- **Session info** (`/session info|id`) shows current session ID/path (usable with `kern --session <id|path>`)
- **Fork/branch** from any turn
- **Transcript export** to Markdown
- **State persistence** across restarts (draft text, recent prompts, queue, stash)
- **History search** (Ctrl+F match picker; Ctrl+R prompt history)
- **Draft stash/restore** (Ctrl+S)
- **Undo/redo file changes** (`/undo`, `/redo`) across agent turns (best-effort snapshots of changed/untracked files in git workspaces)

### Input & Editing
- **@mention expansion**: `@path/to/file` → `<file>content</file>` (binary/large file handling)
- **Shell mode**: `!command` runs via bash tool, output injected into context
- **Autocomplete**: Slash commands + file paths
- **Invisible char detection** (ZWNJ, bidi controls)

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| Enter | Submit prompt |
| Shift+Enter | Newline |
| Tab | Autocomplete |
| Ctrl+C | Abort turn / exit (double) |
| Ctrl+D | Exit (double) |
| Ctrl+Q | Clear queue |
| Ctrl+S | Stash/restore draft |
| Ctrl+R | History search |
| Ctrl+L | Force render |
| Ctrl+W | Copy editor line to kill ring |
| Ctrl+Y | Paste from kill ring |
| Shift+Tab | Toggle approval mode |
| Esc | Cancel dialog / clear editor / stop turn |
| Backspace (empty) | Remove last queued item |

### Production Features
- **Window resize handling** (SIGWINCH) with debounced re-render
- **Error boundaries** — event handler errors caught, TUI never crashes
- **Batched rendering** (~60fps) and transcript pruning for smoother streaming/scrolling
- **Adaptive overlays** — full-width on narrow terminals (<80 cols)
- **Session state persistence** — `~/.kern/tui-state.json` auto-save/load
- **Kill ring** — Emacs-style Ctrl+W/Ctrl+Y copy/paste within TUI
- **Destructive pattern detection** — 10 regex patterns for dangerous commands
- **Mouse-click toggles** for collapsible thinking/tool output (when terminal mouse events are supported)

### Theming
- **OKHSL dark palette** (text, muted, violet, blue, green, red, yellow, warmString)
- **Markdown theme** (headings, links, code, quotes, lists, HR)
- **Select list theme** (selection, description, scroll info)
- **Editor theme** (border, nested select)
- **Syntax highlighting** (keywords, functions, strings, numbers, types, comments)
- **NO_COLOR** support

## Installation

```bash
pnpm add @kern/tui
# or
npm install @kern/tui
# requires @earendil-works/pi-tui@1.1.0
```

## Usage

```typescript
import { runInteractive } from "@kern/tui";
import { createAgentSession } from "@kern/coding-agent";

const { session, manager } = await createAgentSession({
  cwd: process.cwd(),
  // ... options
});

await runInteractive({
  session,
  manager,
  newSession: () => createAgentSession({ cwd: process.cwd() }),
  modelsFile: await loadModelsFile(process.cwd()),
  cwd: process.cwd(),
  approvalHook: { current: askApproval },
});
```

## Architecture

```
runInteractive(options)
  ├── TuiAltScreen + ProcessTerminal (fullscreen)
  ├── Container transcript (ScrollView with follow-end)
  ├── VStack dock: queue → toast → activity → editor → status
  ├── Editor with CombinedAutocompleteProvider
  └── Event subscription → renderers
```

Event → render mapping:
- `text_delta` → streaming Markdown block (assistant label)
- `reasoning_delta` → collapsible thinking block (`CollapsibleText`)
- `tool_execution_start/update/end` → collapsible `ToolCard` (◈/✔/✖ with output toggle)
- `auto_compaction_start/end` → toasts
- `auto_retry_start` → toast with attempt/reason/delay
- `agent_error` → error line, auth card on E_MODEL_AUTH
- `agent_settled` → settle cards, activity "ready"

## Testing

```bash
pnpm test
# 35 tests covering:
# - State persistence (save/load draft, prompts, queue, stash)
# - summarizeArgs (path, command, truncation, edge cases)
# - Adaptive overlay options (narrow/medium/wide terminals)
# - Kill ring (push, peek, accumulate, rotate)
# - INVISIBLE_RE (ZWNJ, bidi controls)
# - DESTRUCTIVE_PATTERNS (10 patterns, positive/negative cases)
```

## Dependencies

- `@earendil-works/pi-tui@1.1.0` — terminal UI primitives
- `@kern/coding-agent` — AgentSession facade
- `@kern/model` — model discovery/adapter
- `@kern/protocol` — shared types/events
- `@kern/session-store` — session persistence

## Files

```
src/
  tui.ts          # Main entry (runInteractive)
  components.ts   # Box, StatusBar, ToolCard, CollapsibleText, Rule, re-exports
  theme.ts        # OKHSL palette, markdown/select/editor themes
  autocomplete.ts # CombinedAutocompleteProvider wrapper
  index.ts        # Barrel export
test/
  tui.test.ts     # Unit tests
```

## State Persistence

Saved to `~/.kern/tui-state.json`:
```json
{
  "draftText": "unsent editor content",
  "recentPrompts": ["prompt1", "prompt2"],
  "stash": "stashed draft",
  "queue": ["queued message"],
  "lastUserPrompt": "last submitted prompt"
}
```

## Key Design Decisions

1. **Pi-tui native scrollback** — no custom buffer, uses terminal alt-screen
2. **Event-driven** — subscribes to `AgentEvent`, never polls
3. **OverlayDialog wrapper** — forwards keys to interactive children (SelectList/Editor)
4. **Fail-closed approvals** — deny on abort/exit/non-TTY
5. **Secrets never echoed** — API key prompts don't echo back
6. **Batched renders and pruning** — smoother streaming/scrolling in long sessions
7. **Adaptive overlays** — 95%/90%/80% width based on terminal columns
8. **State persistence** — auto-save on exit, auto-load on start
9. **Best-effort file undo/redo** — turn-boundary snapshots for changed/untracked files in git workspaces

## Performance

- Batched render scheduling (~60fps) during streaming and frequent UI updates
- Transcript pruning to cap rendered history growth in long sessions
- Virtual scrolling via pi-tui `ScrollView(follow: "end")`
- Collapsible thinking/tool output to reduce on-screen noise (expand on demand)

## Accessibility

- `NO_COLOR` disables all ANSI colors
- High-contrast OKHSL palette
- Text-based UI (screen-reader compatible)
- Keyboard-first navigation

## License

MIT