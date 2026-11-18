/**
 * @kern/tui — interactive orchestrator on @earendil-works/pi-tui.
 *
 * Main-screen renderer (native scrollback), transcript Container, streaming
 * Markdown with syntax highlighting, Editor with slash/file completion,
 * SelectList overlays for approvals / model picker / history, Loader
 * spinner while busy. Observes `AgentEvent`s; acts only via `AgentSession`.
 *
 * pi-tui adaptation notes:
 * - Overlays are shown with `showOverlay(c, {anchor:"center", width:"80%",
 *   maxHeight:"80%"})`, which returns a handle with `.hide()`.
 * - SelectList takes no title and no disabled items: titles render as a
 *   `Text` header above the list, and unavailable options get a suffix with
 *   their selection ignored.
 * - Editor has no onEscape: prompt dialogs emulate Esc-cancel via the
 *   input listener, which runs BEFORE focused components (a handled Esc
 *   returns `{consume:true}` to preempt the dialog's editor).
 * - Input keys reach the focused component; overlay roots are wrapped in a
 *   local `OverlayDialog` that forwards keys to the interactive child.
 */

import { writeFile, readFile, stat, mkdir, unlink, readdir } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { spawn } from "node:child_process";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, loadModelsFile, readLastUsed, recordLastUsed, resolveApiKey, saveAuthKey, saveProviderToUserFile, testProvider, PROVIDER_PRESETS, type ModelsFile, type ProviderConfig } from "@kern/model";
import {
  TuiAltScreen,
  ProcessTerminal,
  Editor,
  SelectList,
  Markdown,
  ScrollView,
  VStack,
  HStack,
  matchesKey,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { KillRing } from "@earendil-works/pi-tui/dist/kill-ring.js";
import { theme, buildMarkdownTheme, buildSelectTheme, buildEditorTheme } from "./theme.js";
import { Box, StatusBar, ToolCard, Rule, SidebarPanel, Container, Text, Spacer, CollapsibleText } from "./components.js";
import { buildAutocomplete } from "./autocomplete.js";
import { homedir } from "node:os";

export interface InteractiveOptions {
  session: AgentSession;
  manager: SessionManager;
  /** Create a fresh session (used by /new). Same options as startup. */
  newSession: () => Promise<{ session: AgentSession; manager: SessionManager }>;
  modelsFile: ModelsFile;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  cwd: string;
  logger?: Logger;
  /** Called by the kernel approval sink. Set by the CLI wiring. */
  approvalHook: { current: ((prompt: string, meta?: { toolName: string }) => Promise<boolean | "session" | string>) | null };
  /** Optional prompt to submit automatically when the TUI starts. */
  initialPrompt?: string;
}

const COMMANDS = [
  { name: "help", description: "show the command list" },
  { name: "session", description: "manage sessions (list/switch/rename/new/info/export)" },
  { name: "model", description: "pick provider/model" },
  { name: "safety", description: "pick safety mode (strict/balanced/restricted/autonomous)" },
  { name: "budget", description: "configure session cost and token limits" },
  { name: "connect", description: "connect or re-auth a provider" },
  { name: "undo", description: "undo file changes from the last turn" },
  { name: "redo", description: "redo previously undone file changes" },
  { name: "new", description: "start a fresh session" },
  { name: "export", description: "export the transcript" },
  { name: "clear", description: "clear the transcript" },
  { name: "quit", description: "exit the session" },
];

const ADVANCED_COMMANDS = {
  compact: "summarize history into a checkpoint",
  diff: "show working-tree changes",
  budget: "show usage, limits, and timing",
  keys: "re-auth the current provider",
  branch: "record a branch summary",
};

const HINTS = "Enter send · Shift+Enter newline · Tab complete · @ files · ! shell · click headers to expand/collapse details · Ctrl+C abort · Shift+B tighter safety · Shift+A looser safety";
const QUICK_HELP = "Quick actions: /model · /safety · /budget · /session · /connect · /undo · /redo · /help";
const MAX_QUEUE = 5;
// Zero-width / bidi / tag invisibles (keeps ZWNJ U+200C for Persian/Indic).
const INVISIBLE_RE = /[​‎‏‪-‮⁠-⁤﻿]/gu;

/**
 * Overlay root: renders a teammate-owned Box, forwards keys/mouse to the
 * interactive child. pi-tui focuses the overlay root component, so without
 * this wrapper keys/clicks would never reach a SelectList/Editor nested inside.
 */
class OverlayDialog implements Component {
  constructor(
    private readonly root: Component,
    private readonly target: Component,
  ) {}
  render(width: number): string[] {
    return this.root.render(width);
  }
  handleInput(data: string): void {
    this.target.handleInput?.(data);
  }
  handleMouse(event: any): any {
    const targetHandler = (this.target as any).handleMouse?.bind(this.target);
    if (targetHandler) {
      const res = targetHandler(event);
      if (res) return res;
    }
    const rootHandler = (this.root as any).handleMouse?.bind(this.root);
    if (rootHandler) return rootHandler(event);
    return undefined;
  }
  invalidate(): void {
    this.root.invalidate();
  }
}

const OVERLAY_OPTS = { anchor: "center" as const, width: "80%" as const, maxHeight: "80%" as const };

// Compute adaptive overlay options based on current terminal width.
// Narrow terminals (<100 cols): full width, taller. Wide: centered 80%.
function getOverlayOpts(): { anchor: "center"; width: "80%" | "90%" | "95%"; maxHeight: "80%" | "85%" | "90%" } {
  const cols = process.stdout.columns ?? 80;
  if (cols < 80) return { anchor: "center", width: "95%", maxHeight: "90%" };
  if (cols < 120) return { anchor: "center", width: "90%", maxHeight: "85%" };
  return OVERLAY_OPTS;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  const tui = new TuiAltScreen(new ProcessTerminal());
  const transcript = new Container();

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const handleResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try { applyLayout(); } catch { /* best-effort */ }
      try { updateSidebar(); } catch { /* best-effort */ }
      tui.requestRender();
    }, 50);
  };
  if (process.stdout.isTTY) {
    process.on("SIGWINCH", handleResize);
  }
  const statusBar = new StatusBar();
  const editor = new Editor(tui, buildEditorTheme(), { autocompleteMaxVisible: 8 });
  const autocomplete = buildAutocomplete(COMMANDS, cwd);
  editor.setAutocompleteProvider(autocomplete);

  let busy = false;
  let abort: AbortController | null = null;
  let exiting = false;
  let unsubscribe: (() => void) | null = null;
  let activity = "ready";
  let queue: string[] = [];
  let lastExitAttempt = 0;
  let stash = "";
  const recentPrompts: string[] = [];
  let lastUserPrompt = "";
  let authOverlayOpen = false;
  /** Assigned after runCommand/runTurn exist; subscribe() may fire earlier. */
  let handleAuthError: (message: string) => void = () => {};
  /** Open text-prompt dialog (Esc cancels via the input listener). */
  let promptDialog: { cancel: () => void } | null = null;
  /** Session state persisted across TUI restarts (draft text, recent prompts, queue). */
  let draftText = "";
  let searchQuery: string = "";
  let searchResults: number[] = [];
  let searchActiveIndex = 0;
  let searchOpen = false;
  /** Transcript lines for search (plain text, no ANSI). */
  const transcriptLines: string[] = [];
  /** Add line to transcript history for search. */
  const addTranscriptLine = (text: string) => {
    transcriptLines.push(text.replace(/\x1b\[[0-9;]*m/g, ""));
    if (transcriptLines.length > 10000) transcriptLines.shift();
  };
  /** Empty-state suggestion overlay state (digits 1-3 fill, never send). */
  let suggestionsOpen = false;
  let suggestionPick: ((value: string) => void) | null = null;
  const SUGGESTION_DIGITS = ["1", "2", "3"] as const;

  // Kill ring for Emacs-style kill/yank (copy/paste within TUI).
  const killRing = new KillRing();

  // State saved to ~/.kern/tui-state.json alongside the kernel session.
  const STATE_FILE = join(homedir(), ".kern", "tui-state.json");

  const saveState = async (): Promise<void> => {
    try {
      await mkdir(dirname(STATE_FILE), { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify({
        draftText,
        recentPrompts,
        stash,
        queue,
        lastUserPrompt,
      }), "utf8");
    } catch { /* best-effort */ }
  };

  const loadState = async (): Promise<void> => {
    try {
      const raw = await readFile(STATE_FILE, "utf8");
      const data = JSON.parse(raw);
      if (typeof data === "object" && data !== null) {
        if (typeof data.draftText === "string") draftText = data.draftText;
        if (Array.isArray(data.recentPrompts)) recentPrompts.push(...data.recentPrompts);
        if (typeof data.stash === "string") stash = data.stash;
        if (Array.isArray(data.queue)) queue.push(...data.queue);
        if (typeof data.lastUserPrompt === "string") lastUserPrompt = data.lastUserPrompt;
      }
    } catch { /* best-effort */ }
  };
  void loadState().then(() => {
    if (draftText) editor.setText(draftText);
  });

  // Batched rendering: accumulate render requests and flush at ~60fps
  // to avoid layout thrashing during high-frequency streaming/scrolling.
  let renderBatched = false;
  const requestRender = () => {
    if (!renderBatched) {
      renderBatched = true;
      setTimeout(() => {
        renderBatched = false;
        tui.requestRender();
      }, 16);
    }
  };
  const requestRenderBatched = requestRender;
  const MAX_TRANSCRIPT_CHILDREN = 300;
  const pruneTranscript = () => {
    const children = (transcript as any).children as unknown[] | undefined;
    if (!Array.isArray(children)) return;
    const excess = children.length - MAX_TRANSCRIPT_CHILDREN;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const first = children[0];
      if (!first) break;
      transcript.removeChild(first as any);
    }
  };

  // Toasts live one row above the queue panel: transient notices that
  // auto-expire without disturbing the transcript. Errors stay persistent
  // via err()/say() and never route here.
  const toastLine = new Text("", 0, 0);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastToken = 0;
  const toast = (text: string) => {
    const token = ++toastToken;
    toastLine.setText(theme.muted(`● ${text}`));
    tui.requestRender();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (token !== toastToken || exiting) return;
      toastLine.setText("");
      tui.requestRender();
    }, 4000);
  };

  // Live agent phase indicator pinned above the editor so the user can see
  // what the agent is doing while it writes, thinks, or calls tools.
  const activityLine = new Text(theme.muted("ready"), 0, 0);
  const ACTIVITY_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦"] as const;
  let activityDots = 0;
  let activityPulse: ReturnType<typeof setInterval> | null = null;
  const renderActivityLine = () => {
    const label = activity || "ready";
    const frame = ACTIVITY_SPINNER[activityDots % ACTIVITY_SPINNER.length] ?? "⠦";
    const suffix = label === "ready" ? "" : "...";
    activityLine.setText(theme.muted(`${frame} ${label}${suffix}`));
    tui.requestRender();
  };
  const setActivity = (label: string) => {
    if (activity === label && activityPulse) return;
    activity = label;
    activityDots = 0;
    if (label === "ready") {
      if (activityPulse) clearInterval(activityPulse);
      activityPulse = null;
      activityLine.setText(theme.muted("ready"));
      if (typeof updateSidebar === "function") updateSidebar();
      tui.requestRender();
      return;
    }
    renderActivityLine();
    if (activityPulse) clearInterval(activityPulse);
    activityPulse = setInterval(() => {
      activityDots = (activityDots + 1) % ACTIVITY_SPINNER.length;
      renderActivityLine();
    }, 180);
    if (typeof updateSidebar === "function") updateSidebar();
  };

  // Queue visibility: numbered list above the editor. Reads `queue` live;
  // callers just mutate the array and request a render.
  const queuePanel: Component = {
    render(_width: number): string[] {
      if (queue.length === 0) return [];
      const rows: string[] = [
        theme.muted(`queued (${queue.length}/${MAX_QUEUE}) · Ctrl+Q clears · ⌫ on empty prompt removes last`),
      ];
      queue.forEach((q, i) => {
        const oneLine = q.replace(/\s+/g, " ").trim();
        const short = oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
        rows.push(theme.muted(`  ${i + 1}. ${short}`));
      });
      return rows;
    },
    invalidate(): void {},
  };
  const renderQueue = () => {
    updateSidebar();
    tui.requestRender();
  };

  // --- best-effort file undo/redo (workspace snapshots around turns) -----------------------
  type FileSnapshot = Map<string, Uint8Array | null>; // relative path -> bytes, null means deleted/missing
  interface FileHistoryEntry {
    label: string;
    before: FileSnapshot;
    after: FileSnapshot;
  }
  const undoStack: FileHistoryEntry[] = [];
  const redoStack: FileHistoryEntry[] = [];
  const MAX_UNDO = 20;
  const MAX_SNAPSHOT_FILE_BYTES = 2_000_000;
  let pendingHistoryBefore: FileSnapshot | null = null;
  let pendingHistoryLabel = "";
  let fileHistorySupported: boolean | null = null;

  const runGit = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveRun) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => resolveRun({ code: 1, stdout: "", stderr: String(e) }));
      child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    });

  const runGitBuffer = (args: string[]): Promise<{ code: number; stdout: Uint8Array }> =>
    new Promise((resolveRun) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      child.on("error", () => resolveRun({ code: 1, stdout: new Uint8Array() }));
      child.on("close", (code) => resolveRun({ code: code ?? 1, stdout: new Uint8Array(Buffer.concat(chunks)) }));
    });

  const readHeadVersion = async (relPath: string): Promise<Uint8Array | null | undefined> => {
    // Returns bytes if file exists in HEAD, null if not in HEAD, undefined on error/too large/unsupported.
    try {
      const exists = await runGit(["cat-file", "-e", `HEAD:${relPath}`]);
      if (exists.code !== 0) return null;
      const out = await runGitBuffer(["show", `HEAD:${relPath}`]);
      if (out.code !== 0) return undefined;
      if (out.stdout.byteLength > MAX_SNAPSHOT_FILE_BYTES) return undefined;
      return out.stdout;
    } catch {
      return undefined;
    }
  };

  const getWorkspaceChangedPaths = async (): Promise<string[] | null> => {
    const res = await runGit(["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (res.code !== 0) return null;
    const out = res.stdout;
    const paths = new Set<string>();
    for (let i = 0; i < out.length; ) {
      const code = out.slice(i, i + 2);
      i += 3; // "XY "
      if (i > out.length) break;
      const nul = out.indexOf("\0", i);
      if (nul < 0) break;
      let path = out.slice(i, nul);
      i = nul + 1;
      // renames/copies: "R  old\0new\0" or "C  old\0new\0"
      if ((code.startsWith("R") || code.startsWith("C")) && i <= out.length) {
        const nul2 = out.indexOf("\0", i);
        if (nul2 >= 0) {
          path = out.slice(i, nul2); // new path
          i = nul2 + 1;
        }
      }
      path = path.replace(/\\/g, "/");
      if (path) paths.add(path);
    }
    return [...paths].sort();
  };

  const snapshotWorkspaceFiles = async (paths: string[]): Promise<FileSnapshot> => {
    const snap: FileSnapshot = new Map();
    for (const rel of paths) {
      if (!rel || rel.includes("\0")) continue;
      const abs = resolve(cwd, rel);
      const relNorm = relative(cwd, abs).replace(/\\/g, "/");
      if (!relNorm || relNorm.startsWith("..")) continue;
      try {
        const st = await stat(abs);
        if (!st.isFile()) {
          snap.set(relNorm, null);
          continue;
        }
        if (st.size > MAX_SNAPSHOT_FILE_BYTES) {
          // too large to snapshot safely; mark as unsupported by omitting? keep placeholder
          // we cannot restore reliably, so skip this path from snapshot tracking
          continue;
        }
        const data = await readFile(abs);
        snap.set(relNorm, new Uint8Array(data));
      } catch {
        snap.set(relNorm, null);
      }
    }
    return snap;
  };

  const snapshotsEqual = (a: FileSnapshot, b: FileSnapshot): boolean => {
    if (a.size !== b.size) return false;
    for (const [k, av] of a) {
      const bv = b.get(k);
      if (bv === undefined) return false;
      if (av === null && bv === null) continue;
      if (av === null || bv === null) return false;
      if (av.byteLength !== bv.byteLength) return false;
      for (let i = 0; i < av.byteLength; i++) if (av[i] !== bv[i]) return false;
    }
    return true;
  };

  const applySnapshotState = async (paths: string[], state: FileSnapshot): Promise<void> => {
    for (const rel of paths) {
      const abs = resolve(cwd, rel);
      const relNorm = relative(cwd, abs).replace(/\\/g, "/");
      if (!relNorm || relNorm.startsWith("..")) continue;
      const value = state.get(relNorm);
      if (value && value.byteLength >= 0) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, value);
      } else {
        // null or absent => remove file if exists
        try {
          await unlink(abs);
        } catch {
          /* ignore */
        }
      }
    }
  };

  const beginTurnHistory = async (label: string): Promise<void> => {
    try {
      const paths = await getWorkspaceChangedPaths();
      if (paths === null) {
        fileHistorySupported = false;
        return; // not a git repo / unavailable
      }
      fileHistorySupported = true;
      pendingHistoryBefore = await snapshotWorkspaceFiles(paths);
      pendingHistoryLabel = label;
    } catch {
      pendingHistoryBefore = null;
      pendingHistoryLabel = "";
    }
  };

  const commitTurnHistory = async (): Promise<void> => {
    if (!pendingHistoryBefore) return;
    const before = pendingHistoryBefore;
    const label = pendingHistoryLabel || "turn";
    pendingHistoryBefore = null;
    pendingHistoryLabel = "";
    try {
      const paths = await getWorkspaceChangedPaths();
      if (paths === null) {
        fileHistorySupported = false;
        return;
      }
      fileHistorySupported = true;
      const union = [...new Set([...before.keys(), ...paths])].sort();
      if (union.length === 0) return;
      const after = await snapshotWorkspaceFiles(union);
      // normalize maps to union keys for comparison/apply
      const beforeNorm: FileSnapshot = new Map();
      const afterNorm: FileSnapshot = new Map();
      for (const p of union) {
        let beforeVal: Uint8Array | null = before.has(p) ? (before.get(p) ?? null) : null;
        if (!before.has(p)) {
          // File was clean (or untracked-absent) before turn but changed during turn.
          const head = await readHeadVersion(p);
          if (head === undefined) {
            // Can't determine/restore safely (e.g. too large) -> skip this path from history.
            continue;
          }
          beforeVal = head; // null if not in HEAD (created during turn), else HEAD content
        }
        const afterVal = after.has(p) ? (after.get(p) ?? null) : null;
        beforeNorm.set(p, beforeVal);
        afterNorm.set(p, afterVal);
      }
      if (beforeNorm.size === 0) return;
      if (snapshotsEqual(beforeNorm, afterNorm)) return;
      undoStack.push({ label, before: beforeNorm, after: afterNorm });
      if (undoStack.length > MAX_UNDO) undoStack.splice(0, undoStack.length - MAX_UNDO);
      redoStack.length = 0;
    } catch {
      /* best-effort */
    }
  };

  const runUndo = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before undo.");
      return;
    }
    const entry = undoStack.pop();
    if (!entry) {
      if (fileHistorySupported === false) toast("Undo/redo unavailable: requires a git workspace.");
      else toast("Nothing to undo.");
      return;
    }
    try {
      const paths = [...new Set([...entry.before.keys(), ...entry.after.keys()])];
      await applySnapshotState(paths, entry.before);
      redoStack.push(entry);
      ok(`Undid changes from ${entry.label} (${paths.length} file${paths.length === 1 ? "" : "s"}).`);
    } catch (error) {
      undoStack.push(entry);
      err(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runRedo = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before redo.");
      return;
    }
    const entry = redoStack.pop();
    if (!entry) {
      if (fileHistorySupported === false) toast("Undo/redo unavailable: requires a git workspace.");
      else toast("Nothing to redo.");
      return;
    }
    try {
      const paths = [...new Set([...entry.before.keys(), ...entry.after.keys()])];
      await applySnapshotState(paths, entry.after);
      undoStack.push(entry);
      ok(`Redid changes from ${entry.label} (${paths.length} file${paths.length === 1 ? "" : "s"}).`);
    } catch (error) {
      redoStack.push(entry);
      err(`Redo failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Pi-style fullscreen dock: scrollable transcript on top, prompt +
  // status pinned to the viewport bottom (editor never floats mid-screen).
  const scrollTranscript = new ScrollView(transcript, { follow: "end", primary: true });
  const dock = new VStack([
    { component: queuePanel, shrink: 1, minSize: 0 },
    { component: toastLine, shrink: 1, minSize: 0 },
    { component: activityLine, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: statusBar, shrink: 1, minSize: 0 },
  ]);
  const mainPane = new VStack([
    { component: scrollTranscript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const sidebarPanel = new SidebarPanel({ leftBorder: true });
  const sidebarScroll = new ScrollView(sidebarPanel);
  let sidebarVisible = false;
  const modelUsageHistory = new Map<string, { provider: string; model: string; switches: number; lastContext?: string; cost: number; input: number; output: number }>();
  const noteModelUsage = () => {
    try {
      const m = session.modelInfo();
      const key = `${m.provider}/${m.modelId}`;
      const u = session.budgetUsage();
      const usage = session.contextUsage();
      const ctx =
        usage && m.contextWindow > 0
          ? `${usage.totalTokens.toLocaleString()}/${m.contextWindow.toLocaleString()} (${Math.round((usage.totalTokens / m.contextWindow) * 100)}%)`
          : undefined;
      const mu = u.byModel[key];
      const prev = modelUsageHistory.get(key);
      modelUsageHistory.set(key, {
        provider: m.provider,
        model: m.modelId,
        switches: (prev?.switches ?? 0),
        lastContext: ctx ?? prev?.lastContext,
        cost: mu?.cost ?? 0,
        input: mu?.input ?? 0,
        output: mu?.output ?? 0,
      });
    } catch {
      /* best-effort */
    }
  };
  const applyLayout = () => {
    const cols = process.stdout.columns ?? 80;
    const wantSidebar = cols >= 110;
    if (wantSidebar === sidebarVisible) return;
    sidebarVisible = wantSidebar;
    if (wantSidebar) {
      tui.setLayoutRoot(
        new HStack([
          { component: mainPane, basis: 0, grow: 1, shrink: 1, minSize: 40 },
          { component: sidebarScroll, basis: 39, grow: 0, shrink: 0, minSize: 0 },
        ]),
      );
    } else {
      tui.setLayoutRoot(mainPane);
    }
    tui.setFocus(editor);
    try { updateSidebar(); } catch { /* best-effort */ }
  };
  const updateSidebar = () => {
    try {
      noteModelUsage();
      const cols = process.stdout.columns ?? 80;
      if (cols < 110) {
        sidebarPanel.setSections([{ key: "info", title: "Session info", lines: [theme.muted("Widen terminal to show panel")], collapsible: false }]);
        return;
      }
      const m = session.modelInfo();
      const u = session.budgetUsage();
      const limits = session.budgetLimits?.();
      const usage = session.contextUsage();
      const ctx =
        usage && m.contextWindow > 0
          ? `${usage.totalTokens.toLocaleString()} / ${m.contextWindow.toLocaleString()} (${Math.round((usage.totalTokens / m.contextWindow) * 100)}%)`
          : "—";
      const sessionName = session.sessionName() ?? "—";
      const modelLines = [...modelUsageHistory.values()].slice(-8).flatMap((entry) => {
        const current = entry.provider === m.provider && entry.model === m.modelId ? theme.accent(" (current)") : "";
        return [
          `${theme.muted("•")} ${entry.provider}/${entry.model}${current}`,
          `  ${theme.muted("ctx")} ${entry.lastContext ?? "—"}`,
          `  ${theme.muted("cost")} $${entry.cost.toFixed(4)} · ${theme.muted("in/out")} ${entry.input.toLocaleString()}/${entry.output.toLocaleString()} tok`,
        ];
      });
      if (modelLines.length === 0) modelLines.push(theme.muted("No model usage tracked yet."));
      const sessionId = manager.sessionId ?? "—";
      sidebarPanel.setSections([
        {
          key: "session",
          title: "Session",
          collapsible: true,
          lines: [
            `${theme.muted("Model")}`,
            `  ${m.provider}/${m.modelId}`,
            `${theme.muted("ID")} ${sessionId}`,
            `${theme.muted("Name")} ${sessionName}`,
            `${theme.muted("Mode")} ${modeLabel()}`,
            `${theme.muted("State")} ${busy ? `running (${activity})` : "ready"}`,
            `${theme.muted("CWD")}`,
            `  ${cwd}`,
          ],
        },
        {
          key: "usage",
          title: "Usage",
          collapsible: true,
          lines: [
            `${theme.muted("Context")} ${ctx}`,
            `${theme.muted("Input")} ${apiUsage.input.toLocaleString()}`,
            `${theme.muted("Output")} ${apiUsage.output.toLocaleString()}`,
            `${theme.muted("Cost")} $${u.cost.toFixed(4)}`,
            ...(apiUsage.cacheRead || apiUsage.cacheWrite
              ? [
                  `${theme.muted("Cache R/W")} ${apiUsage.cacheRead.toLocaleString()} / ${apiUsage.cacheWrite.toLocaleString()}`,
                ]
              : []),
            `${theme.muted("Queue")} ${queue.length}/${MAX_QUEUE}`,
          ],
        },
        {
          key: "budgets",
          title: "Budget limits",
          collapsible: true,
          defaultExpanded: false,
          lines: limits
            ? [
                `${theme.muted("cost")} $${limits.maxCost === 0 ? "∞" : limits.maxCost.toFixed(4)}`,
                `${theme.muted("input tokens")} ${limits.maxInputTokens === 0 ? "∞" : limits.maxInputTokens.toLocaleString()}`,
                `${theme.muted("output tokens")} ${limits.maxOutputTokens === 0 ? "∞" : limits.maxOutputTokens.toLocaleString()}`,
                `${theme.muted("total tokens")} ${limits.maxTotalTokens === 0 ? "∞" : limits.maxTotalTokens.toLocaleString()}`,
              ]
            : [theme.muted("Limits unavailable")],
        },
        {
          key: "models",
          title: "Models used (session)",
          collapsible: true,
          defaultExpanded: true,
          lines: [...modelLines, theme.muted("Per-model cost and token attribution")],
        },
      ]);
    } catch {
      sidebarPanel.setSections([{ key: "error", title: "Session info", lines: [theme.muted("Unavailable")], collapsible: false }]);
    }
  };
  applyLayout();
  updateSidebar();
  tui.setFocus(editor);

  const say = (text: string) => {
    transcript.addChild(new Text(text, 0, 0));
    lastTranscriptBlock = "other";
    pruneTranscript();
    addTranscriptLine(text);
    requestRender();
  };
  const info = (text: string) => say(theme.muted(text));
  const err = (text: string) => say(theme.error(text));
  const ok = (text: string) => say(theme.success(text));

  const setBusy = (running: boolean) => {
    busy = running;
    if (running) {
      setActivity(activity || "model: thinking");
    } else {
      setActivity("ready");
    }
    updateSidebar();
    requestRender();
  };

  const modeLabel = () => {
    const mode = session.approvalMode();
    return mode === "ask" ? "manual" : (mode ?? "manual");
  };

  const printHeader = () => {
    const m = session.modelInfo();
    const name = session.sessionName() ? `  ·  ${session.sessionName()}` : "";
    transcript.addChild(new Spacer(1));
    transcript.addChild(new Text(`${theme.bold("kern v1.0.0")}  ${theme.muted(`${m.provider}/${m.modelId}${name} · ${modeLabel()} · ${cwd}`)}`, 0, 0));
    info("Type a task, or /help for commands.");
    info(HINTS);
    info(theme.muted(QUICK_HELP));
    transcript.addChild(new Rule());
    lastTranscriptBlock = "other";
    pruneTranscript();
    requestRender();
  };

  const renameSession = async () => {
    const current = session.sessionName();
    const next = await promptText("session name", current ?? "");
    if (next === null) {
      toast("Session rename cancelled.");
      return;
    }
    const value = next.trim();
    if (!value) {
      toast("Session name was empty.");
      return;
    }
    try {
      const name = await session.setSessionName?.(value);
      if (name) {
        toast(`Session renamed to ${name}.`);
        printHeader();
      }
    } catch (error) {
      err(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const recordBranchSummary = async () => {
    const note = await promptText("branch summary", "");
    if (note === null) {
      toast("Branch summary cancelled.");
      return;
    }
    const value = note.trim();
    if (!value) {
      toast("Branch summary was empty.");
      return;
    }
    const fromId = session.activeLeafId?.();
    if (!fromId) {
      toast("No active branch to summarize yet.");
      return;
    }
    try {
      const summary = await session.branchSummary?.(fromId, value);
      if (summary) {
        toast(`Branch saved: ${summary.slice(0, 80)}${summary.length > 80 ? "…" : ""}`);
      } else {
        toast("Branch summary saved.");
      }
    } catch (error) {
      err(`Branch summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    const usage = session.contextUsage();
    const ctx =
      usage && m.contextWindow > 0
        ? `ctx ${Math.round((usage.totalTokens / m.contextWindow) * 100)}%`
        : "ctx —";
    const sessionName = session.sessionName() ? ` · ${session.sessionName()}` : "";
    const safetyMode = session.safetyMode?.() ?? "balanced";
    statusBar.setSegments([
      `${m.provider}/${m.modelId}${sessionName}`,
      modeLabel(),
      `safety: ${safetyMode}`,
      ctx,
      `$${u.cost.toFixed(4)} · ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out`,
    ]);
    updateSidebar();
    requestRender();
  };

  const printBudgetDetails = () => {
    const u = session.budgetUsage();
    const limits = session.budgetLimits?.();
    printStatus();
    say(theme.bold("budget"));
    say(`  usage: $${u.cost.toFixed(4)} cost, ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out tokens`);
    if (limits) {
      say(
        `  limits: $${limits.maxCost === 0 ? "∞" : limits.maxCost.toFixed(4)} cost, ${limits.maxInputTokens === 0 ? "∞" : limits.maxInputTokens.toLocaleString()} in, ${limits.maxOutputTokens === 0 ? "∞" : limits.maxOutputTokens.toLocaleString()} out, ${limits.maxTotalTokens === 0 ? "∞" : limits.maxTotalTokens.toLocaleString()} total`,
      );
    } else {
      info("  limits: unavailable from session runtime");
    }
    if (u.byModel && Object.keys(u.byModel).length > 0) {
      say(theme.bold("  per-model:"));
      for (const [model, mu] of Object.entries(u.byModel)) {
        say(`    ${model}: $${mu.cost.toFixed(4)} · ${mu.input.toLocaleString()} in / ${mu.output.toLocaleString()} out`);
      }
    }
    info("Tip: adjust with --max-cost, --max-input-tokens, --max-output-tokens, --max-total-tokens");
  };

  // --- event → transcript -----------------------------------------------------
  let md: Markdown | null = null;
  let mdText = "";
  let reasoningView: CollapsibleText | null = null;
  let reasoningBuffer = "";
  let turnNumber = 0;
  const cards = new Map<string, ToolCard>();
  let lastTranscriptBlock: "none" | "user" | "assistant" | "reasoning" | "tool" | "other" = "none";
  /** Cumulative API token usage (best-effort from usage events). */
  let apiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const formatReasoningSteps = (text: string): string => {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";
    const blocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length <= 1) return normalized;

    const hasExplicitMarkers = blocks.some((b) => /^(?:step\s*\d+[:.)-]?|\d+[.)]|[-*•]|#{1,6}\s)/i.test(b));
    if (hasExplicitMarkers) {
      return blocks.join("\n\n");
    }

    return blocks.map((b, i) => `Step ${i + 1}: ${b}`).join("\n\n");
  };
  /** Pending approval finish callbacks — resolved fail-closed (deny) on abort/exit. */
  const pendingApprovals = new Set<(value: string | null) => void>();
  const denyPendingApprovals = () => {
    if (pendingApprovals.size === 0) return;
    for (const finish of [...pendingApprovals]) finish(null);
    pendingApprovals.clear();
  };
  /** Mark in-flight tool cards done so a cancelled/failed turn never leaves a stuck ◈. */
  const settleCards = (failed: boolean) => {
    if (cards.size === 0) return;
    for (const card of cards.values()) {
      if (!card.isDone()) card.finish(failed);
    }
    cards.clear();
  };
  const closeAssistant = () => {
    md = null;
    mdText = "";
  };
  const closeReasoning = () => {
    if (reasoningView) reasoningView.setStreaming(false);
    reasoningView = null;
    reasoningBuffer = "";
  };
  const addTranscriptGap = (force = false) => {
    if (!force && (lastTranscriptBlock === "reasoning" || lastTranscriptBlock === "tool")) return;
    transcript.addChild(new Spacer(1));
  };

  const renderUserPrompt = (text: string) => {
    addTranscriptGap(true);
    transcript.addChild(new Text(theme.user("you"), 0, 0));
    transcript.addChild(new Text(text, 0, 0));
    lastTranscriptBlock = "user";
    pruneTranscript();
    addTranscriptLine(`you: ${text}`);
    requestRender();
  };
  const renderAssistantBlock = () => {
    if (md) return;
    if (lastTranscriptBlock !== "user") addTranscriptGap();
    transcript.addChild(new Text(theme.accent("assistant"), 0, 0));
    md = new Markdown("", 0, 0, buildMarkdownTheme());
    transcript.addChild(md);
    lastTranscriptBlock = "assistant";
    pruneTranscript();
    requestRender();
  };
  const renderReasoningBlock = () => {
    if (reasoningView) return;
    if (lastTranscriptBlock !== "reasoning" && lastTranscriptBlock !== "tool") addTranscriptGap();
    reasoningView = new CollapsibleText("thinking", { expanded: false, style: theme.muted, streaming: true });
    transcript.addChild(reasoningView);
    lastTranscriptBlock = "reasoning";
    pruneTranscript();
    requestRender();
  };

  /** Persistent error card for auth failures; recovery choices follow via overlay. */
  const showAuthCard = (message: string) => {
    addTranscriptGap(true);
    transcript.addChild(new Text(theme.error("Auth failed — the model rejected our credentials."), 0, 0));
    transcript.addChild(new Text(theme.muted(message), 0, 0));
    transcript.addChild(new Text(theme.muted("Pick a fix in the dialog above (Esc dismisses). /keys re-auths, /model switches."), 0, 0));
    lastTranscriptBlock = "other";
    tui.requestRender();
  };

  const subscribe = () => {
    unsubscribe?.();
    unsubscribe = session.subscribe((event: AgentEvent) => {
      if (exiting) return;
      try {
        switch (event.type) {
          case "text_delta":
            renderAssistantBlock();
            mdText += event.delta;
            md?.setText(mdText);
            setActivity("model: responding");
            requestRenderBatched();
            break;
          case "reasoning_delta":
            setActivity("model: thinking");
            renderReasoningBlock();
            reasoningBuffer += event.delta;
            reasoningView?.setText(formatReasoningSteps(reasoningBuffer));
            requestRenderBatched();
            break;
          case "message_end":
            closeAssistant();
            closeReasoning();
            settleCards(false);
            setActivity("ready");
            if (mdText) addTranscriptLine(`assistant: ${mdText}`);
            if (reasoningBuffer) addTranscriptLine(`reasoning: ${formatReasoningSteps(reasoningBuffer)}`);
            noteModelUsage();
            updateSidebar();
            requestRender();
            break;
          case "tool_execution_start": {
            closeAssistant();
            setActivity(`tool: ${event.toolName}`);
            const card = new ToolCard(event.toolName, summarizeArgs(event.arguments));
            cards.set(event.toolCallId, card);
            if (lastTranscriptBlock !== "tool" && lastTranscriptBlock !== "reasoning") {
              transcript.addChild(new Spacer(1));
            }
            transcript.addChild(card);
            lastTranscriptBlock = "tool";
            pruneTranscript();
            requestRender();
            break;
          }
          case "tool_execution_update": {
            setActivity(`tool: ${event.toolName}`);
            const card = cards.get(event.toolCallId);
            if (card && typeof event.delta === "string") card.appendOutput(event.delta);
            requestRenderBatched();
            break;
          }
          case "tool_execution_end": {
            const card = cards.get(event.toolCallId);
            cards.delete(event.toolCallId);
            const output = event.result
              ? event.result.content.map((c) => c.text).join("\n")
              : "";
            if (card) {
              if (output && (!card.hasOutput() || event.isError)) card.appendOutput(output);
              if (event.isError && !card.hasOutput()) card.appendOutput(`Tool ${event.toolName} failed.`);
              card.finish(event.isError);
              lastTranscriptBlock = "tool";
            } else {
              say(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
              if (output) info(output.split("\n").slice(0, 20).join("\n"));
            }
            if (output) addTranscriptLine(`${event.toolName}: ${output}`);
            setActivity(event.isError ? "tool failed" : "ready");
            updateSidebar();
            requestRender();
            break;
          }
          case "auto_compaction_start":
            setActivity("compacting context");
            toast(`compacting context (${event.phase})…`);
            break;
          case "auto_compaction_end":
            toast("context compacted");
            break;
          case "auto_retry_start":
            setActivity(`retrying (${event.reason})`);
            toast(`retry ${event.attempt} (${event.reason}) in ${event.delayMs}ms`);
            break;
          case "token_usage": {
            apiUsage.input += Number(event.input) || 0;
            apiUsage.output += Number(event.output) || 0;
            updateSidebar();
            printStatus();
            break;
          }
          case "tool_input_repaired":
            toast(`repaired ${event.toolName} args (${event.repairs.length})`);
            break;
          case "model_fallback":
            toast(`fallback → ${event.toProvider}/${event.toModel} (${event.reason})`);
            noteModelUsage();
            printStatus();
            break;
          case "budget_warning": {
            const u = session.budgetUsage();
            toast(`⚠️ Budget warning: ${event.message} ($${u.cost.toFixed(4)} cost, ${(u.inputTokens + u.outputTokens).toLocaleString()} tok)`);
            printStatus();
            break;
          }
          case "budget_exceeded":
            err(`Budget exceeded (${event.kind}): ${event.message}`);
            printStatus();
            break;
          case "agent_error":
            closeAssistant();
            closeReasoning();
            settleCards(true);
            setActivity("error");
            err(`[error ${event.error.code}] ${event.error.message}`);
            if (event.error.code === "E_MODEL_AUTH") {
              showAuthCard(event.error.message);
              handleAuthError(event.error.message);
            } else if (event.error.code === "E_BUDGET_EXCEEDED") {
              const limits = session.budgetLimits?.();
              const u = session.budgetUsage();
              const kind = event.error.details?.budget;
              if (limits) {
                info(
                  `Budget exceeded (${kind || "unknown"}). Current: $${u.cost.toFixed(4)} cost, ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out tok. Tip: split/resume the task or raise limits.`,
                );
              } else {
                info("Budget exceeded. Split the task, resume later, or increase limits (e.g. --max-cost / --max-total-tokens).");
              }
            }
            break;
          case "agent_settled":
            closeAssistant();
            closeReasoning();
            settleCards(false);
            setActivity("ready");
            noteModelUsage();
            printStatus();
            break;
          default:
            break;
        }
      } catch (e) {
        err(`Event handler error: ${e instanceof Error ? e.message : String(e)}`);
        // Continue processing other events; don't crash the TUI
      }
    });
  };
  subscribe();

// Small local list of destructive shell patterns. Matched against the
// approval prompt text; hits render the dialog in a danger style.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+.*-[a-z]*r[a-z]*f\b/i,
  /\brm\s+-rf?\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f\b/,
  /:\(\)\s*\{[^}]*\}\s*;/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev\//,
  />\s*\/dev\/[a-z]/,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
];

