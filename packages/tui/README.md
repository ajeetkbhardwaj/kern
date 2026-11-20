# @kern/tui — Interactive Terminal UI

Interactive terminal UI for the Kern coding agent. Built on `@earendil-works/pi-tui`.

## Features

### Core Interface
- **Fullscreen TUI** with alt-screen scrolling, scroll-to-bottom indicator (`↑ scrolled` / `Jump to bottom`), and mouse wheel support
- **Session history replay**: `--resume`, `/session switch`, and `/fork` replay past turns, collapsible thinking blocks, paired tool cards, and compaction/branch checkpoints into the transcript
- **Collapsible thinking**: reasoning/thinking shown as `[+] thinking` / `[-] thinking` (click header or press `Ctrl+O` to toggle)
- **Collapsible tool cards**: in-flight/success/failure tool status with `[+]`/`[-]` output toggle and diff highlighting for `edit`/`write`
- **Command palette**: press `Ctrl+P` (or `/palette`) to browse and execute any command or skill
- **Live transcript search**: press `Ctrl+F` / `Ctrl+Shift+F` (or `/search [query]`) for inline highlighting and viewport auto-scroll (`Enter`/`F3` next, `Shift+Enter`/`Shift+F3` previous, `Esc` close)
- **Activity line** with spinner showing current agent phase (`model: thinking`, `tool: ...`, `compacting context`, `ready`)
- **Status bar & collapsible sidebar** with model, approval mode, reasoning effort (`think`), safety mode, context %, scroll state, and per-model cost/token usage
- **Docked prompt editor** with autocomplete for slash commands, `/skill:<name>` skills, and `@file` paths

### Slash Commands
| Command | Description |
|---------|-------------|
| `/help` | Show commands and keybindings |
| `/palette` | Open interactive command palette (`Ctrl+P`) |
| `/search [query]` / `/find [query]` | Live transcript search (`Ctrl+F`) |
| `/model` | Pick provider/model (configured + live, authenticated first) |
| `/thinking [off\|low\|medium\|high]` | Pick or set reasoning effort |
| `/safety` | Pick safety mode (`strict`/`balanced`/`restricted`/`autonomous`) |
| `/budget [field=val ...]` | View usage or update live session budget limits (`maxCost=0.05`, `0` resets) |
| `/session` | Manage sessions (`list\|switch\|fork\|rename\|new\|info\|id\|export`) |
| `/fork` | Fork the active conversation into a new session and switch into it |
| `/login [provider]` | Log in to an LLM provider or add a custom endpoint |
| `/logout [provider\|--all]` | Clear saved credentials for a provider from `~/.kern/auth.json` |
| `/mcp` | Manage MCP servers & external tool connectors |
| `/keys` | Re-auth current provider |
| `/skill:<name>` | Invoke a workspace/user skill prompt directly |
| `/expand` / `/collapse` | Expand or collapse all thinking & tool cards (`Ctrl+O`) |
| `/undo` / `/redo` | Undo/redo file changes from the last turn (git workspaces) |
| `/compact` | Manual compaction checkpoint |
| `/diff` | Show working-tree git status and diff stats |
| `/branch` | Record a branch summary |
| `/export [file]` | Export transcript to Markdown |
| `/new` | Start fresh session |
| `/clear` | Clear transcript |
| `/quit` | Exit |

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Enter` | Submit prompt |
| `Shift+Enter` | Newline |
| `Tab` | Autocomplete commands, `/skill:*`, `@files` |
| `Ctrl+P` | Open command palette |
| `Ctrl+F` / `Ctrl+Shift+F` | Live viewport search |
| `Ctrl+O` | Expand / collapse all thinking & tool cards |
| `Ctrl+R` | Prompt history picker |
| `Ctrl+S` | Stash/restore draft |
| `Ctrl+Q` | Clear queued prompts |
| `Ctrl+L` | Force re-render |
| `Ctrl+W` / `Ctrl+Y` | Copy editor line to kill ring / paste from kill ring |
| `Shift+Tab` | Cycle approval mode (`ask` / `auto-edits` / `auto`) |
| `Shift+A` / `Shift+B` | Loosen / tighten safety mode |
| `Ctrl+C` / `Ctrl+D` | Stop turn / double-press to exit |
| `Esc` | Cancel dialog / clear editor / stop turn |

## Installation

```bash
npm install @kern/tui
# requires @earendil-works/pi-tui@1.1.0
```

## Testing

```bash
npm test --workspace=@kern/tui
```

## Files

```
src/
  tui.ts          # Main interactive loop (runInteractive)
  helpers.ts      # Pure command definitions, replay, export, budget & state helpers
  components.ts   # Box, StatusBar, ToolCard, CollapsibleText, SidebarPanel, Rule
  theme.ts        # OKHSL palette, markdown/select/editor themes
  autocomplete.ts # CombinedAutocompleteProvider wrapper
  index.ts        # Barrel export
test/
  tui.test.ts     # Unit tests against exported helpers, components, and search matcher
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