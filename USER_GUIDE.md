# Kern TUI User Guide

This guide explains how to use **Kern’s interactive terminal UI (TUI)** for day-to-day coding and workspace tasks.

## Starting the TUI

- Start Kern in an interactive terminal (TTY). Kern opens the TUI by default in interactive terminals.
- When the TUI opens, you’ll see a transcript area, a prompt editor at the bottom, and a status/activity bar.
- On wide terminals, a right-side session panel shows live session/model/usage information.

> Tip: If you provide an initial prompt when launching Kern, it is sent as the first message in the TUI.

## Basics

### Sending messages
- Type your request in the prompt editor and press **Enter** to send.
- Press **Shift+Enter** to insert a new line.
- Use **Tab** for autocomplete (slash commands and file paths).

### While Kern is working
- The activity/status area shows what Kern is doing (thinking, responding, running tools, compacting, etc.).
- You can keep typing; plain text messages may be queued while a turn is running.
- Press **Esc** or **Ctrl+C** to stop the current run (behavior depends on state).

### Transcript and readability
- Responses stream into the transcript.
- **Thinking** and **tool** blocks are collapsible to reduce noise.
  - Running states are shown while active.
  - Click a block header to expand/collapse details (when your terminal supports mouse input).
- Tool results (including edits/writes and diffs) may be shown in collapsible output sections.

## Slash commands

Use `/help` in the TUI to see available commands.

### Session management (`/session`) — single command
`/session` is the command for managing sessions in the TUI.

- **`/session`**: open the session management menu
  - Switch session
  - Rename session
  - New session
  - Session info (ID, name, model, workspace path, saved session path)
  - Export transcript
- **Subcommands**
  - `/session switch` or `/session list`: pick another saved session
  - `/session rename [name]`: rename the current session
  - `/session new`: start a fresh session
  - `/session info` (aliases: `/session id`, `/session path`, `/session current`): show current session details
  - `/session export [file]`: export the transcript to Markdown

**Loading a selected session:** when you choose a session from the picker, Kern loads it from its **saved session file path** and restores that session’s history/context in the TUI.

> Tip: The right-side session panel shows the current session ID. `/session info` shows the saved session path/ID.

### Models and providers
- **`/model`**: pick/switch the active model (from configured/discovered models).
- **`/connect`**: connect or set up/re-auth a provider (guided flow).
- **`/keys`**: re-auth/test credentials for the current provider.

### Editing and history
- **`/undo`**: undo file changes from the last agent turn (**best-effort**, git workspace snapshots).
- **`/redo`**: redo previously undone file changes (**best-effort**).
- **`/export [file]`**: export the transcript to Markdown.
- **`/clear`**: clear the visible transcript.
- **`/new`**: start a fresh session.

### Inspection and runtime
- **`/safety`**: pick active safety mode (`strict`, `balanced`, `restricted`, `autonomous`).
- **`/diff`**: show a quick working-tree review (status and diff stats).
- **`/budget [field=value]`**: show usage, limits, and timing, or configure session cost/token limits.
- **`/compact`**: manually compact/summarize history when available.
- **`/branch`**: record a branch summary on the active branch.
- **`/quit`** (or `/exit`): exit the TUI.

## Prompt shortcuts

- **`@path/to/file`**: mention a file to include its contents in context (best-effort; large/binary/outside-workspace files may be skipped or handled specially).
- **`!command`**: run a shell command in shell mode. Kern runs the command and then uses the output in the conversation/response flow.
- **Autocomplete**: press **Tab** while typing `/commands` or file paths.

## Approvals and safety

Kern may ask for approval before running sensitive actions (for example writes or command execution).

- Approval dialogs are **fail-closed**: cancel/escape/abort denies the action.
- Options typically include allowing **once**, allowing for the **session** (for that tool/action scope), or **denying**.
- Destructive actions may be highlighted with warnings, but warnings are heuristic—review carefully.
- In approval dialogs and pickers, keyboard navigation is always supported; mouse click support depends on your terminal and UI environment.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Enter | Send prompt |
| Shift+Enter | New line in editor |
| Tab | Autocomplete |
| Esc | Stop current run / cancel dialog / clear editor (context-dependent) |
| Ctrl+C | Stop current run, or exit flow when idle (double-press behavior may apply) |
| Ctrl+D | Exit when editor is empty (double-press behavior may apply) |
| Ctrl+Q | Clear queued messages |
| Ctrl+S | Stash/restore draft text |
| Ctrl+R | Prompt history search |
| Ctrl+F | Transcript text search (shows matching lines/snippets) |
| Ctrl+L | Refresh/render UI |
| Ctrl+W | Copy editor line to kill ring |
| Ctrl+Y | Paste from kill ring |
| Shift+Tab | Toggle approval mode (when available) |
| Shift+B / Shift+A | Cycle safety mode tighter / looser |
| Backspace (empty editor) | Remove last queued message |

> Shortcuts and mouse behavior can vary slightly depending on terminal support.

## Right-side session panel (wide terminals)

When there is enough horizontal space, the TUI shows a session/info panel with best-effort live data, such as:
- **Session**: model, session ID/name, mode/state, workspace
- **Usage**: context usage, API input/output tokens (when reported), turns, tool calls, wall time, queue
- **Budget limits**: configured runtime limits (if available)
- **Models used**: models used in the session (best-effort/session-scoped tracking)

The panel sections may be collapsible and scroll independently.

## Tips and limitations

- **Mouse support:** clicking headers/controls depends on terminal mouse reporting; keyboard controls are the reliable fallback.
- **Undo/redo:** best-effort for file changes in git workspaces at turn boundaries; it does not undo external side effects.
- **Token stats:** input/output token counts are shown when usage events are reported by the runtime/model; otherwise they may remain `0`.
- **Transcript search:** finds and shows matching transcript lines/snippets but may not auto-scroll the live transcript view.
- **Session persistence:** sessions are saved so you can continue later; use `/session` to inspect/switch/load saved sessions from their stored paths.
- **Long sessions:** the UI may prune older transcript content for responsiveness/performance while preserving session state.