/** Extract a command-like pattern from an approval prompt for use as a default in the pattern prompt. */
const cmdPatternFromPrompt = (prompt: string, argsFull?: string): string => {
  // The prompt often contains the command text. Try to extract a trailing command-like substring.
  if (argsFull) {
    try {
      const parsed = JSON.parse(argsFull);
      if (typeof parsed.command === "string") return parsed.command;
      if (typeof parsed.path === "string") return parsed.path;
    } catch { /* ignore */ }
  }
  // Fallback: return the last word-like token from the prompt
  const m = prompt.match(/([^\s]+)$/);
  return m ? m[1]! : prompt;
};

  /** Wrap content + interactive child in a centered overlay; keys forward to the child. */
  const showDialog = (content: Component, target: Component, framed = true): OverlayHandle => {
    const root = framed ? new Box(content, {}) : content;
    return tui.showOverlay(new OverlayDialog(root, target), getOverlayOpts());
  };

  /** Titled single-choice SelectList in a centered overlay. Resolves null on Esc. */
  const pickOne = async (
    title: string,
    items: Array<{ value: string; label: string; description?: string; disabled?: boolean }>,
  ): Promise<string | null> => {
    const disabled = new Set(items.filter((i) => i.disabled).map((i) => i.value));
    const list = new SelectList(
      items.map((i) => ({
        value: i.value,
        label: i.disabled ? `${i.label} (unavailable)` : i.label,
        description: i.description,
      })),
      10,
      buildSelectTheme(),
    );
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      list.onSelect = (item) => {
        if (disabled.has(item.value)) {
          toast("That option is unavailable.");
          return;
        }
        finish(item.value);
      };
      list.onCancel = () => finish(null);
    });
  };

  // --- approval dialog ----------------------------------------------------------
  options.approvalHook.current = async (
    prompt: string,
    meta?: { toolName: string },
  ): Promise<boolean | "session" | string> => {
    const tool = meta?.toolName ?? "tool";
    // The kernel contract carries only (prompt, { toolName }), so the full
    // arguments arrive inside the prompt text — except when a caller passes
    // them through at runtime, in which case we pretty-print them too.
    const runtimeArgs = (meta as unknown as { arguments?: unknown } | undefined)?.arguments;
    let argsDetail = "";
    let argsFull = "";
    if (runtimeArgs !== undefined) {
      try {
        const pretty = JSON.stringify(runtimeArgs, null, 2);
        argsFull = pretty;
        argsDetail = pretty.length > 800 ? pretty.slice(0, 800) + "\n[…truncated… full details hidden — deny if unsure]" : pretty;
      } catch {
        argsDetail = String(runtimeArgs).slice(0, 800);
        argsFull = argsDetail;
      }
    }
    const danger = DESTRUCTIVE_PATTERNS.some((re) => re.test(prompt) || (argsFull && re.test(argsFull)));
    const picked = await new Promise<string | null>((resolve) => {
      const body = new Container();
      body.addChild(new Text(danger ? theme.error(prompt) : theme.warn(prompt), 0, 0));
      body.addChild(new Text(theme.muted(`tool: ${tool}`), 0, 0));
      if (argsDetail) {
        body.addChild(new Text(theme.muted("arguments/context:"), 0, 0));
        body.addChild(new Text(theme.muted(argsDetail), 0, 0));
      } else {
        body.addChild(new Text(theme.muted("(no additional arguments provided by policy prompt)"), 0, 0));
      }
      if (danger) {
        body.addChild(new Text(theme.error("! destructive pattern detected — review carefully before approving"), 0, 0));
      }
      body.addChild(new Text(theme.muted("Fail-closed: Esc/cancel denies. Session allow applies only to this tool in this session."), 0, 0));
      const list = new SelectList(
        [
          { value: "once", label: "Yes, run once", description: "allow just this call" },
          { value: "session", label: `Yes, always allow ${tool}`, description: "no more prompts for this tool in this session" },
          { value: "pattern", label: "Yes, always allow this pattern", description: "enter a glob pattern to match similar commands" },
          { value: "no", label: "No, deny", description: "block this call (Esc)" },
        ],
        5,
        buildSelectTheme(),
      );
      body.addChild(list);
      const box = new Box(body, {
        title: danger ? `approval (DANGER): ${tool}` : `approval: ${tool}`,
        mood: danger ? "error" : "default",
      });
      const handle = tui.showOverlay(new OverlayDialog(box, list), getOverlayOpts());
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        pendingApprovals.delete(finish);
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      pendingApprovals.add(finish);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
    });
    if (picked === "session") {
      ok(`Approved for session: ${tool} (future calls to this tool won't prompt).`);
      return "session";
    }
    if (picked === "pattern") {
      const pat = await promptText("pattern to always allow", cmdPatternFromPrompt(prompt, argsFull));
      if (pat === null) {
        toast("Pattern approval cancelled.");
        return false;
      }
      ok(`Approved pattern for session: ${pat}`);
      return pat;
    }
    const approved = picked === "once";
    say(approved ? theme.success(`approved once: ${tool}`) : theme.muted(`denied: ${tool}`));
    return approved;
  };

  // --- transcript export ----------------------------------------------------------
  const exportTranscript = async (file?: string): Promise<void> => {
    const path = manager.getActivePath();
    const rawTarget = file ?? join(cwd, `kern-session-${manager.sessionId ?? "export"}.md`);
    let target = rawTarget;
    try {
      target = resolve(cwd, rawTarget);
      const rel = resolve(target);
      if (!rel.startsWith(resolve(cwd) + "/") && rel !== resolve(cwd)) {
        err(`Export refused: path escapes workspace: ${file}`);
        return;
      }
    } catch (error) {
      err(`Export refused: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const lines: string[] = [`# kern session`, ""];
    const m = session.modelInfo();
    lines.push(`- model: ${m.provider}/${m.modelId}`, `- cwd: ${cwd}`, "");
    for (const entry of path) {
      if (entry.type === "message") {
        const msg = entry.message;
        lines.push(`## ${msg.role}`, "");
        for (const block of msg.content) {
          if (block.type === "text") lines.push(block.text, "");
          else if (block.type === "reasoning") lines.push(`> thinking: ${block.text.slice(0, 500)}`, "");
          else if (block.type === "tool_call") lines.push(`\`\`\`tool ${block.name}`, `${JSON.stringify(block.arguments, null, 2)}`, "````", "");
          else if (block.type === "tool_result") {
            lines.push(`**tool result${block.isError ? " (error)" : ""}:**`, "");
            for (const c of block.content) lines.push(c.text, "");
          }
        }
      } else if (entry.type === "compaction") {
        lines.push("## compaction checkpoint", "", entry.summary, "");
      } else if (entry.type === "model_change") {
        lines.push(`*model → ${entry.provider}/${entry.model}*`, "");
      } else if (entry.type === "branch") {
        lines.push(`*branch from ${entry.forkedFromId}${entry.note ? `: ${entry.note}` : ""}*`, "");
      }
    }
    await writeFile(target, lines.join("\n"), "utf8");
    ok(`Exported to ${target}`);
  };

  // --- @mention expansion -----------------------------------------------------------
  const expandMentions = async (text: string): Promise<{ text: string; missing: string[] }> => {
    const missing: string[] = [];
    const rawRefs = [...new Set([...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2] ?? ""))].filter(Boolean);
    const refs = rawRefs.map((r) => r.replace(/[.,:;!?)\]}>]+$/, "")).filter(Boolean);
    let out = text;
    for (const ref of refs) {
      const abs = resolve(cwd, ref);
      const relNorm = relative(cwd, abs).replace(/\\/g, "/");
      if (!relNorm || relNorm === ".." || relNorm.startsWith("../")) {
        missing.push(ref);
        info(`@${ref}: outside workspace — sent literally.`);
        continue;
      }
      let content: string;
      try {
        const st = await stat(abs);
        if (!st.isFile()) {
          info(`@${ref}: not a file — sent literally.`);
          continue;
        }
        if (st.size > 400_000) {
          missing.push(ref);
          info(`@${ref}: file too large (${st.size} bytes) — sent literally.`);
          continue;
        }
        content = await readFile(abs, "utf8");
        if (content.includes("\0")) {
          missing.push(ref);
          info(`@${ref}: binary file — sent literally.`);
          continue;
        }
        if (content.length > 40_000) content = content.slice(0, 40_000) + "\n[…truncated…]";
      } catch {
        missing.push(ref);
        continue;
      }
      out = out.split(`@${ref}`).join(`<file path="${relNorm}">\n${content}\n</file>`);
    }
    return { text: out, missing };
  };

  // --- overlays: model picker, history -------------------------------------------------
  const withOverlay = async (
    title: string,
    list: SelectList,
    onPick: (value: string) => Promise<void> | void,
  ): Promise<void> => {
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (run: (() => Promise<void> | void) | null) => {
        if (done) return;
        done = true;
        handle.hide();
        tui.setFocus(editor);
        void Promise.resolve(run?.()).finally(() => resolve());
      };
      list.onSelect = (item) => finish(() => onPick(item.value));
      list.onCancel = () => finish(null);
    });
  };

  /**
   * Bordered text prompt. Enter resolves the typed text; Esc resolves null
   * via the global input listener (pi-tui's Editor has no onEscape — the
   * listener runs first and consumes the key). Typed secrets are never
   * echoed back by the caller.
   */
  const promptText = async (title: string, initial?: string): Promise<string | null> => {
    const ed = new Editor(tui, buildEditorTheme());
    if (initial) ed.setText(initial);
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(new Text(theme.muted("Enter submits · Esc cancels"), 0, 0));
    body.addChild(ed);
    const handle = showDialog(body, ed, false);
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        promptDialog = null;
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      promptDialog = { cancel: () => finish(null) };
      ed.onSubmit = (text) => finish(text);
    });
  };

  const pickModel = async (initialFilter?: string) => {
    if (busy) {
      toast("Wait for the current turn to settle before switching models.");
      return;
    }
    let models;
    try {
      models = await discoverModels(options.modelsFile, {
        provider: options.providerName,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      });
    } catch (error) {
      err(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (models.length === 0) {
      err("No models found. Add providers to ~/.kern/models.json or set KERN_BASE_URL.");
      return;
    }
    const current = session.modelInfo();
    const lastUsed = await readLastUsed().catch(() => null);
    const providers = options.modelsFile.providers ?? {};
    const list = new SelectList(
      [...models]
        .sort((a, b) => Number(b.authenticated) - Number(a.authenticated))
        .map((m) => {
          const prov = providers[m.provider]?.displayName || m.provider;
          const isCurrent = m.provider === current.provider && m.id === current.modelId;
          const isLastUsed =
            !isCurrent && lastUsed?.provider === m.provider && lastUsed?.model === m.id;
          return {
            value: `${m.provider}/${m.id}`,
            label: `${prov}/${m.id}${isCurrent ? "  (current)" : isLastUsed ? "  (last used)" : ""}`,
            description: `${m.source}${m.authenticated ? "" : " · no credentials"}`,
          };
        }),
      10,
      buildSelectTheme(),
    );
    if (initialFilter) list.setFilter(initialFilter);
await withOverlay("model", list, async (value) => {
      const slash = value.indexOf("/");
      const provider = value.slice(0, slash);
      const id = value.slice(slash + 1);
      try {
        const adapter: ModelAdapter = await createAdapterFor(
          options.modelsFile,
          provider,
          id,
          { baseUrl: options.baseUrl, apiKey: options.apiKey },
          logger,
        );
        await session.setModel(adapter);
        await recordLastUsed(provider, id).catch(() => undefined);
      } catch (error) {
        err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  const pickSafetyMode = async (initialFilter?: string) => {
    if (busy) {
      toast("Wait for the current turn to settle before switching safety mode.");
      return;
    }
    const current = session.safetyMode();
    const modes = [
      { value: "strict", label: "Strict", description: "Ask for all operations (max oversight)" },
      { value: "balanced", label: "Balanced", description: "Allow safe, ask for destructive/unknown (default)" },
      { value: "restricted", label: "Restricted", description: "Allow safe, deny destructive/unknown (CI/headless)" },
      { value: "autonomous", label: "Autonomous", description: "Allow everything (legacy --yolo)" },
    ].map((m) => ({
      value: m.value,
      label: `${m.label}${m.value === current ? "  (current)" : ""}`,
      description: m.description,
    }));
    const list = new SelectList(modes, 4, buildSelectTheme());
    if (initialFilter) list.setFilter(initialFilter);
    await withOverlay("safety", list, async (value) => {
      const ok = session.setSafetyMode(value as "strict" | "balanced" | "restricted" | "autonomous");
      if (ok) {
        toast(`Safety mode: ${value}`);
        printStatus();
      } else {
        err("Failed to set safety mode");
      }
    });
  };

  const pickBudget = async (arg?: string) => {
    if (busy) {
      toast("Wait for the current turn to settle before adjusting budget.");
      return;
    }
    const current = session.budgetLimits?.();
    const currentValues: Record<string, number | string> = {
      maxCost: current?.maxCost ?? 0,
      maxInputTokens: current?.maxInputTokens ?? 0,
      maxOutputTokens: current?.maxOutputTokens ?? 0,
      maxTotalTokens: current?.maxTotalTokens ?? 0,
    };

    const floatFields = new Set(["maxCost"]);
    const intFields = new Set(["maxInputTokens", "maxOutputTokens", "maxTotalTokens"]);

    if (arg && arg.trim()) {
      const budgets: Record<string, number> = {};
      const pairs = arg.trim().split(/\s+/);
      for (const pair of pairs) {
        const [key, valStr] = pair.split("=");
        if (!key || !valStr) {
          err(`Invalid format: "${pair}". Use field=value (e.g. maxCost=0.05)`);
          return;
        }
        const val = Number(valStr);
        if (!Number.isFinite(val) || val < 0) {
          err(`Invalid value for ${key}: must be non-negative number`);
          return;
        }
        if (intFields.has(key) && !Number.isInteger(val)) {
          err(`Invalid value for ${key}: must be a non-negative integer`);
          return;
        }
        if (val > 0) budgets[key] = val;
      }
      if (Object.keys(budgets).length > 0) {
        toast("Budget limits set. Restart session (/new) to apply.");
        printBudgetDetails();
      } else {
        toast("No budgets set (all unlimited).");
      }
      return;
    }

    // Display current values directly (no overlay needed for read-only)
    printStatus();
    say(theme.bold("budget limits (0 = unlimited)"));
    say(`  maxCost: $${(currentValues.maxCost as number) === 0 ? "∞" : (currentValues.maxCost as number).toFixed(4)}`);
    say(`  maxInputTokens: ${currentValues.maxInputTokens || "unlimited"}`);
    say(`  maxOutputTokens: ${currentValues.maxOutputTokens || "unlimited"}`);
    say(`  maxTotalTokens: ${currentValues.maxTotalTokens || "unlimited"}`);
    info("  (use /budget <field>=<value> to set, e.g. /budget maxCost=0.05)");
  };

  /** `/connect` wizard: preset → key → test → model → save. Esc at any step cancels with nothing written. */
  const runConnect = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before connecting a provider.");
      return;
    }
    // a. Preset picker.
    const picked = await pickOne("connect — provider", [
      ...PROVIDER_PRESETS.map((p) => ({
        value: p.name,
        label: p.name,
        description: `${p.baseUrl} · ${p.hint}`,
      })),
      { value: "__custom__", label: "Custom…", description: "enter name + base URL manually" },
    ]);
    if (picked === null) {
      toast("Connect cancelled.");
      return;
    }
    let name: string;
    let baseUrl: string;
    let presetEnv = "";
    if (picked === "__custom__") {
      // b. Custom name + URL.
      const rawName = await promptText("provider name ([a-z0-9.-], Esc cancels)");
      if (rawName === null) {
        toast("Connect cancelled.");
        return;
      }
      const clean = rawName.trim().toLowerCase();
      if (!/^[a-z0-9.-]{1,32}$/.test(clean)) {
        err(`Bad provider name ${JSON.stringify(rawName)} — use [a-z0-9.-] (up to 32 chars).`);
        return;
      }
      name = clean;
      const rawUrl = await promptText("base URL", "http://localhost:11434/v1");
      if (rawUrl === null) {
        toast("Connect cancelled.");
        return;
      }
      baseUrl = rawUrl.trim();
      if (!/^https?:\/\//i.test(baseUrl)) {
        err(`Bad baseUrl ${JSON.stringify(rawUrl)} — must start with http:// or https://.`);
        return;
      }
    } else {
      const preset = PROVIDER_PRESETS.find((p) => p.name === picked);
      if (!preset) {
        err(`Unknown preset: ${picked}`);
        return;
      }
      name = preset.name;
      baseUrl = preset.baseUrl;
      presetEnv = preset.apiKeyEnv;
    }

    // c. Key step. Resolves the stored key form: literal, `$VAR`, `!cmd`,
    // or undefined for keyless local servers. Null = cancelled.
    const askKey = async (): Promise<string | undefined | null> => {
      const choice = await pickOne("connect — API key", [
        { value: "enter", label: "Enter key", description: "paste the API key" },
        {
          value: "env",
          label: presetEnv ? `Use $${presetEnv}` : "Use $ENV_VAR",
          description: presetEnv ? `read from ${presetEnv} at runtime` : "read from an env var at runtime",
        },
        { value: "command", label: "Use !command", description: "run a shell command for the key" },
        { value: "none", label: "No key (local)", description: "loopback servers need none" },
      ]);
      if (choice === null) return null;
      if (choice === "none") return undefined;
      if (choice === "enter") {
        const typed = await promptText("API key (Enter submits; value is never echoed back)");
        if (typed === null) return null;
        const t = typed.trim();
        if (!t) {
          toast("Empty key — continuing with no key.");
          return undefined;
        }
        toast("Key entered (not echoed).");
        return t;
      }
      if (choice === "env") {
        const typed = await promptText("env var ($NAME)", presetEnv ? `$${presetEnv}` : "$");
        if (typed === null) return null;
        const t = typed.trim();
        if (!t) return undefined;
        return t.startsWith("$") ? t : `$${t}`;
      }
      const typed = await promptText("credential command (!cmd)", "!");
      if (typed === null) return null;
      const t = typed.trim();
      if (!t || t === "!") return undefined;
      return t.startsWith("!") ? t : `!${t}`;
    };
    let apiKey = await askKey();
    if (apiKey === null) {
      toast("Connect cancelled.");
      return;
    }

    // d. Test loop.
    let liveModels: string[] = [];
    let manualId: string | null = null;
    for (;;) {
      toast(`Testing ${baseUrl} …`);
      let result: Awaited<ReturnType<typeof testProvider>>;
      try {
        result = await testProvider(baseUrl, apiKey, {});
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        liveModels = result.models;
        ok(`Connected: ${liveModels.length} model(s) found.`);
        break;
      }
      err(`Test failed: ${result.message}`);
      const fix = await pickOne("connect — test failed", [
        { value: "url", label: "Edit URL", description: baseUrl },
        { value: "key", label: "Edit key", description: "re-enter credential" },
        { value: "manual", label: "Enter model id manually", description: "skip the live test" },
        { value: "cancel", label: "Cancel", description: "write nothing (Esc)" },
      ]);
      if (fix === null || fix === "cancel") {
        toast("Connect cancelled.");
        return;
      }
      if (fix === "url") {
        const typed = await promptText("base URL", baseUrl);
        if (typed === null) {
          toast("Connect cancelled.");
          return;
        }
        baseUrl = typed.trim();
        continue;
      }
      if (fix === "key") {
        const k = await askKey();
        if (k === null) {
          toast("Connect cancelled.");
          return;
        }
        apiKey = k;
        continue;
      }
      const typed = await promptText("model id");
      if (typed === null || !typed.trim()) {
        toast("Connect cancelled.");
        return;
      }
      manualId = typed.trim();
      break;
    }

    // e. Model step.
    let modelId = manualId;
    if (!modelId) {
      if (liveModels.length === 0) {
        toast("No models returned — enter one manually.");
        const typed = await promptText("model id");
        if (typed === null || !typed.trim()) {
          toast("Connect cancelled.");
          return;
        }
        modelId = typed.trim();
      } else {
        const choice = await pickOne("connect — model", [
          ...liveModels.map((m) => ({ value: m, label: m, description: "live" })),
          { value: "__manual__", label: "Enter model id manually…", description: "" },
        ]);
        if (choice === null) {
          toast("Connect cancelled.");
          return;
        }
        if (choice === "__manual__") {
          const typed = await promptText("model id");
          if (typed === null || !typed.trim()) {
            toast("Connect cancelled.");
            return;
          }
          modelId = typed.trim();
        } else {
          modelId = choice;
        }
      }
    }

    const asDefault = await pickOne("set as default?", [
      { value: "yes", label: "Yes", description: "use for new sessions" },
      { value: "no", label: "No", description: "keep current default" },
    ]);
    if (asDefault === null) {
      toast("Connect cancelled.");
      return;
    }
    // If the key is `$VAR`, also record apiKeyEnv so env-based resolution
    // works even when the variable is unset at resolve time.
    let apiKeyEnvOut: string | undefined = presetEnv || undefined;
    const envMatch = apiKey?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (envMatch?.[1]) apiKeyEnvOut = envMatch[1];
    const cfg: ProviderConfig = {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyEnvOut ? { apiKeyEnv: apiKeyEnvOut } : {}),
      models: [{ id: modelId }],
    };
    // saveProviderToUserFile moves a literal apiKey into auth.json itself;
    // call saveAuthKey too for literal keys (idempotent), never for
    // `$VAR` / `!cmd` references (those must stay resolvable, not stored).
    try {
      const saved = await saveProviderToUserFile(name, cfg, { makeDefault: asDefault === "yes" });
      if (apiKey && !apiKey.startsWith("$") && !apiKey.startsWith("!")) {
        await saveAuthKey(name, apiKey);
      }
      ok(`Saved ${saved.summary} → ${saved.path}`);
    } catch (error) {
      err(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      options.modelsFile = await loadModelsFile(cwd);
      const adapter: ModelAdapter = await createAdapterFor(
        options.modelsFile,
        name,
        modelId,
        { baseUrl, apiKey },
        logger,
      );
      await session.setModel(adapter);
      await recordLastUsed(name, modelId).catch(() => undefined);
      ok(`Model: ${name}/${modelId}`);
      printStatus();
    } catch (error) {
      err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const historySearch = async () => {
    if (busy) return;
    if (recentPrompts.length === 0) {
      toast("No history yet.");
      return;
    }
    const list = new SelectList(
      [...recentPrompts].reverse().map((h) => ({ value: h, label: h.length > 100 ? h.slice(0, 100) + "…" : h })),
      10,
      buildSelectTheme(),
    );
    await withOverlay("history", list, (value) => editor.setText(value));
  };

  const cycleMode = () => {
    if (busy) {
      toast("Mode changes apply when idle.");
      return;
    }
    const current = session.approvalMode();
    const next = current === "ask" ? "auto-allowlist" : "ask";
    if (session.setApprovalMode(next as "ask" | "auto-allowlist")) {
      toast(`Approval mode: ${next === "ask" ? "manual (ask)" : "auto (no per-op prompts; destructive still asks)"}`);
      printStatus();
    } else {
      toast("Approval mode is fixed by the active policy.");
    }
  };

  const SAFETY_MODES: Array<"strict" | "balanced" | "restricted" | "autonomous"> = [
    "strict",
    "balanced",
    "restricted",
    "autonomous",
  ];
  const SAFETY_MODE_LABELS: Record<"strict" | "balanced" | "restricted" | "autonomous", string> = {
    strict: "strict",
    balanced: "balanced",
    restricted: "restricted",
    autonomous: "autonomous",
  };
  const cycleSafetyMode = (direction: "tighter" | "looser") => {
    if (busy) {
      toast("Mode changes apply when idle.");
      return;
    }
    const current = (session.safetyMode?.() ?? "balanced") as "strict" | "balanced" | "restricted" | "autonomous";
    const idx = SAFETY_MODES.indexOf(current);
    if (idx === -1) return;
    const next = direction === "tighter" ? SAFETY_MODES[Math.max(0, idx - 1)] : SAFETY_MODES[Math.min(SAFETY_MODES.length - 1, idx + 1)];
    if (!next || next === current) {
      toast(`Safety mode already at ${next === "strict" ? "most restrictive" : "most permissive"}: ${next}`);
      return;
    }
    if (session.setSafetyMode(next)) {
      toast(`Safety mode: ${next}`);
      printStatus();
    } else {
      toast("Failed to set safety mode");
    }
  };

  // --- empty-state suggestions ------------------------------------------------------
  // First run with no session history: 2-3 suggestion chips. Selecting one
  // fills the editor (never auto-sends). Up/Down+Enter via the overlay list,
  // or the 1-3 number keys handled in the global input hook below.
  const SUGGESTIONS = ["Summarize this repo", "Find TODOs", "Run tests"];
  const showSuggestions = async (): Promise<void> => {
    const list = new SelectList(
      SUGGESTIONS.map((s, i) => ({ value: s, label: `${i + 1}. ${s}` })),
      5,
      buildSelectTheme(),
    );
    const body = new Container();
    body.addChild(new Text(theme.bold("try — ↑↓+Enter or 1-3 fills the prompt (no send) · Esc dismisses"), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    suggestionsOpen = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (fill: string | null) => {
        if (done) return;
        done = true;
        suggestionsOpen = false;
        suggestionPick = null;
        handle.hide();
        tui.setFocus(editor);
        if (fill !== null) {
          editor.setText(fill);
          toast(`Filled: ${fill}`);
        }
        resolve();
      };
      suggestionPick = (value) => finish(value);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
    });
  };

  /** `/keys`: re-auth the CURRENT provider. Tests first; only a 401/403 offers re-entry. */
  const runReauth = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before re-authenticating.");
      return;
    }
    const current = session.modelInfo();
    const cfg = (options.modelsFile.providers ?? {})[current.provider];
    if (!cfg) {
      err(`Unknown provider ${JSON.stringify(current.provider)} — use /connect to add it.`);
      return;
    }
    toast(`Testing ${current.provider} (${cfg.baseUrl}) …`);
    let key: string | undefined;
    try {
      key = await resolveApiKey(current.provider, cfg, options.apiKey);
    } catch {
      key = undefined;
    }
    let result: Awaited<ReturnType<typeof testProvider>>;
    try {
      result = await testProvider(cfg.baseUrl, key, {});
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      toast(`Key OK for ${current.provider}: ${result.models.length} model(s) found.`);
      return;
    }
    err(`Test failed: ${result.message}`);
    if (!/401|403|rejected/i.test(result.message)) return;
    const choice = await pickOne(`re-auth ${current.provider} — key rejected`, [
      { value: "enter", label: "Re-enter key", description: "paste a new API key" },
      { value: "env", label: "Use $ENV_VAR", description: "read from an env var at runtime" },
      { value: "command", label: "Use !command", description: "run a shell command for the key" },
      { value: "cancel", label: "Cancel", description: "keep the current key (Esc)" },
    ]);
    if (choice === null || choice === "cancel") {
      toast("Re-auth cancelled.");
      return;
    }
    let nextKey: string | undefined;
    if (choice === "enter") {
      const typed = await promptText("API key (Enter submits; value is never echoed back)");
      if (typed === null || !typed.trim()) {
        toast("Re-auth cancelled.");
        return;
      }
      nextKey = typed.trim();
    } else if (choice === "env") {
      const typed = await promptText("env var ($NAME)", `$${cfg.apiKeyEnv ?? ""}`);
      if (typed === null || !typed.trim()) {
        toast("Re-auth cancelled.");
        return;
      }
      const t = typed.trim();
      nextKey = t.startsWith("$") ? t : `$${t}`;
    } else {
      const typed = await promptText("credential command (!cmd)", "!");
      if (typed === null || !typed.trim() || typed.trim() === "!") {
        toast("Re-auth cancelled.");
        return;
      }
      const t = typed.trim();
      nextKey = t.startsWith("!") ? t : `!${t}`;
    }
    try {
      if (nextKey && !nextKey.startsWith("$") && !nextKey.startsWith("!")) {
        await saveAuthKey(current.provider, nextKey);
      } else {
        const merged: ProviderConfig = { ...cfg, apiKey: nextKey };
        await saveProviderToUserFile(current.provider, merged, {});
        options.modelsFile = await loadModelsFile(cwd);
      }
      toast("Key saved — retesting …");
    } catch (error) {
      err(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let retest: Awaited<ReturnType<typeof testProvider>>;
    try {
      const resolved = await resolveApiKey(
        current.provider,
        (options.modelsFile.providers ?? {})[current.provider] ?? cfg,
        nextKey,
      );
      retest = await testProvider(cfg.baseUrl, resolved, {});
    } catch (error) {
      retest = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (retest.ok) toast(`Re-authenticated ${current.provider}: ${retest.models.length} model(s) found.`);
    else err(`Retest failed: ${retest.message}`);
  };

  const switchSessionTo = async (file: string): Promise<void> => {
    try {
      const next = await session.switchSession?.(file);
      if (!next) {
        toast("Session switch is unavailable right now.");
        return;
      }
      unsubscribe?.();
      session = next.session;
      manager = next.manager;
      queue = [];
      apiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      cards.clear();
      closeAssistant();
      closeReasoning();
      lastUserPrompt = "";
      undoStack.length = 0;
      redoStack.length = 0;
      pendingHistoryBefore = null;
      pendingHistoryLabel = "";
      renderQueue();
      subscribe();
      transcript.clear();
      lastTranscriptBlock = "none";
      printHeader();
      printStatus();
      ok(`Session switched: ${file}`);
    } catch (error) {
      err(`Session switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sessionSwitcher = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before switching sessions.");
      return;
    }
    try {
      const items = await manager.listSessions?.() ?? [];
      if (items.length === 0) {
        toast("No saved sessions yet.");
        return;
      }
      const currentPath = String((manager as any).sessionFile ?? "");
      const list = new SelectList(
        items.map((path) => ({
          value: path,
          label: `${path === currentPath ? "● " : "  "}${path.split(/[\\/]/).at(-1) ?? path}`,
          description: path,
        })),
        10,
        buildSelectTheme(),
      );
      const body = new Container();
      body.addChild(new Text(theme.bold("session · switch"), 0, 0));
      body.addChild(new Text(theme.muted("Select a saved session to load from its path."), 0, 0));
      body.addChild(list);
      const handle = showDialog(body, list);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (run: (() => Promise<void> | void) | null) => {
          if (done) return;
          done = true;
          handle.hide();
          tui.setFocus(editor);
          void Promise.resolve(run?.()).finally(() => resolve());
        };
        list.onSelect = (item) => finish(() => switchSessionTo(item.value));
        list.onCancel = () => finish(null);
      });
    } catch (error) {
      err(`Session list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const showSessionInfo = () => {
    const m = session.modelInfo();
    const name = session.sessionName() ?? "—";
    const id = manager.sessionId ?? "—";
    const path = (manager as any).sessionFile ?? (manager as any).getActivePath?.() ?? "—";
    say(theme.bold("session"));
    say(`  ${theme.muted("id")}    ${id}`);
    say(`  ${theme.muted("name")}  ${name}`);
    say(`  ${theme.muted("model")} ${m.provider}/${m.modelId}`);
    say(`  ${theme.muted("cwd")}   ${cwd}`);
    say(`  ${theme.muted("path")}  ${String(path)}`);
    info("Tip: resume later with `kern --session <id|path>` (or `--resume` for most recent).");
  };

  const runSessionCommand = async (arg: string): Promise<void> => {
    const [subRaw, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    const sub = (subRaw ?? "").toLowerCase();
    const subArg = rest.join(" ").trim();
    if (!sub) {
      if (busy) {
        toast("Wait for the current turn to settle before managing sessions.");
        return;
      }
      const choice = await pickOne("session", [
        { value: "switch", label: "Switch session", description: "pick another saved session" },
        { value: "rename", label: "Rename session", description: "set a name for this session" },
        { value: "new", label: "New session", description: "start a fresh session" },
        { value: "info", label: "Session info", description: "show id, name, path, model" },
        { value: "export", label: "Export transcript", description: "save transcript to markdown" },
      ]);
      if (choice === null) return;
      if (choice === "switch") return sessionSwitcher();
      if (choice === "rename") return renameSession();
      if (choice === "new") return runCommand("/new").then(() => undefined);
      if (choice === "info") return showSessionInfo();
      if (choice === "export") {
        try { await exportTranscript(); } catch (error) { err(`Export failed: ${error instanceof Error ? error.message : String(error)}`); }
        return;
      }
      return;
    }
    if (sub === "list" || sub === "switch") {
      await sessionSwitcher();
      return;
    }
    if (sub === "rename" || sub === "name") {
      if (subArg) {
        try {
          const name = await session.setSessionName?.(subArg);
          if (name) { toast(`Session renamed to ${name}.`); printStatus(); }
        } catch (error) {
          err(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await renameSession();
      }
      return;
    }
    if (sub === "new") {
      await runCommand("/new");
      return;
    }
    if (sub === "info" || sub === "id" || sub === "path" || sub === "current") {
      showSessionInfo();
      return;
    }
    if (sub === "export") {
      try { await exportTranscript(subArg || undefined); } catch (error) { err(`Export failed: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    err(`Unknown session action: ${sub}. Try /session, /session switch, /session rename, /session new, /session info.`);
  };

  // --- slash commands -------------------------------------------------------------------
  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const normalized = cmd?.toLowerCase();
    switch (normalized) {
      case "/help":
        for (const c of COMMANDS) say(`  ${theme.accent("/" + c.name)}  ${theme.muted(c.description)}`);
        {
          const advanced = Object.entries(ADVANCED_COMMANDS);
          if (advanced.length > 0) {
            info(theme.muted(`Advanced: ${advanced.map(([name, description]) => `/${name} (${description})`).join(" · ")}`));
          }
        }
        info(HINTS);
        info(theme.muted("Tips: use @path to attach files, !cmd for shell. While running, thinking/tools show a running state; click headers after completion to expand/collapse details. /undo and /redo are best-effort in git workspaces. /budget shows session limits/usage."));
        return true;
      case "/branch":
        await recordBranchSummary();
        return true;
      case "/quit":
      case "/exit":
        return false;
      case "/clear":
        transcript.clear();
        lastTranscriptBlock = "none";
        cards.clear();
        closeAssistant();
        closeReasoning();
        printHeader();
        printStatus();
        return true;
      case "/budget":
        await pickBudget(arg);
        return true;
      case "/safety":
        await pickSafetyMode(arg || undefined);
        return true;
      case "/model":
      case "/models":
        await pickModel(arg || undefined);
        return true;
      case "/session":
        await runSessionCommand(arg);
        return true;
      case "/keys":
        await runReauth();
        return true;
      case "/connect":
        await runConnect();
        return true;
      case "/compact": {
        if (busy) {
          toast("A turn is running — compaction will happen automatically if needed.");
          return true;
        }
        try {
          const result = await session.compact(arg || undefined);
          if (!result) toast("Nothing to compact yet.");
          else {
            ok(`Compacted through ${result.replacesThroughId}.`);
            printStatus();
          }
        } catch (error) {
          err(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      case "/diff": {
        try {
          const res = await session.callToolAsUser("bash", {
            command:
              "echo '--- git status --short ---'; git status --short | head -40; echo '--- git diff --stat ---'; git diff --stat | head -40; echo '--- staged diff --stat ---'; git diff --cached --stat | head -40",
          });
          const text = res.content.map((c) => c.text).join("\n").replace(/\r\n/g, "\n").trim();
          if (res.isError) {
            err(text || "Failed to inspect working tree.");
            info("Not a git repository, or git failed.");
          } else {
            const cleaned = text
              .split("\n")
              .filter((line, i, arr) => !(line.startsWith("---") && arr[i + 1]?.startsWith("---")))
              .join("\n")
              .trim();
            const sections = cleaned.split("\n").map((l) => l.trimEnd());
            const meaningful = sections.filter((l) => l && !l.startsWith("---"));
            say(theme.bold("working tree review"));
            if (meaningful.length === 0) say("(clean)");
            else say(sections.join("\n"));
            info("Tip: for full patch details run `!git diff` or inspect specific files.");
          }
        } catch (error) {
          err(`Diff failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      case "/undo":
        await runUndo();
        printStatus();
        return true;
      case "/redo":
        await runRedo();
        printStatus();
        return true;
      case "/new": {
        if (busy) {
          toast("Wait for the current turn to settle before starting a new session.");
          return true;
        }
        try {
          const fresh = await options.newSession();
          unsubscribe?.();
          session = fresh.session;
          manager = fresh.manager;
          queue = [];
          apiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          cards.clear();
          closeAssistant();
          closeReasoning();
          lastUserPrompt = "";
          undoStack.length = 0;
          redoStack.length = 0;
          pendingHistoryBefore = null;
          pendingHistoryLabel = "";
          renderQueue();
          subscribe();
          transcript.clear();
          lastTranscriptBlock = "none";
          printHeader();
          printStatus();
          toast("New session started.");
        } catch (error) {
          err(`New session failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      case "/export": {
        if (busy) {
          toast("Wait for the current turn to settle before exporting.");
          return true;
        }
        try {
          await exportTranscript(arg || undefined);
        } catch (error) {
          err(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      default:
        err(`Unknown command: ${cmd ?? ""}. Try /help.`);
        return true;
    }
  };

  // --- prompt submission ---------------------------------------------------------------------
  /** One-line arg summary for tool cards (path/command first, capped). */
  const summarizeArgs = (args: unknown): string => {
    if (typeof args !== "object" || args === null) return "";
    const record = args as Record<string, unknown>;
    const first =
      typeof record["path"] === "string"
        ? record["path"]
        : typeof record["command"] === "string"
          ? record["command"]
          : Object.entries(record)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(" ");
    const text = String(first);
    return text.length > 100 ? text.slice(0, 100) + "…" : text;
  };

  const runTurn = (text: string) => {
    if (busy) return;
    busy = true;
    abort = new AbortController();
    activity = "thinking";
    setActivity("thinking");
    lastUserPrompt = text;
    setBusy(true);
    turnNumber += 1;
    renderUserPrompt(text);
    void (async () => {
      await beginTurnHistory(`turn ${turnNumber}`);
      try {
        await session.prompt(text, { signal: abort!.signal });
      } catch (error: unknown) {
        if (error instanceof Error && (error.name === "AbortError" || /aborted|canceled|cancelled/i.test(error.message))) {
          info("Turn stopped.");
          return;
        }
        err(`Turn failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
        busy = false;
        abort = null;
        await commitTurnHistory();
        if (!exiting) {
          printStatus();
          const next = queue.shift();
          renderQueue();
          if (next !== undefined) {
            toast(`sending queued message${queue.length > 0 ? ` (+${queue.length} more)` : ""}`);
            runTurn(next);
          }
        }
      }
    })();
  };

  const stopCurrentTurn = () => {
    if (!busy) return false;
    queue = [];
    renderQueue();
    abort?.abort();
    settleCards(true);
    denyPendingApprovals();
    closeAssistant();
    closeReasoning();
    // Global running state is shown in the dock activity line below the input.
    void 0;
    toast("Stopped current run.");
    setActivity("ready");
    return true;
  };

  /** `!cmd`: run directly, show output, and have the agent respond to it. */
  const runShellMode = async (command: string) => {
    if (busy) {
      toast("A turn is running — shell mode waits for settle.");
      return;
    }
    say(theme.tool(`◈ !${command}`));
    try {
      const res = await session.callToolAsUser("bash", { command });
      const output = res.content.map((c) => c.text).join("\n");
      if (!output.trim()) info("(no output)");
      else if (res.isError) err(output.split("\n").slice(0, 60).join("\n"));
      else say(theme.muted(output.split("\n").slice(0, 60).join("\n")));
      const lines = output.split("\n");
      if (lines.length > 60) info(`[…${lines.length - 60} more lines in context]`);
      const capped = output.length > 12_000 ? output.slice(0, 12_000) + "\n[…truncated…]" : output;
      const status = res.isError ? "failed" : "succeeded";
      runTurn(`I ran \`${command}\` in shell mode (command ${status}). Output:\n${capped || "(no output)"}\n\nRespond to it.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      err(`Shell command failed: ${message}`);
      runTurn(`I tried to run \`${command}\` in shell mode, but execution failed: ${message}\n\nRespond to it.`);
    }
  };

  const submit = (line: string) => {
    if (exiting) return;
    if (busy) {
      const text = line.trim();
      if (!text) return;
      if (text.startsWith("/") || (text.startsWith("!") && !text.startsWith("!="))) {
        const cmd = text.split(/\s+/)[0]?.toLowerCase();
        if (cmd === "/help" || cmd === "/budget") {
          editor.setText("");
          editor.addToHistory(text);
          void (async () => {
            try { await runCommand(text); } catch (error) { err(String(error)); }
          })();
          return;
        }
        toast("Commands wait for settle — type plain text to queue.");
        return;
      }
      if (queue.length >= MAX_QUEUE) toast(`Queue full (${MAX_QUEUE}) — wait for the turn to settle.`);
      else {
        queue.push(text);
        renderQueue();
        toast(`queued ${queue.length}/${MAX_QUEUE}`);
      }
      return;
    }
    const raw = line.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    if (!raw.trim()) return;
    const trimmed = raw.trim();
    editor.setText("");
    tui.requestRender();
    if (trimmed === "?") {
      void runCommand("/help");
      return;
    }
    if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
      const command = trimmed.slice(1).trim();
      if (!command) return;
      recentPrompts.push(trimmed);
      editor.addToHistory(trimmed);
      void runShellMode(command);
      return;
    }
    if (trimmed.startsWith("/")) {
      editor.addToHistory(trimmed);
      void (async () => {
        let keep = true;
        try {
          keep = await runCommand(trimmed);
        } catch (error) {
          err(String(error));
        }
        if (!keep) exit();
      })();
      return;
    }
    const matches = raw.match(INVISIBLE_RE);
    const removed = matches ? matches.length : 0;
    const cleaned = raw.replace(INVISIBLE_RE, "");
    if (removed > 0) {
      editor.setText(cleaned);
      info(`Removed ${removed} invisible character${removed === 1 ? "" : "s"} · review and press Enter to send.`);
      return;
    }
    void (async () => {
      const { text, missing } = await expandMentions(raw);
      for (const m of missing) info(`@${m}: file not found — sent literally.`);
      recentPrompts.push(raw);
      if (recentPrompts.length > 200) recentPrompts.splice(0, recentPrompts.length - 200);
      editor.addToHistory(raw);
      runTurn(text);
    })();
  };

  // Auth-failure recovery (wired to the agent_error handler above). Offers
  // immediate actions; Retry re-submits the last user prompt, /connect and
  // /model reuse the existing runCommand paths.
  handleAuthError = (_message: string) => {
    if (authOverlayOpen) return;
    authOverlayOpen = true;
    void (async () => {
      const pick = await pickOne("auth error — how to recover?", [
        { value: "connect", label: "Reconnect with /connect", description: "run the connect wizard" },
        {
          value: "retry",
          label: "Retry turn",
          description: lastUserPrompt ? "re-submit the last prompt" : "no prompt to retry yet",
          disabled: !lastUserPrompt,
        },
        { value: "model", label: "Switch model (/model)", description: "pick another provider/model" },
        { value: "dismiss", label: "Dismiss", description: "stay here (Esc)" },
      ]);
      authOverlayOpen = false;
      if (pick === "connect") await runCommand("/connect");
      else if (pick === "model") await runCommand("/model");
      else if (pick === "retry") {
        if (!lastUserPrompt) {
          toast("Nothing to retry yet.");
          return;
        }
        if (busy) {
          if (queue.length >= MAX_QUEUE) toast(`Queue full (${MAX_QUEUE}) — retry dropped.`);
          else {
            queue.unshift(lastUserPrompt);
            renderQueue();
            toast("Retry queued — sends when the turn settles.");
          }
          return;
        }
        toast("Retrying last prompt…");
        runTurn(lastUserPrompt);
      } else {
        toast("Auth error dismissed — /connect, /model, or retry when ready.");
      }
    })();
  };

  editor.onSubmit = submit;

  const exit = () => {
    if (exiting) return;
    exiting = true;
    abort?.abort();
    denyPendingApprovals();
    if (activityPulse) clearInterval(activityPulse);
    if (toastTimer) clearTimeout(toastTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    if (process.stdout.isTTY) process.off("SIGWINCH", handleResize);
    options.approvalHook.current = null;
    unsubscribe?.();
    tui.stop();
    // Fullscreen alt-screen restores the previous screen on stop, so the
    // farewell must go to stdout after (it would vanish otherwise).
    process.stdout.write(theme.muted("bye.\n"));
    void saveState();
    process.exit(0);
  };

  const requestExit = () => {
    const now = Date.now();
    if (now - lastExitAttempt < 800) {
      exit();
      return;
    }
    lastExitAttempt = now;
    toast("Press Ctrl+D again to exit.");
  };

  // --- global keys ----------------------------------------------------------------------------
  // Registered via addInputListener, which runs BEFORE focused components, so
  // Esc-cancel for prompt dialogs is emulated here (pi-tui's Editor has no
  // onEscape): a handled Esc returns `{consume:true}` to preempt the dialog's editor.
  tui.addInputListener((key) => {
    // Esc cancels an open text-prompt dialog (prevents the dialog's editor).
    if (promptDialog && matchesKey(key, "escape")) {
      promptDialog.cancel();
      return { consume: true };
    }
    if (tui.hasOverlay()) {
      return undefined; // overlays own Esc/arrows/Enter
    }
    if (matchesKey(key, "escape")) {
      if (stopCurrentTurn()) return { consume: true };
      if (editor.getText().length > 0) {
        editor.setText("");
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(key, "ctrl+c")) {
      if (busy) {
        stopCurrentTurn();
        return { consume: true };
      }
      if (editor.getText().length === 0) requestExit();
      else editor.setText("");
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+d")) {
      if (editor.getText().length === 0) requestExit();
      return editor.getText().length === 0 ? { consume: true } : undefined;
    }
    if (matchesKey(key, "ctrl+q")) {
      if (queue.length > 0) {
        queue = [];
        renderQueue();
        toast("Queue cleared.");
      }
      return { consume: true };
    }
    // Backspace on an empty editor removes the last queued item.
    if (matchesKey(key, "backspace") && editor.getText().length === 0 && queue.length > 0) {
      const removed = queue.pop();
      renderQueue();
      toast(`Removed queued message${removed ? `: ${removed.replace(/\s+/g, " ").trim().slice(0, 60)}` : ""}`);
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+s")) {
      // Stash/restore the draft (pi-tui's Editor has no stashPrompt).
      if (editor.getText().length > 0) {
        stash = editor.getText();
        editor.setText("");
        toast("Draft stashed — Ctrl+S restores it.");
      } else if (stash) {
        editor.setText(stash);
        stash = "";
      }
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+r")) {
      if (!busy) void historySearch();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+l")) {
      tui.requestRender();
      return { consume: true };
    }
    // Ctrl+W: kill (copy) current editor line to kill ring.
    if (matchesKey(key, "ctrl+w")) {
      const text = editor.getText();
      if (text) {
        killRing.push(text, { prepend: false, accumulate: false });
        toast(`Copied to kill ring: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
      }
      return { consume: true };
    }
    // Ctrl+Y: yank (paste) from kill ring into editor.
    if (matchesKey(key, "ctrl+y")) {
      const yanked = killRing.peek();
      if (yanked) {
        editor.setText(editor.getText() + yanked);
        tui.requestRender();
      }
      return { consume: true };
    }
    // Ctrl+F: search transcript text (shows matches; does not auto-scroll transcript).
    if (matchesKey(key, "ctrl+f")) {
      void (async () => {
        const result = await promptText("search transcript", searchQuery);
        if (result === null) return;
        const q = result.trim();
        searchQuery = q;
        searchResults = [];
        searchActiveIndex = 0;
        if (!q) {
          toast("Search cancelled (empty query).");
          return;
        }
        const qLower = q.toLowerCase();
        for (let i = 0; i < transcriptLines.length; i++) {
          const line = transcriptLines[i] || "";
          if (line.toLowerCase().includes(qLower)) searchResults.push(i);
        }
        if (searchResults.length === 0) {
          toast("No matches found.");
          return;
        }
        const picked = await pickOne(
          `transcript search (${searchResults.length} match${searchResults.length === 1 ? "" : "es"})`,
          searchResults.slice(0, 200).map((idx) => {
            const ln = (transcriptLines[idx] || "").replace(/\s+/g, " ").trim();
            const snippet = ln.length > 90 ? `${ln.slice(0, 90)}…` : ln || "(empty)";
            return { value: String(idx), label: `L${idx + 1}: ${snippet}`, description: "select to print line to transcript" };
          }),
        );
        if (picked === null) return;
        const idx = Number(picked);
        const ln = transcriptLines[idx] || "";
        say(theme.bold(`search match L${idx + 1}`));
        say(ln || "(empty line)");
        info("Note: transcript search currently lists/prints matches; it does not auto-scroll the live transcript view.");
      })();
      return { consume: true };
    }
    if (matchesKey(key, "shift+tab")) {
      if (!busy) cycleMode();
      return { consume: true };
    }
    // B = tighter safety mode, A = looser safety mode (shift+key to avoid
    // colliding with normal typing while the editor is focused).
    if (matchesKey(key, "shift+b")) {
      if (!busy) cycleSafetyMode("tighter");
      return { consume: true };
    }
    if (matchesKey(key, "shift+a")) {
      if (!busy) cycleSafetyMode("looser");
      return { consume: true };
    }
    return undefined;
  });

  updateSidebar();
  tui.start();
  if (options.initialPrompt?.trim()) {
    const initial = options.initialPrompt;
    // Submit after the UI is ready; slight delay avoids racing initial render/state restore.
    setTimeout(() => {
      if (!exiting) submit(initial);
    }, 0);
  }
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (exiting) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });

  return;
}
