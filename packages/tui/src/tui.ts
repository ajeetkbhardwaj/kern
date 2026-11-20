/**
 * @kern/tui — interactive orchestrator on @earendil-works/pi-tui.
 *
 * Fullscreen alt-screen TUI with scrollable viewport, live inline transcript search,
 * session history replay, streaming Markdown with syntax highlighting, Editor with
 * slash/file/skill completion, command palette, and SelectList overlays.
 * Observes `AgentEvent`s; acts only via `AgentSession`.
 */

import { writeFile, readFile, stat, mkdir, unlink } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { spawn } from "node:child_process";
import type { AgentEvent, AskUserRequest, Logger, ModelAdapter, ThinkingLevel } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import {
  ResourceLoader,
  resolveSkillInvocation,
  SUBAGENT_FORMAT_GUIDE,
  SUBAGENT_PRESETS,
  findSubagentPreset,
  type AgentSession,
  type SubagentConfigEntry,
  type SubagentFileFormat,
  type SubagentStatus,
} from "@kern/coding-agent";
import { CONNECTOR_PRESETS, type McpServerConfigEntry, type McpServerStatus } from "@kern/connects";
import type { SessionManager } from "@kern/session-store";
import {
  clearAuthKey,
  createAdapterFor,
  discoverModels,
  loadAuth,
  loadModelsFile,
  maskKey,
  readLastUsed,
  recordLastUsed,
  resolveApiKey,
  saveAuthKey,
  saveProviderToUserFile,
  testProvider,
  PROVIDER_PRESETS,
  type ModelsFile,
  type ProviderConfig,
} from "@kern/model";
import {
  TuiAltScreen,
  ProcessTerminal,
  Editor,
  SelectList,
  Markdown,
  ScrollView,
  VStack,
  HStack,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  matchesKey,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { KillRing } from "@earendil-works/pi-tui/dist/kill-ring.js";
import { theme, statusBg, buildMarkdownTheme, buildSelectTheme, buildEditorTheme } from "./theme.js";
import { Box, StatusBar, ToolCard, Rule, SidebarPanel, Container, Text, Spacer, CollapsibleText } from "./components.js";
import { buildAutocomplete } from "./autocomplete.js";
import {
  TUI_COMMANDS,
  TUI_HINTS,
  QUICK_HELP,
  INVISIBLE_RE,
  isDestructiveApproval,
  cmdPatternFromPrompt,
  formatReasoningSteps,
  parseBudgetArgs,
  resolveExportPath,
  buildSessionExportMarkdown,
  collectReplayItems,
  loadTuiState,
  saveTuiState,
  summarizeArgs,
  getOverlayOpts,
} from "./helpers.js";

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
  /** Called by the ask-user tool when running interactively. */
  askUserHook?: { current: ((request: AskUserRequest) => Promise<string | null>) | null };
  /** Optional prompt to submit automatically when the TUI starts. */
  initialPrompt?: string;
}

const MAX_QUEUE = 5;

/**
 * Overlay root: renders a framed Box and forwards keys/mouse to the
 * interactive child.
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

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  // Enable Ctrl+F alongside Ctrl+Shift+F for live viewport search.
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.search": ["ctrl+f", "ctrl+shift+f"],
    }),
  );

  const tui = new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
    mouse: true,
    wheelScrollLines: "auto",
    searchMatchStyle: (s) => theme.warn(s),
    searchCurrentMatchStyle: (s) => statusBg(theme.bold(s)),
    searchNavigationButtonStyle: (s, hovered) => (hovered ? theme.accent(s) : theme.muted(s)),
    scrollToEndIndicator: () => statusBg(theme.accent(" ↓ Jump to bottom (Ctrl+End) ")),
  });
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
  const commandCatalog = [...TUI_COMMANDS];
  editor.setAutocompleteProvider(buildAutocomplete(commandCatalog, cwd));

  void new ResourceLoader({ logger })
    .load(cwd)
    .then((project) => {
      if (exiting || project.skills.length === 0) return;
      for (const s of project.skills) {
        commandCatalog.push({
          name: `skill:${s.name}`,
          description: s.description,
        });
      }
      editor.setAutocompleteProvider(buildAutocomplete(commandCatalog, cwd));
    })
    .catch(() => { /* best-effort */ });

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
  let handleAuthError: (message: string) => void = () => {};
  let promptDialog: { cancel: () => void } | null = null;

  const killRing = new KillRing();

  void loadTuiState().then((data) => {
    if (exiting) return;
    if (data.draftText) editor.setText(data.draftText);
    if (data.recentPrompts) recentPrompts.push(...data.recentPrompts);
    if (data.stash) stash = data.stash;
    if (data.queue) queue.push(...data.queue);
    if (data.lastUserPrompt) lastUserPrompt = data.lastUserPrompt;
  });

  // Batched rendering: accumulate render requests at ~60fps.
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
  const MAX_TRANSCRIPT_CHILDREN = 400;
  const detailCards: Array<ToolCard | CollapsibleText> = [];
  const pruneTranscript = () => {
    const children = (transcript as any).children as unknown[] | undefined;
    if (!Array.isArray(children)) return;
    const excess = children.length - MAX_TRANSCRIPT_CHILDREN;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const first = children[0];
      if (!first) break;
      transcript.removeChild(first as any);
      const cardIdx = detailCards.indexOf(first as ToolCard | CollapsibleText);
      if (cardIdx >= 0) detailCards.splice(cardIdx, 1);
    }
  };

  // Toasts live one row above the queue panel.
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

  // Live agent phase indicator.
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

  // Queue panel.
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
  type FileSnapshot = Map<string, Uint8Array | null>;
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
      i += 3;
      if (i > out.length) break;
      const nul = out.indexOf("\0", i);
      if (nul < 0) break;
      let path = out.slice(i, nul);
      i = nul + 1;
      if ((code.startsWith("R") || code.startsWith("C")) && i <= out.length) {
        const nul2 = out.indexOf("\0", i);
        if (nul2 >= 0) {
          path = out.slice(i, nul2);
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
        if (st.size > MAX_SNAPSHOT_FILE_BYTES) continue;
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
        return;
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
      const beforeNorm: FileSnapshot = new Map();
      const afterNorm: FileSnapshot = new Map();
      for (const p of union) {
        let beforeVal: Uint8Array | null = before.has(p) ? (before.get(p) ?? null) : null;
        if (!before.has(p)) {
          const head = await readHeadVersion(p);
          if (head === undefined) continue;
          beforeVal = head;
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

  // --- Layout & sidebar -------------------------------------------------------
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
  const modelUsageHistory = new Map<
    string,
    { provider: string; model: string; switches: number; lastContext?: string; cost: number; input: number; output: number }
  >();
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
        switches: prev?.switches ?? 0,
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

  let apiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const modeLabel = () => {
    const mode = session.approvalMode();
    return mode === "ask" ? "manual" : (mode ?? "manual");
  };

  const updateSidebar = () => {
    try {
      noteModelUsage();
      const cols = process.stdout.columns ?? 80;
      if (cols < 110) {
        sidebarPanel.setSections([
          { key: "info", title: "Session info", lines: [theme.muted("Widen terminal to show panel")], collapsible: false },
        ]);
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
      const mcpServers = session.connects?.listStatuses() ?? [];
      const connectedMcp = mcpServers.filter((s) => s.state === "connected");
      const mcpToolTotal = connectedMcp.reduce((sum, s) => sum + s.tools.length, 0);
      const mcpSummary =
        mcpServers.length === 0
          ? "none (/mcp)"
          : `${connectedMcp.length}/${mcpServers.length} · ${mcpToolTotal} tool(s)`;
      const mcpLines =
        mcpServers.length === 0
          ? [theme.muted("No MCP servers connected. Run /mcp.")]
          : mcpServers.map((s) => {
              const mark =
                s.state === "connected"
                  ? theme.success("●")
                  : s.state === "error"
                    ? theme.error("✖")
                    : s.state === "untrusted"
                      ? theme.warn("!")
                      : theme.muted("○");
              const detail =
                s.state === "connected"
                  ? `${s.tools.length} tool(s)`
                  : s.state;
              return `${mark} ${s.name} ${theme.muted(`(${s.transport} · ${detail})`)}`;
            });
      const teamAgents = session.subagents?.listStatuses() ?? [];
      const readyAgents = teamAgents.filter((a) => a.state === "ready");
      const activeBg = session.subagents?.listBackgroundJobs().filter((j) => j.running).length ?? 0;
      const teamSummary =
        teamAgents.length === 0
          ? "none (/agents)"
          : `${readyAgents.length}/${teamAgents.length} ready${activeBg > 0 ? ` · ${activeBg} bg` : ""}`;
      const teamLines =
        teamAgents.length === 0
          ? [theme.muted("No subagents configured (solo mode). Run /agents.")]
          : teamAgents.map((a) => {
              const mark =
                a.state === "ready"
                  ? theme.success("●")
                  : a.state === "untrusted"
                    ? theme.warn("!")
                    : a.state === "error"
                      ? theme.error("✖")
                      : theme.muted("○");
              const detail = a.type === "a2a" ? "a2a" : `${a.mode}/${a.isolation}`;
              return `${mark} ${a.name} ${theme.muted(`(${detail} · ${a.state})`)}`;
            });
      sidebarPanel.setSections([
        {
          key: "session",
          title: "Session",
          collapsible: true,
          lines: [
            `${theme.muted("Model")}`,
            `  ${m.provider}/${m.modelId}`,
            `${theme.muted("Think")} ${session.thinkingMode()}`,
            `${theme.muted("ID")} ${sessionId}`,
            `${theme.muted("Name")} ${sessionName}`,
            `${theme.muted("Mode")} ${modeLabel()} · ${session.safetyMode?.() ?? "balanced"}`,
            `${theme.muted("MCP")} ${mcpSummary}`,
            `${theme.muted("Team")} ${teamSummary}`,
            `${theme.muted("State")} ${busy ? `running (${activity})` : "ready"}`,
            `${theme.muted("CWD")}`,
            `  ${cwd}`,
          ],
        },
        {
          key: "connects",
          title: "Connectors (MCP)",
          collapsible: true,
          defaultExpanded: mcpServers.length > 0,
          lines: mcpLines,
        },
        {
          key: "subagents",
          title: "Subagents (Team)",
          collapsible: true,
          defaultExpanded: teamAgents.length > 0,
          lines: teamLines,
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
                ...(limits.maxTurns ? [`${theme.muted("max turns")} ${limits.maxTurns}`] : []),
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

  const printHeader = () => {
    const m = session.modelInfo();
    const name = session.sessionName() ? `  ·  ${session.sessionName()}` : "";
    transcript.addChild(new Spacer(1));
    transcript.addChild(
      new Text(
        `${theme.bold("kern v1.0.0")}  ${theme.muted(`${m.provider}/${m.modelId}${name} · ${modeLabel()} · think:${session.thinkingMode()} · ${cwd}`)}`,
        0,
        0,
      ),
    );
    info("Type a task, /help for commands, or Ctrl+P for palette.");
    info(TUI_HINTS);
    info(QUICK_HELP);
    transcript.addChild(new Rule());
    lastTranscriptBlock = "other";
    pruneTranscript();
    requestRender();
  };

  const replaySessionHistory = () => {
    const { items, userTurns } = collectReplayItems(manager.getActivePath());
    const u = session.budgetUsage();
    apiUsage = { input: u.inputTokens, output: u.outputTokens, cacheRead: 0, cacheWrite: 0 };
    turnNumber = userTurns;
    if (items.length === 0) return;

    info(`Replaying ${items.length} history item${items.length === 1 ? "" : "s"}…`);
    for (const item of items) {
      if (item.kind === "user") {
        addTranscriptGap(true);
        transcript.addChild(new Text(theme.user("you"), 0, 0));
        transcript.addChild(new Text(item.text, 0, 0));
        lastTranscriptBlock = "user";
      } else if (item.kind === "reasoning") {
        if (lastTranscriptBlock !== "reasoning" && lastTranscriptBlock !== "tool") addTranscriptGap();
        const block = new CollapsibleText("thinking", { expanded: false, style: theme.muted });
        block.setText(item.text);
        detailCards.push(block);
        transcript.addChild(block);
        lastTranscriptBlock = "reasoning";
      } else if (item.kind === "assistant") {
        if (lastTranscriptBlock !== "user") addTranscriptGap();
        transcript.addChild(new Text(theme.accent("assistant"), 0, 0));
        transcript.addChild(new Markdown(item.text, 0, 0, buildMarkdownTheme()));
        lastTranscriptBlock = "assistant";
      } else if (item.kind === "tool") {
        if (lastTranscriptBlock !== "tool" && lastTranscriptBlock !== "reasoning") {
          transcript.addChild(new Spacer(1));
        }
        const card = new ToolCard(item.toolName, item.argsSummary);
        if (item.output) card.appendOutput(item.output);
        if (item.done) card.finish(item.isError);
        detailCards.push(card);
        transcript.addChild(card);
        lastTranscriptBlock = "tool";
      } else if (item.kind === "checkpoint") {
        addTranscriptGap(true);
        transcript.addChild(new Text(theme.accent(`[${item.label}]`), 0, 0));
        transcript.addChild(new Markdown(item.summary, 0, 0, buildMarkdownTheme()));
        lastTranscriptBlock = "other";
      }
      pruneTranscript();
    }
    requestRender();
  };

  const toggleAllDetails = (force?: boolean) => {
    if (detailCards.length === 0) {
      toast("No collapsible thinking or tool cards in transcript.");
      return;
    }
    const next = force ?? detailCards.some((c) => !c.isExpanded());
    for (const c of detailCards) c.setExpanded(next);
    toast(`${next ? "Expanded" : "Collapsed"} ${detailCards.length} detail card${detailCards.length === 1 ? "" : "s"}.`);
    requestRender();
  };

  const openLiveSearch = (initialQuery?: string) => {
    const anyTui = tui as unknown as {
      activeSearch?: { component?: { input?: { setValue?: (v: string) => void } } };
      toggleSearch?: () => void;
      updateSearchQuery?: (q: string) => void;
    };
    if (typeof anyTui.toggleSearch !== "function") {
      toast("Live search is unavailable on this terminal.");
      return;
    }
    if (!anyTui.activeSearch) {
      anyTui.toggleSearch();
    }
    if (initialQuery && initialQuery.trim()) {
      anyTui.activeSearch?.component?.input?.setValue?.(initialQuery.trim());
      anyTui.updateSearchQuery?.(initialQuery.trim());
    }
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
        printStatus();
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
    const think = session.thinkingMode();
    const scrollBadge = tui.isFollowingOutput ? [] : [theme.warn("↑ scrolled")];
    statusBar.setSegments([
      `${m.provider}/${m.modelId}${sessionName}`,
      modeLabel(),
      `think: ${think}`,
      `safety: ${safetyMode}`,
      ctx,
      ...scrollBadge,
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
      if (limits.maxTurns || limits.maxTotalToolCalls || limits.maxToolCallsPerTurn || limits.maxWallTimeMs) {
        say(
          `  guards: turns=${limits.maxTurns || "∞"}, toolCalls=${limits.maxTotalToolCalls || "∞"}, perTurn=${limits.maxToolCallsPerTurn || "∞"}, wallMs=${limits.maxWallTimeMs || "∞"}`,
        );
      }
    } else {
      info("  limits: unavailable from session runtime");
    }
    if (u.byModel && Object.keys(u.byModel).length > 0) {
      say(theme.bold("  per-model:"));
      for (const [model, mu] of Object.entries(u.byModel)) {
        say(`    ${model}: $${mu.cost.toFixed(4)} · ${mu.input.toLocaleString()} in / ${mu.output.toLocaleString()} out`);
      }
    }
    info("Tip: update live with `/budget maxCost=0.05 maxTurns=12` (0 resets to unlimited)");
  };

  // --- event → transcript -----------------------------------------------------
  let md: Markdown | null = null;
  let mdText = "";
  let reasoningView: CollapsibleText | null = null;
  let reasoningBuffer = "";
  let turnNumber = 0;
  const cards = new Map<string, ToolCard>();
  let lastTranscriptBlock: "none" | "user" | "assistant" | "reasoning" | "tool" | "other" = "none";

  const pendingApprovals = new Set<(value: string | null) => void>();
  const denyPendingApprovals = () => {
    if (pendingApprovals.size === 0) return;
    for (const finish of [...pendingApprovals]) finish(null);
    pendingApprovals.clear();
  };
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

  const renderUserPrompt = (text: string, label = "you") => {
    addTranscriptGap(true);
    transcript.addChild(new Text(theme.user(label), 0, 0));
    transcript.addChild(new Text(text, 0, 0));
    lastTranscriptBlock = "user";
    pruneTranscript();
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
    detailCards.push(reasoningView);
    transcript.addChild(reasoningView);
    lastTranscriptBlock = "reasoning";
    pruneTranscript();
    requestRender();
  };

  const showAuthCard = (message: string) => {
    addTranscriptGap(true);
    transcript.addChild(new Text(theme.error("Auth failed — the model rejected our credentials."), 0, 0));
    transcript.addChild(new Text(theme.muted(message), 0, 0));
    transcript.addChild(new Text(theme.muted("Pick a fix in the dialog above (Esc dismisses). /login re-auths, /logout clears keys, /model switches."), 0, 0));
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
            noteModelUsage();
            updateSidebar();
            requestRender();
            break;
          case "tool_execution_start": {
            closeAssistant();
            setActivity(`tool: ${event.toolName}`);
            const card = new ToolCard(event.toolName, summarizeArgs(event.arguments));
            cards.set(event.toolCallId, card);
            detailCards.push(card);
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
            const output = event.result ? event.result.content.map((c) => c.text).join("\n") : "";
            if (card) {
              if (output && (!card.hasOutput() || event.isError)) card.appendOutput(output);
              if (event.isError && !card.hasOutput()) card.appendOutput(`Tool ${event.toolName} failed.`);
              card.finish(event.isError);
              lastTranscriptBlock = "tool";
            } else {
              say(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
              if (output) info(output.split("\n").slice(0, 20).join("\n"));
            }
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
                  `Budget exceeded (${kind || "unknown"}). Current: $${u.cost.toFixed(4)} cost, ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out tok. Tip: adjust with /budget maxCost=...`,
                );
              } else {
                info("Budget exceeded. Adjust with /budget maxCost=... or --max-total-tokens.");
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
      }
    });
  };
  subscribe();

  const showDialog = (content: Component, target: Component, framed = true): OverlayHandle => {
    const root = framed ? new Box(content, {}) : content;
    return tui.showOverlay(new OverlayDialog(root, target), getOverlayOpts());
  };

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
    const danger = isDestructiveApproval(prompt, argsFull);
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

  if (options.askUserHook) {
    options.askUserHook.current = async (req: AskUserRequest): Promise<string | null> => {
      if (exiting) return null;
      if (req.options && req.options.length > 0) {
        const allowCustom = req.allowCustom !== false;
        const items = [
          ...req.options.map((opt) => ({ value: opt, label: opt })),
          ...(allowCustom ? [{ value: "__custom__", label: "Other (type custom answer)…" }] : []),
        ];
        const picked = await pickOne(req.question, items);
        if (picked === null) {
          info("Question cancelled.");
          return null;
        }
        if (picked === "__custom__") {
          const typed = await promptText(req.question, "");
          if (typed === null || !typed.trim()) {
            info("Question cancelled.");
            return null;
          }
          const ans = typed.trim();
          info(`Answered: ${ans}`);
          return ans;
        }
        info(`Answered: ${picked}`);
        return picked;
      }
      const typed = await promptText(req.question, "");
      if (typed === null || !typed.trim()) {
        info("Question cancelled.");
        return null;
      }
      const ans = typed.trim();
      info(`Answered: ${ans}`);
      return ans;
    };
  }

  // --- transcript export ----------------------------------------------------------
  const exportTranscript = async (file?: string): Promise<void> => {
    const resolved = resolveExportPath(cwd, file, manager.sessionId);
    if (!resolved.ok) {
      err(resolved.error);
      return;
    }
    const markdown = buildSessionExportMarkdown(manager.getActivePath(), {
      ...session.modelInfo(),
      cwd,
    });
    await writeFile(resolved.path, markdown, "utf8");
    ok(`Exported to ${resolved.path}`);
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

  // --- overlays -------------------------------------------------
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

  const openCommandPalette = async () => {
    const items = commandCatalog.map((c) => ({
      value: `/${c.name}`,
      label: `/${c.name}`,
      description: c.shortcut ? `${c.description} [${c.shortcut}]` : c.description,
    }));
    const list = new SelectList(items, 14, buildSelectTheme());
    await withOverlay("command palette (type to filter · Esc closes)", list, async (cmd) => {
      if (cmd.startsWith("/skill:")) {
        editor.setText(`${cmd} `);
        tui.requestRender();
        return;
      }
      const keep = await runCommand(cmd);
      if (!keep) exit();
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
          const isLastUsed = !isCurrent && lastUsed?.provider === m.provider && lastUsed?.model === m.id;
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
        printStatus();
      } catch (error) {
        err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  const pickThinkingLevel = async (arg?: string) => {
    if (busy) {
      toast("Wait for the current turn to settle before changing thinking level.");
      return;
    }
    const trimmed = (arg ?? "").trim().toLowerCase();
    const valid: ThinkingLevel[] = ["off", "low", "medium", "high"];
    if (trimmed) {
      if (!valid.includes(trimmed as ThinkingLevel)) {
        err(`Invalid thinking level "${trimmed}". Use: off, low, medium, high.`);
        return;
      }
      await session.setThinkingLevel(trimmed as ThinkingLevel);
      toast(`Thinking level: ${trimmed}`);
      printStatus();
      return;
    }
    const current = session.thinkingMode();
    const descriptions: Record<ThinkingLevel, string> = {
      off: "Disable explicit reasoning budget",
      low: "Light reasoning overhead",
      medium: "Balanced reasoning effort (default)",
      high: "Deep extended reasoning effort",
    };
    const list = new SelectList(
      valid.map((level) => ({
        value: level,
        label: `${level}${level === current ? "  (current)" : ""}`,
        description: descriptions[level],
      })),
      4,
      buildSelectTheme(),
    );
    await withOverlay("thinking level", list, async (value) => {
      await session.setThinkingLevel(value as ThinkingLevel);
      toast(`Thinking level: ${value}`);
      printStatus();
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
      const okSet = session.setSafetyMode(value as "strict" | "balanced" | "restricted" | "autonomous");
      if (okSet) {
        toast(`Safety mode: ${value}`);
        printStatus();
      } else {
        err("Failed to set safety mode");
      }
    });
  };

  const pickBudget = async (arg?: string) => {
    if (arg && arg.trim()) {
      if (busy) {
        toast("Wait for the current turn to settle before adjusting budget.");
        return;
      }
      if (arg.trim().toLowerCase() === "set") {
        const typed = await promptText("budget limits (e.g. maxCost=0.05 maxTurns=12, 0=unlimited)", "");
        if (typed === null || !typed.trim()) return;
        await pickBudget(typed);
        return;
      }
      const parsed = parseBudgetArgs(arg);
      if (!parsed.ok) {
        err(parsed.error);
        return;
      }
      if (Object.keys(parsed.limits).length === 0) {
        printBudgetDetails();
        return;
      }
      if (session.setBudgetLimits) {
        session.setBudgetLimits(parsed.limits);
        ok("Live budget limits updated.");
        printBudgetDetails();
      } else {
        err("Live budget updates are unavailable for this session.");
      }
      return;
    }

    printBudgetDetails();
  };

  /** `/login [provider]` wizard: provider → key → test → model → save. Esc cancels cleanly. */
  const runLogin = async (arg?: string): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before logging in to a provider.");
      return;
    }
    const authStore = await loadAuth();
    const configuredProviders = options.modelsFile.providers ?? {};
    const requested = arg?.trim();

    let name: string;
    let baseUrl: string;
    let presetEnv = "";
    let picked: string | null = null;

    if (requested) {
      picked = requested;
    } else {
      const seen = new Set<string>();
      const candidateItems: Array<{ value: string; label: string; description: string }> = [];

      for (const [cfgName, cfg] of Object.entries(configuredProviders)) {
        seen.add(cfgName);
        const saved = authStore[cfgName]?.apiKey;
        const badge = saved ? `logged in (${maskKey(saved)})` : "configured";
        candidateItems.push({
          value: cfgName,
          label: cfgName,
          description: `${cfg.baseUrl} · ${badge}`,
        });
      }

      for (const p of PROVIDER_PRESETS) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        const saved = authStore[p.name]?.apiKey;
        const badge = saved ? `logged in (${maskKey(saved)}) · ${p.hint}` : p.hint;
        candidateItems.push({
          value: p.name,
          label: p.name,
          description: `${p.baseUrl} · ${badge}`,
        });
      }

      candidateItems.push({ value: "__custom__", label: "Custom…", description: "enter name + base URL manually" });
      picked = await pickOne("login — provider", candidateItems);
      if (picked === null) {
        toast("Login cancelled.");
        return;
      }
    }

    if (picked === "__custom__") {
      const rawName = await promptText("provider name ([a-z0-9.-], Esc cancels)");
      if (rawName === null) {
        toast("Login cancelled.");
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
        toast("Login cancelled.");
        return;
      }
      baseUrl = rawUrl.trim();
      if (!/^https?:\/\//i.test(baseUrl)) {
        err(`Bad baseUrl ${JSON.stringify(rawUrl)} — must start with http:// or https://.`);
        return;
      }
    } else if (configuredProviders[picked]) {
      const cfg = configuredProviders[picked]!;
      const preset = PROVIDER_PRESETS.find((p) => p.name === picked);
      name = picked;
      baseUrl = cfg.baseUrl;
      presetEnv = cfg.apiKeyEnv ?? preset?.apiKeyEnv ?? "";
    } else {
      const preset = PROVIDER_PRESETS.find((p) => p.name === picked);
      if (preset) {
        name = preset.name;
        baseUrl = preset.baseUrl;
        presetEnv = preset.apiKeyEnv;
      } else {
        const clean = picked.trim().toLowerCase();
        if (!/^[a-z0-9.-]{1,32}$/.test(clean)) {
          err(`Bad provider name ${JSON.stringify(picked)} — use [a-z0-9.-] (up to 32 chars).`);
          return;
        }
        name = clean;
        const rawUrl = await promptText(`base URL for ${name}`, "http://localhost:11434/v1");
        if (rawUrl === null) {
          toast("Login cancelled.");
          return;
        }
        baseUrl = rawUrl.trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
          err(`Bad baseUrl ${JSON.stringify(rawUrl)} — must start with http:// or https://.`);
          return;
        }
      }
    }

    const askKey = async (): Promise<string | undefined | null> => {
      const choice = await pickOne("login — API key", [
        { value: "enter", label: "Enter key", description: "paste the API key (stored in ~/.kern/auth.json)" },
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
      toast("Login cancelled.");
      return;
    }

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
        ok(`Logged in to ${name}: ${liveModels.length} model(s) found.`);
        break;
      }
      err(`Test failed: ${result.message}`);
      const fix = await pickOne("login — test failed", [
        { value: "url", label: "Edit URL", description: baseUrl },
        { value: "key", label: "Edit key", description: "re-enter credential" },
        { value: "manual", label: "Enter model id manually", description: "skip the live test" },
        { value: "cancel", label: "Cancel", description: "write nothing (Esc)" },
      ]);
      if (fix === null || fix === "cancel") {
        toast("Login cancelled.");
        return;
      }
      if (fix === "url") {
        const typed = await promptText("base URL", baseUrl);
        if (typed === null) {
          toast("Login cancelled.");
          return;
        }
        baseUrl = typed.trim();
        continue;
      }
      if (fix === "key") {
        const k = await askKey();
        if (k === null) {
          toast("Login cancelled.");
          return;
        }
        apiKey = k;
        continue;
      }
      const typed = await promptText("model id");
      if (typed === null || !typed.trim()) {
        toast("Login cancelled.");
        return;
      }
      manualId = typed.trim();
      break;
    }

    let modelId = manualId;
    if (!modelId) {
      if (liveModels.length === 0) {
        toast("No models returned — enter one manually.");
        const typed = await promptText("model id");
        if (typed === null || !typed.trim()) {
          toast("Login cancelled.");
          return;
        }
        modelId = typed.trim();
      } else {
        const choice = await pickOne("login — model", [
          ...liveModels.map((m) => ({ value: m, label: m, description: "live" })),
          { value: "__manual__", label: "Enter model id manually…", description: "" },
        ]);
        if (choice === null) {
          toast("Login cancelled.");
          return;
        }
        if (choice === "__manual__") {
          const typed = await promptText("model id");
          if (typed === null || !typed.trim()) {
            toast("Login cancelled.");
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
      toast("Login cancelled.");
      return;
    }
    let apiKeyEnvOut: string | undefined = presetEnv || undefined;
    const envMatch = apiKey?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (envMatch?.[1]) apiKeyEnvOut = envMatch[1];
    const cfg: ProviderConfig = {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyEnvOut ? { apiKeyEnv: apiKeyEnvOut } : {}),
      models: [{ id: modelId }],
    };
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

  /** `/logout [provider|--all]`: clear saved provider credentials from ~/.kern/auth.json. */
  const runLogout = async (arg?: string): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before logging out.");
      return;
    }
    const auth = await loadAuth();
    const providers = Object.keys(auth);
    if (providers.length === 0) {
      toast("No saved provider credentials in ~/.kern/auth.json (unset env vars in your shell if set).");
      return;
    }

    const activeProvider = session.modelInfo().provider;
    const requested = arg?.trim();
    const targets: string[] = [];

    if (requested === "--all" || requested === "all") {
      targets.push(...providers);
    } else if (requested) {
      if (!auth[requested]) {
        err(`No saved credentials for "${requested}" in ~/.kern/auth.json (saved: ${providers.join(", ")}).`);
        return;
      }
      targets.push(requested);
    } else {
      const picked = await pickOne("logout — select provider to clear", [
        ...providers.map((p) => ({
          value: p,
          label: p,
          description: `${maskKey(auth[p]?.apiKey ?? "")}${p === activeProvider ? " · active" : ""}`,
        })),
        ...(providers.length > 1
          ? [{ value: "__all__", label: "All providers", description: `clear all ${providers.length} saved credential(s)` }]
          : []),
      ]);
      if (picked === null) {
        toast("Logout cancelled.");
        return;
      }
      if (picked === "__all__") {
        targets.push(...providers);
      } else {
        targets.push(picked);
      }
    }

    for (const p of targets) {
      await clearAuthKey(p);
    }
    ok(`Logged out of ${targets.join(", ")} (removed from ~/.kern/auth.json).`);
    if (targets.includes(activeProvider)) {
      toast(`Active provider "${activeProvider}" credentials cleared — use /login ${activeProvider} or /model to switch.`);
    }
    options.modelsFile = await loadModelsFile(cwd).catch(() => options.modelsFile);
    printStatus();
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
  const cycleSafetyMode = (direction: "tighter" | "looser") => {
    if (busy) {
      toast("Mode changes apply when idle.");
      return;
    }
    const current = (session.safetyMode?.() ?? "balanced") as "strict" | "balanced" | "restricted" | "autonomous";
    const idx = SAFETY_MODES.indexOf(current);
    if (idx === -1) return;
    const next =
      direction === "tighter"
        ? SAFETY_MODES[Math.max(0, idx - 1)]
        : SAFETY_MODES[Math.min(SAFETY_MODES.length - 1, idx + 1)];
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

  const runReauth = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before re-authenticating.");
      return;
    }
    const current = session.modelInfo();
    const cfg = (options.modelsFile.providers ?? {})[current.provider];
    if (!cfg) {
      err(`Unknown provider ${JSON.stringify(current.provider)} — use /login to add it.`);
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

  const resetTranscriptForRuntime = (next: { session: AgentSession; manager: SessionManager }) => {
    unsubscribe?.();
    const prevSession = session;
    session = next.session;
    manager = next.manager;
    if (prevSession && prevSession !== next.session) {
      void prevSession.subagents?.dispose().catch(() => {});
      void prevSession.connects?.dispose().catch(() => {});
      prevSession.dispose();
    }
    queue = [];
    cards.clear();
    detailCards.length = 0;
    modelUsageHistory.clear();
    apiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
    replaySessionHistory();
    printStatus();
  };

  const switchSessionTo = async (file: string): Promise<void> => {
    try {
      const next = await session.switchSession?.(file);
      if (!next) {
        toast("Session switch is unavailable right now.");
        return;
      }
      resetTranscriptForRuntime(next);
      ok(`Session switched: ${file}`);
    } catch (error) {
      err(`Session switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const forkActiveSession = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before forking.");
      return;
    }
    try {
      const next = await session.fork?.();
      if (!next) {
        toast("Session fork is unavailable right now.");
        return;
      }
      resetTranscriptForRuntime(next);
      ok(`Forked to new session ${next.manager.sessionId ?? ""}`.trim());
    } catch (error) {
      err(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sessionSwitcher = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before switching sessions.");
      return;
    }
    try {
      const items = (await manager.listSessions?.()) ?? [];
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
      body.addChild(new Text(theme.muted("Select a saved session to load and replay its transcript."), 0, 0));
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
    say(`  ${theme.muted("id")}     ${id}`);
    say(`  ${theme.muted("name")}   ${name}`);
    say(`  ${theme.muted("model")}  ${m.provider}/${m.modelId}`);
    say(`  ${theme.muted("think")}  ${session.thinkingMode()}`);
    say(`  ${theme.muted("cwd")}    ${cwd}`);
    say(`  ${theme.muted("path")}   ${String(path)}`);
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
        { value: "fork", label: "Fork session", description: "branch current conversation to a new session" },
        { value: "rename", label: "Rename session", description: "set a name for this session" },
        { value: "new", label: "New session", description: "start a fresh session" },
        { value: "info", label: "Session info", description: "show id, name, path, model" },
        { value: "export", label: "Export transcript", description: "save transcript to markdown" },
      ]);
      if (choice === null) return;
      if (choice === "switch") return sessionSwitcher();
      if (choice === "fork") return forkActiveSession();
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
    if (sub === "fork") {
      await forkActiveSession();
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
    err(`Unknown session action: ${sub}. Try /session, /session switch, /session fork, /session rename, /session new, /session info.`);
  };

  const printMcpStatus = (servers: McpServerStatus[]) => {
    say(theme.bold("mcp connectors"));
    if (servers.length === 0) {
      info("  No MCP servers configured. Use `/mcp` to add a preset, remote HTTP/SSE server, or stdio server.");
      return;
    }
    for (const s of servers) {
      const badge =
        s.state === "connected"
          ? theme.success(`connected · ${s.tools.length} tool(s)${s.deferred ? " (deferred)" : ""}`)
          : s.state === "error"
            ? theme.error(`error: ${s.error ?? "failed"}`)
            : s.state === "untrusted"
              ? theme.warn(`untrusted (run /mcp trust ${s.name})`)
              : theme.muted(s.state);
      say(`  ${theme.accent(s.name)}  ${theme.muted(`${s.transport} · ${s.origin}`)}  ${badge}`);
      info(`    target: ${s.target}`);
      if (s.tools.length > 0) {
        info(`    tools: ${s.tools.map((t) => t.registeredName).join(", ")}`);
      }
      if (s.resources.length > 0) {
        info(`    resources: ${s.resources.map((r) => r.uri).join(", ")}`);
      }
      if (s.prompts.length > 0) {
        info(`    prompts: ${s.prompts.map((p) => p.name).join(", ")}`);
      }
      if (s.warning) {
        info(`    warning: ${s.warning}`);
      }
    }
  };

  const inspectMcpServer = (s: McpServerStatus) => {
    say(theme.bold(`mcp · ${s.name}`));
    info(`  transport: ${s.transport} (${s.origin}) · state: ${s.state}${s.deferred ? " · deferred (via mcp_tool_search)" : ""}`);
    info(`  target: ${s.target}`);
    if (s.serverInfo?.name) info(`  serverInfo: ${s.serverInfo.name}${s.serverInfo.version ? ` v${s.serverInfo.version}` : ""}`);
    if (s.error) err(`  error: ${s.error}`);
    if (s.warning) info(`  warning: ${s.warning}`);
    if (s.tools.length > 0) {
      say(theme.muted(`  tools (${s.tools.length}):`));
      for (const t of s.tools) {
        say(`    ${theme.accent(t.registeredName)}${t.description ? theme.muted(` — ${t.description}`) : ""}`);
      }
    } else {
      info("  tools: none");
    }
    if (s.resources.length > 0) {
      say(theme.muted(`  resources (${s.resources.length}):`));
      for (const r of s.resources) {
        say(`    ${r.uri}${r.description ? theme.muted(` — ${r.description}`) : ""}`);
      }
    }
    if (s.prompts.length > 0) {
      say(theme.muted(`  prompts (${s.prompts.length}):`));
      for (const p of s.prompts) {
        say(`    ${p.name}${p.description ? theme.muted(` — ${p.description}`) : ""}`);
      }
    }
  };

  const connectAndReportMcp = async (name: string, entry: McpServerConfigEntry, scope: "user" | "project" | "memory") => {
    const mgr = session.connects;
    if (!mgr) {
      err("MCP connects manager is unavailable on this session.");
      return;
    }
    toast(`Connecting MCP server "${name}"…`);
    try {
      const status = await mgr.addServer(name, entry, { scope });
      updateSidebar();
      printStatus();
      if (status.state === "connected") {
        ok(`Connected MCP "${status.name}" (${status.tools.length} tool(s), ${status.resources.length} resource(s), ${status.prompts.length} prompt(s)).`);
        if (status.tools.length > 0) info(`  tools: ${status.tools.map((t) => t.registeredName).join(", ")}`);
      } else if (status.state === "error") {
        err(`Saved "${status.name}" (${scope}), but connection failed: ${status.error ?? "unknown error"}`);
      } else {
        info(`Saved "${status.name}" (${scope}): state=${status.state}`);
      }
    } catch (error) {
      err(`Failed adding MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runMcpWizard = async (): Promise<void> => {
    const mgr = session.connects;
    if (!mgr) {
      err("MCP connects manager is unavailable on this session.");
      return;
    }
    if (busy) {
      toast("Wait for the current turn to settle before modifying MCP connectors.");
      return;
    }

    const servers = mgr.listStatuses();
    const menuItems: Array<{ value: string; label: string; description?: string }> = [
      { value: "__preset__", label: "Connect preset…", description: "Context7, GitHub, Playwright, Filesystem, Postgres, Linear, Notion…" },
      { value: "__remote__", label: "Add remote HTTP / SSE MCP URL…", description: "Connect hosted MCP endpoint (Streamable HTTP or SSE)" },
      { value: "__stdio__", label: "Add local stdio MCP command…", description: "Spawn local MCP server (npx, uvx, node, python…)" },
      { value: "__reload__", label: "Reload & reconnect all", description: "Re-read ~/.kern/mcp.json and .mcp.json" },
      ...servers.map((s) => ({
        value: `server:${s.name}`,
        label: `${s.state === "connected" ? "●" : s.state === "error" ? "✖" : s.state === "untrusted" ? "!" : "○"} ${s.name}`,
        description: `${s.transport} · ${s.state}${s.state === "connected" ? ` · ${s.tools.length} tool(s)` : ""}`,
      })),
    ];

    const pick = await pickOne("mcp connectors", menuItems);
    if (pick === null) return;

    if (pick === "__reload__") {
      toast("Reloading MCP connectors…");
      const res = await mgr.discoverAndConnect();
      updateSidebar();
      printStatus();
      printMcpStatus(res.servers);
      return;
    }

    if (pick === "__preset__") {
      const presetId = await pickOne(
        "mcp — choose preset",
        CONNECTOR_PRESETS.map((p) => ({
          value: p.id,
          label: `${p.name} (${p.id})`,
          description: `${p.transport} · ${p.description}`,
        })),
      );
      if (!presetId) return;
      const preset = CONNECTOR_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;

      const entry: McpServerConfigEntry = {
        ...preset.entry,
        ...(preset.entry.args ? { args: [...preset.entry.args] } : {}),
        ...(preset.entry.env ? { env: { ...preset.entry.env } } : {}),
        ...(preset.entry.headers ? { headers: { ...preset.entry.headers } } : {}),
      };

      for (const v of preset.variables ?? []) {
        const val = await promptText(
          `${v.label}${v.required ? " (required)" : " (optional, empty to skip)"}`,
          v.placeholder ?? "",
        );
        if (val === null) {
          toast("MCP preset cancelled.");
          return;
        }
        const trimmed = val.trim();
        if (!trimmed) {
          if (v.required) {
            err(`${v.key} is required for ${preset.name}.`);
            return;
          }
          if (v.target === "header" && v.headerName && entry.headers) {
            delete entry.headers[v.headerName];
          }
          continue;
        }
        if (v.target === "env") {
          entry.env = { ...(entry.env ?? {}), [v.key]: trimmed };
        } else if (v.target === "header" && v.headerName) {
          const formatted = v.headerName.toLowerCase() === "authorization" && !/^bearer\s+/i.test(trimmed) && !trimmed.startsWith("${")
            ? `Bearer ${trimmed}`
            : trimmed;
          entry.headers = { ...(entry.headers ?? {}), [v.headerName]: formatted };
        } else if (v.target === "arg" && entry.args) {
          entry.args = entry.args.map((a) => a.replace(`\${${v.key}}`, trimmed));
        } else if (v.target === "url" && entry.url) {
          entry.url = entry.url.replace(`\${${v.key}}`, trimmed);
        }
      }

      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/mcp.json)", description: "available in all workspaces" },
        { value: "project", label: "Project (.mcp.json)", description: "saved in current repo" },
      ]);
      if (!scope) return;
      await connectAndReportMcp(preset.id, entry, scope as "user" | "project");
      return;
    }

    if (pick === "__remote__") {
      const name = (await promptText("server name ([A-Za-z0-9_.-])"))?.trim();
      if (!name) return;
      const url = (await promptText("MCP server URL", "https://"))?.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        err("URL must start with http:// or https://");
        return;
      }
      const transport = await pickOne("remote transport", [
        { value: "http", label: "Streamable HTTP (recommended)", description: "POST JSON-RPC + Mcp-Session-Id" },
        { value: "sse", label: "Legacy HTTP + SSE", description: "GET event:endpoint + POST" },
      ]);
      if (!transport) return;
      const authVal = await promptText("Bearer token / Authorization header (optional, Esc cancels)", "");
      if (authVal === null) return;
      const token = authVal.trim();
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/mcp.json)", description: "available in all workspaces" },
        { value: "project", label: "Project (.mcp.json)", description: "saved in current repo" },
      ]);
      if (!scope) return;
      const entry: McpServerConfigEntry = {
        transport: transport as "http" | "sse",
        url,
        ...(token ? { headers: { Authorization: /^bearer\s+/i.test(token) ? token : `Bearer ${token}` } } : {}),
      };
      await connectAndReportMcp(name, entry, scope as "user" | "project");
      return;
    }

    if (pick === "__stdio__") {
      const name = (await promptText("server name ([A-Za-z0-9_.-])"))?.trim();
      if (!name) return;
      const cmdLine = (await promptText("command + args (e.g. npx -y @modelcontextprotocol/server-memory)"))?.trim();
      if (!cmdLine) return;
      const parts = cmdLine.split(/\s+/).filter(Boolean);
      const command = parts[0]!;
      const args = parts.slice(1);
      const envRaw = await promptText("env vars (KEY=VAL comma-separated, optional)", "");
      if (envRaw === null) return;
      const env: Record<string, string> = {};
      for (const pair of envRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/mcp.json)", description: "available in all workspaces" },
        { value: "project", label: "Project (.mcp.json)", description: "saved in current repo (auto-trusted)" },
      ]);
      if (!scope) return;
      const entry: McpServerConfigEntry = {
        transport: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      await connectAndReportMcp(name, entry, scope as "user" | "project");
      return;
    }

    if (pick.startsWith("server:")) {
      const serverName = pick.slice(7);
      const target = mgr.getServerStatus(serverName);
      if (!target) return;
      const action = await pickOne(`mcp · ${serverName} (${target.state})`, [
        { value: "inspect", label: "Inspect tools, resources & prompts", description: `${target.tools.length} tool(s)` },
        { value: "reconnect", label: "Reconnect / test connection", description: "re-establish transport and refresh tools" },
        ...(target.state === "untrusted"
          ? [{ value: "trust", label: "Trust project stdio server", description: "approve fingerprint in ~/.kern/mcp-trust.json" }]
          : []),
        {
          value: target.disabled ? "enable" : "disable",
          label: target.disabled ? "Enable server" : "Disable server",
          description: target.disabled ? "reconnect and expose tools" : "disconnect without deleting config",
        },
        { value: "remove", label: "Remove server", description: "disconnect and delete from mcp.json" },
      ]);
      if (!action) return;
      if (action === "inspect") {
        inspectMcpServer(target);
      } else if (action === "reconnect") {
        toast(`Reconnecting "${serverName}"…`);
        const next = await mgr.reconnectServer(serverName);
        updateSidebar();
        printStatus();
        inspectMcpServer(next);
      } else if (action === "trust") {
        const next = await mgr.trustServer(serverName);
        updateSidebar();
        printStatus();
        inspectMcpServer(next);
      } else if (action === "disable" || action === "enable") {
        const next = await mgr.toggleServer(serverName, action === "disable");
        updateSidebar();
        printStatus();
        ok(`${serverName}: ${next.state}`);
      } else if (action === "remove") {
        await mgr.removeServer(serverName);
        updateSidebar();
        printStatus();
        ok(`Removed MCP server "${serverName}".`);
      }
    }
  };

  const runMcpCommand = async (arg: string): Promise<void> => {
    const mgr = session.connects;
    if (!mgr) {
      err("MCP connects manager is unavailable on this session.");
      return;
    }
    const tokens = arg.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "").toLowerCase();
    if (!sub) {
      await runMcpWizard();
      return;
    }
    if (sub === "list" || sub === "ls" || sub === "status") {
      printMcpStatus(mgr.listStatuses());
      return;
    }
    if (sub === "presets") {
      say(theme.bold("mcp presets"));
      for (const p of CONNECTOR_PRESETS) {
        say(`  ${theme.accent(p.id)}  ${theme.muted(`${p.transport} — ${p.description}`)}`);
      }
      return;
    }
    if (busy) {
      toast("Wait for the current turn to settle before modifying MCP connectors.");
      return;
    }
    if (sub === "reconnect" || sub === "reload") {
      const targetName = tokens[1];
      if (targetName) {
        const next = await mgr.reconnectServer(targetName);
        updateSidebar();
        printStatus();
        inspectMcpServer(next);
      } else {
        const res = await mgr.discoverAndConnect();
        updateSidebar();
        printStatus();
        printMcpStatus(res.servers);
      }
      return;
    }
    if (sub === "trust") {
      const targetName = tokens[1];
      if (!targetName) {
        err("Usage: /mcp trust <name>");
        return;
      }
      const next = await mgr.trustServer(targetName);
      updateSidebar();
      printStatus();
      inspectMcpServer(next);
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const targetName = tokens[1];
      if (!targetName) {
        err("Usage: /mcp remove <name>");
        return;
      }
      const removed = await mgr.removeServer(targetName);
      updateSidebar();
      printStatus();
      if (removed) ok(`Removed MCP server "${targetName}".`);
      else info(`MCP server "${targetName}" was not configured.`);
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const targetName = tokens[1];
      if (!targetName) {
        err(`Usage: /mcp ${sub} <name>`);
        return;
      }
      const next = await mgr.toggleServer(targetName, sub === "disable");
      updateSidebar();
      printStatus();
      ok(`${targetName}: ${next.state}`);
      return;
    }
    if (sub === "inspect") {
      const targetName = tokens[1];
      if (!targetName) {
        err("Usage: /mcp inspect <name>");
        return;
      }
      const target = mgr.getServerStatus(targetName);
      if (!target) {
        err(`Unknown MCP server "${targetName}".`);
        return;
      }
      inspectMcpServer(target);
      return;
    }
    if (sub === "add") {
      let deferred = false;
      const filtered: string[] = [];
      for (const tok of tokens.slice(1)) {
        if (tok === "--deferred") deferred = true;
        else filtered.push(tok);
      }
      const name = filtered[0];
      const target = filtered[1];
      const extraArgs = filtered.slice(2);
      if (!name || !target) {
        err("Usage: /mcp add <name> <https://url | command> [args...] [--deferred]");
        return;
      }
      const isRemote = /^https?:\/\//i.test(target);
      const entry: McpServerConfigEntry = isRemote
        ? { transport: /\/sse(?:[/?#]|$)/i.test(target) ? "sse" : "http", url: target, ...(deferred ? { deferred: true } : {}) }
        : { transport: "stdio", command: target, ...(extraArgs.length > 0 ? { args: extraArgs } : {}), ...(deferred ? { deferred: true } : {}) };
      await connectAndReportMcp(name, entry, "user");
      return;
    }
    err(`Unknown /mcp action "${sub}". Try /mcp, /mcp list, /mcp inspect <name>, /mcp presets, /mcp add <name> <url|cmd>, /mcp reconnect, /mcp trust <name>, /mcp remove <name>.`);
  };

  const printAgentsStatus = (agents: SubagentStatus[]) => {
    say(theme.bold("subagents & A2A team"));
    if (agents.length === 0) {
      info("  No specialists configured (core loop runs solo with zero delegation overhead). Use `/agents` to add opt-in presets or A2A agents.");
      return;
    }
    for (const a of agents) {
      const badge =
        a.state === "ready"
          ? theme.success(`ready · ${a.type === "a2a" ? "a2a" : `${a.mode}/${a.isolation}`}`)
          : a.state === "untrusted"
            ? theme.warn(`untrusted (run /agents trust ${a.name})`)
            : a.state === "error"
              ? theme.error(`error: ${a.error ?? "failed"}`)
              : theme.muted(a.state);
      say(`  ${theme.accent(a.name)}  ${theme.muted(`${a.type} · ${a.origin}`)}  ${badge}`);
      info(`    ${a.description}`);
      if (a.model) info(`    model: ${a.model}`);
      if (a.tools?.length) info(`    tools: ${a.tools.join(", ")}`);
      if (a.mcpServers?.length) info(`    mcp: ${a.mcpServers.join(", ")}`);
      if (a.url) info(`    url: ${a.url}`);
      if (a.skills?.length) info(`    skills: ${a.skills.map((sk) => sk.name).join(", ")}`);
      if (a.warning) info(`    warning: ${a.warning}`);
    }
  };

  const inspectSubagent = (a: SubagentStatus) => {
    say(theme.bold(`agent · ${a.name}`));
    info(`  type: ${a.type} (${a.origin}) · state: ${a.state} · mode: ${a.mode} (${a.isolation})`);
    info(`  description: ${a.description}`);
    if (a.sourcePath) info(`  source: ${a.sourcePath}`);
    if (a.model) info(`  model: ${a.model}`);
    if (a.tools?.length) info(`  tools: ${a.tools.join(", ")}`);
    if (a.mcpServers?.length) info(`  mcpServers: ${a.mcpServers.join(", ")}`);
    if (a.url) info(`  url: ${a.url}`);
    if (a.skills?.length) info(`  A2A skills: ${a.skills.map((sk) => sk.name).join(", ")}`);
    if (a.warning) info(`  warning: ${a.warning}`);
  };

  const saveAndReportSubagent = async (
    entry: SubagentConfigEntry,
    scope: "user" | "project" | "memory",
    opts?: { format?: SubagentFileFormat; templateComments?: boolean },
  ) => {
    const mgr = session.subagents;
    if (!mgr) {
      err("Subagent manager is unavailable on this session.");
      return;
    }
    try {
      const status = await mgr.addSubagent(entry, {
        scope,
        ...(opts?.format ? { format: opts.format } : {}),
        ...(opts?.templateComments ? { templateComments: true } : {}),
      });
      updateSidebar();
      printStatus();
      ok(`Added ${status.type} agent "${status.name}" (${scope}): ${status.state}.`);
      if (status.sourcePath) info(`  file: ${status.sourcePath}`);
      if (status.warning) info(`  warning: ${status.warning}`);
    } catch (error) {
      err(`Failed saving subagent "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runAgentsWizard = async (): Promise<void> => {
    const mgr = session.subagents;
    if (!mgr) {
      err("Subagent manager is unavailable on this session.");
      return;
    }
    if (busy) {
      toast("Wait for the current turn to settle before modifying team subagents.");
      return;
    }

    const agents = mgr.listStatuses();
    const menuItems: Array<{ value: string; label: string; description?: string }> = [
      { value: "__preset__", label: "Install specialist preset…", description: "explorer, reviewer, coder, researcher (opt-in templates)" },
      { value: "__init__", label: "Create editable agent file…", description: "Scaffold .md, .yaml, or .json file to customize in any editor" },
      { value: "__local__", label: "Add custom local specialist…", description: "Define a specialized sub-session prompt, tools & model" },
      { value: "__a2a__", label: "Add remote A2A agent…", description: "Connect an Agent-to-Agent HTTP/JSON-RPC server" },
      { value: "__format__", label: "Show file format guide (.md / .yaml / .json)", description: "Frontmatter, plain Markdown #, YAML, JSON & tool shorthands" },
      { value: "__reload__", label: "Reload from disk", description: "Re-read ~/.kern/agents and .kern/agents" },
      ...agents.map((a) => ({
        value: `agent:${a.name}`,
        label: `${a.state === "ready" ? "●" : a.state === "untrusted" ? "!" : a.state === "error" ? "✖" : "○"} ${a.name}`,
        description: `${a.type === "a2a" ? "a2a" : `${a.mode}/${a.isolation}`} · ${a.state}`,
      })),
    ];

    const pick = await pickOne("subagents & A2A team", menuItems);
    if (!pick) return;

    if (pick === "__reload__") {
      const res = await mgr.discover();
      updateSidebar();
      printStatus();
      printAgentsStatus(res.agents);
      return;
    }

    if (pick === "__format__") {
      say(theme.bold("subagent file formats"));
      info(SUBAGENT_FORMAT_GUIDE);
      return;
    }

    if (pick === "__init__") {
      const name = (await promptText("new agent file name ([a-z0-9_-])"))?.trim();
      if (!name) return;
      const fmtPick = await pickOne("file format", [
        { value: "md", label: "Markdown (.md)", description: "Frontmatter or plain # Heading + body" },
        { value: "yaml", label: "YAML (.yaml)", description: "Clean key/value config with multiline instruction" },
        { value: "json", label: "JSON (.json)", description: "Single-agent JSON file" },
      ]);
      if (!fmtPick) return;
      const starterPick = await pickOne("starter template", [
        { value: "blank", label: "Minimal starter", description: "Readonly specialist template with helpful comments" },
        ...SUBAGENT_PRESETS.map((p) => ({
          value: p.id,
          label: `Based on ${p.name}`,
          description: p.description,
        })),
      ]);
      if (!starterPick) return;
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/agents)", description: "available in all workspaces" },
        { value: "project", label: "Project (.kern/agents)", description: "saved in current repo" },
      ]);
      if (!scope) return;
      const preset = starterPick !== "blank" ? findSubagentPreset(starterPick) : undefined;
      const entry: SubagentConfigEntry = preset
        ? { ...preset.entry, name }
        : {
            name,
            type: "local",
            description: `Custom specialist agent (${name})`,
            mode: "readonly",
            isolation: "readonly",
            tools: ["read", "grep", "find", "git-status", "git-diff"],
            maxTurns: 12,
            instruction: `You are the "${name}" specialist.\nExplain findings concisely with exact file paths, line numbers, and actionable recommendations.`,
          };
      await saveAndReportSubagent(entry, scope as "user" | "project", {
        format: fmtPick as SubagentFileFormat,
        templateComments: true,
      });
      info("Edit the generated file anytime and run `/agents reload` to apply changes.");
      return;
    }

    if (pick === "__preset__") {
      const presetId = await pickOne(
        "agents — choose specialist preset",
        SUBAGENT_PRESETS.map((p) => ({
          value: p.id,
          label: `${p.name} (${p.id})`,
          description: `${p.entry.mode ?? "readonly"} · ${p.description}`,
        })),
      );
      if (!presetId) return;
      const preset = SUBAGENT_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      const customModel = await promptText("optional model override (provider/id, leave empty to use active model)", "");
      if (customModel === null) return;
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/agents)", description: "available in all workspaces" },
        { value: "project", label: "Project (.kern/agents)", description: "saved in current repo (auto-trusted)" },
      ]);
      if (!scope) return;
      const entry: SubagentConfigEntry = {
        ...preset.entry,
        ...(customModel.trim() ? { model: customModel.trim() } : {}),
      };
      await saveAndReportSubagent(entry, scope as "user" | "project");
      return;
    }

    if (pick === "__local__") {
      const name = (await promptText("specialist name ([a-z0-9_-])"))?.trim();
      if (!name) return;
      const description = (await promptText("routing description (shown to orchestrator)"))?.trim();
      if (!description) return;
      const mode = await pickOne("tool mode", [
        { value: "readonly", label: "readonly", description: "read/grep/find/git inspect + optional read-only MCP" },
        { value: "write", label: "write", description: "can edit files & run commands (serialized or worktree)" },
      ]);
      if (!mode) return;
      let isolation: "readonly" | "exclusive" | "worktree" = "readonly";
      if (mode === "write") {
        const pickedIso = await pickOne("workspace isolation", [
          { value: "exclusive", label: "exclusive lock", description: "serializes write access on main workspace" },
          { value: "worktree", label: "git worktree", description: "runs in temporary detached git worktree" },
        ]);
        if (!pickedIso) return;
        isolation = pickedIso as "exclusive" | "worktree";
      }
      const toolsRaw = await promptText("allowed built-in tools (comma-separated, empty = role default)", "");
      if (toolsRaw === null) return;
      const mcpRaw = await promptText("parent MCP server names to share (comma-separated, optional)", "");
      if (mcpRaw === null) return;
      const modelRaw = await promptText("model override (provider/id, empty = inherit parent)", "");
      if (modelRaw === null) return;
      const instruction = (await promptText("specialist system instruction", ""))?.trim();
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/agents)", description: "available globally" },
        { value: "project", label: "Project (.kern/agents)", description: "saved in workspace (auto-trusted)" },
      ]);
      if (!scope) return;
      const entry: SubagentConfigEntry = {
        name,
        type: "local",
        description,
        mode: mode as "readonly" | "write",
        isolation,
        ...(toolsRaw.trim() ? { tools: toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(mcpRaw.trim() ? { mcpServers: mcpRaw.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(modelRaw.trim() ? { model: modelRaw.trim() } : {}),
        ...(instruction ? { instruction } : {}),
      };
      await saveAndReportSubagent(entry, scope as "user" | "project");
      return;
    }

    if (pick === "__a2a__") {
      const name = (await promptText("remote A2A agent name ([a-z0-9_-])"))?.trim();
      if (!name) return;
      const url = (await promptText("A2A endpoint URL", "http://127.0.0.1:41241"))?.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        err("URL must start with http:// or https://");
        return;
      }
      const description = (await promptText("agent description", `Remote A2A specialist (${name})`))?.trim();
      if (!description) return;
      const authVal = await promptText("Authorization / Bearer token header (optional, supports ${ENV_VAR})", "");
      if (authVal === null) return;
      const scope = await pickOne("save scope", [
        { value: "user", label: "User (~/.kern/agents.json)", description: "available globally" },
        { value: "project", label: "Project (.kern/agents.json)", description: "saved in workspace (auto-trusted)" },
      ]);
      if (!scope) return;
      const tok = authVal.trim();
      const entry: SubagentConfigEntry = {
        name,
        type: "a2a",
        url,
        description,
        ...(tok ? { headers: { Authorization: /^bearer\s+/i.test(tok) || tok.startsWith("${") ? tok : `Bearer ${tok}` } } : {}),
      };
      await saveAndReportSubagent(entry, scope as "user" | "project");
      return;
    }

    if (pick.startsWith("agent:")) {
      const name = pick.slice(6);
      const target = mgr.getStatus(name);
      if (!target) return;
      const action = await pickOne(`agent · ${name} (${target.state})`, [
        { value: "inspect", label: "Inspect configuration & capabilities", description: target.description },
        ...(target.state === "untrusted"
          ? [{ value: "trust", label: "Trust project agent", description: "approve SHA-256 fingerprint in ~/.kern/agent-trust.json" }]
          : []),
        {
          value: target.disabled ? "enable" : "disable",
          label: target.disabled ? "Enable agent" : "Disable agent",
          description: target.disabled ? "expose to orchestrator" : "hide from orchestrator without deleting",
        },
        { value: "remove", label: "Remove agent", description: "delete configuration file entry" },
      ]);
      if (!action) return;
      if (action === "inspect") {
        inspectSubagent(target);
      } else if (action === "trust") {
        const next = await mgr.trustSubagent(name);
        updateSidebar();
        printStatus();
        inspectSubagent(next);
      } else if (action === "enable" || action === "disable") {
        const next = await mgr.toggleSubagent(name, action === "disable");
        updateSidebar();
        printStatus();
        ok(`${name}: ${next.state}`);
      } else if (action === "remove") {
        await mgr.removeSubagent(name);
        updateSidebar();
        printStatus();
        ok(`Removed subagent "${name}".`);
      }
    }
  };

  const runAgentsCommand = async (arg: string): Promise<void> => {
    const mgr = session.subagents;
    if (!mgr) {
      err("Subagent manager is unavailable on this session.");
      return;
    }
    const tokens = arg.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "").toLowerCase();
    if (!sub) {
      await runAgentsWizard();
      return;
    }
    if (sub === "list" || sub === "ls" || sub === "status") {
      printAgentsStatus(mgr.listStatuses());
      return;
    }
    if (sub === "presets") {
      say(theme.bold("subagent presets (opt-in)"));
      for (const p of SUBAGENT_PRESETS) {
        say(`  ${theme.accent(p.id)}  ${theme.muted(`${p.entry.mode ?? "readonly"}/${p.entry.isolation ?? "readonly"} — ${p.description}`)}`);
      }
      return;
    }
    if (sub === "bg" || sub === "jobs") {
      const jobs = mgr.listBackgroundJobs();
      if (jobs.length === 0) {
        info("No background subagent runs in this session.");
        return;
      }
      for (const j of jobs) {
        say(`  ${j.jobId} [${j.running ? "running" : j.exitReason ?? "done"}] ${j.agent} · turns=${j.turns}${j.lastProgress ? ` · ${j.lastProgress}` : ""}`);
      }
      return;
    }
    if (sub === "inspect") {
      const name = tokens[1];
      if (!name) { err("Usage: /agents inspect <name>"); return; }
      const target = mgr.getStatus(name);
      if (!target) { err(`Unknown subagent "${name}".`); return; }
      inspectSubagent(target);
      return;
    }
    if (busy) {
      toast("Wait for the current turn to settle before modifying team subagents.");
      return;
    }
    if (sub === "reload") {
      const res = await mgr.discover();
      updateSidebar();
      printStatus();
      printAgentsStatus(res.agents);
      return;
    }
    if (sub === "trust") {
      const name = tokens[1];
      if (!name) { err("Usage: /agents trust <name>"); return; }
      const next = await mgr.trustSubagent(name);
      updateSidebar();
      printStatus();
      inspectSubagent(next);
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const name = tokens[1];
      if (!name) { err(`Usage: /agents ${sub} <name>`); return; }
      const next = await mgr.toggleSubagent(name, sub === "disable");
      updateSidebar();
      printStatus();
      ok(`${name}: ${next.state}`);
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const name = tokens[1];
      if (!name) { err("Usage: /agents remove <name>"); return; }
      const removed = await mgr.removeSubagent(name);
      updateSidebar();
      printStatus();
      if (removed) ok(`Removed subagent "${name}".`);
      else info(`Subagent "${name}" was not configured.`);
      return;
    }
    if (sub === "format" || sub === "guide") {
      say(theme.bold("subagent file formats"));
      info(SUBAGENT_FORMAT_GUIDE);
      return;
    }
    if (sub === "init" || sub === "new") {
      const rawArgs = tokens.slice(1);
      const isProject = rawArgs.includes("--project") || rawArgs.includes("-p");
      const filtered = rawArgs.filter((t) => t !== "--project" && t !== "-p");
      const name = filtered[0];
      if (!name) {
        err("Usage: /agents init <name> [md|yaml|json] [preset] [--project]");
        return;
      }
      let fmt: SubagentFileFormat = "md";
      let presetArg: string | undefined;
      for (const tok of filtered.slice(1)) {
        const low = tok.toLowerCase();
        if (low === "md" || low === "markdown") fmt = "md";
        else if (low === "yaml" || low === "yml") fmt = "yaml";
        else if (low === "json") fmt = "json";
        else presetArg = tok;
      }
      const preset = presetArg ? findSubagentPreset(presetArg) : undefined;
      const entry: SubagentConfigEntry = preset
        ? { ...preset.entry, name }
        : {
            name,
            type: "local",
            description: `Custom specialist agent (${name})`,
            mode: "readonly",
            isolation: "readonly",
            tools: ["read", "grep", "find", "git-status", "git-diff"],
            maxTurns: 12,
            instruction: `You are the "${name}" specialist.\nExplain findings concisely with exact file paths, line numbers, and actionable recommendations.`,
          };
      await saveAndReportSubagent(entry, isProject ? "project" : "user", { format: fmt, templateComments: true });
      info("Edit the file anytime and run `/agents reload` to apply changes.");
      return;
    }
    if (sub === "preset") {
      const presetId = tokens[1];
      if (!presetId) { err("Usage: /agents preset <explorer|reviewer|coder|researcher>"); return; }
      const preset = SUBAGENT_PRESETS.find((p) => p.id === presetId.toLowerCase());
      if (!preset) { err(`Unknown preset "${presetId}". Run /agents presets.`); return; }
      const entry: SubagentConfigEntry = {
        ...preset.entry,
        ...(tokens[2] ? { name: tokens[2] } : {}),
      };
      await saveAndReportSubagent(entry, "user");
      return;
    }
    err(`Unknown /agents action "${sub}". Try /agents, /agents list, /agents format, /agents init <name> [md|yaml|json], /agents presets, /agents preset <id>, /agents inspect <name>, /agents trust <name>, /agents reload, /agents remove <name>.`);
  };

  // --- slash commands -------------------------------------------------------------------
  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const normalized = cmd?.toLowerCase();
    switch (normalized) {
      case "/help":
        for (const c of TUI_COMMANDS) {
          const badge = c.shortcut ? ` [${c.shortcut}]` : "";
          say(`  ${theme.accent("/" + c.name)}  ${theme.muted(`${c.description}${badge}`)}`);
        }
        info(TUI_HINTS);
        info("Skills: force any discovered skill with `/skill:<name> [prompt]`.");
        info("Scroll: PageUp / PageDown / Ctrl+Up / Ctrl+Down / Ctrl+Home / Ctrl+End · Search matches highlight live in the viewport.");
        return true;
      case "/palette":
        await openCommandPalette();
        return true;
      case "/search":
      case "/find":
        openLiveSearch(arg || undefined);
        return true;
      case "/expand":
        toggleAllDetails(true);
        return true;
      case "/collapse":
        toggleAllDetails(false);
        return true;
      case "/thinking":
        await pickThinkingLevel(arg || undefined);
        return true;
      case "/fork":
        await forkActiveSession();
        return true;
      case "/branch":
        await recordBranchSummary();
        return true;
      case "/quit":
      case "/exit":
        return false;
      case "/clear":
        transcript.clear();
        detailCards.length = 0;
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
      case "/login":
      case "/connect":
        await runLogin(arg || undefined);
        return true;
      case "/logout":
        await runLogout(arg || undefined);
        return true;
      case "/mcp":
      case "/connects":
        await runMcpCommand(arg);
        return true;
      case "/agents":
      case "/team":
        await runAgentsCommand(arg);
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
          resetTranscriptForRuntime(fresh);
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
        err(`Unknown command: ${cmd ?? ""}. Try /help or Ctrl+P.`);
        return true;
    }
  };

  // --- prompt submission ---------------------------------------------------------------------
  const runTurn = (text: string, displayLabel?: string, displayText?: string) => {
    if (busy) return;
    busy = true;
    abort = new AbortController();
    activity = "thinking";
    setActivity("thinking");
    lastUserPrompt = text;
    setBusy(true);
    turnNumber += 1;
    renderUserPrompt(displayText ?? text, displayLabel ?? "you");
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
    toast("Stopped current run.");
    setActivity("ready");
    return true;
  };

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
        if (cmd === "/help" || cmd === "/budget" || cmd === "/search" || cmd === "/find" || cmd === "/expand" || cmd === "/collapse") {
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
    if (trimmed.toLowerCase().startsWith("/skill:")) {
      editor.addToHistory(trimmed);
      void (async () => {
        const resolved = await resolveSkillInvocation(trimmed, cwd);
        if (resolved.error) {
          err(resolved.error);
          return;
        }
        if (resolved.expandedPrompt && resolved.skill) {
          recentPrompts.push(trimmed);
          if (recentPrompts.length > 200) recentPrompts.splice(0, recentPrompts.length - 200);
          runTurn(resolved.expandedPrompt, `you (skill:${resolved.skill.name})`, trimmed);
        }
      })();
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
      runTurn(text, "you", raw);
    })();
  };

  handleAuthError = (_message: string) => {
    if (authOverlayOpen) return;
    authOverlayOpen = true;
    void (async () => {
      const pick = await pickOne("auth error — how to recover?", [
        { value: "login", label: "Log in with /login", description: "run the provider login wizard" },
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
      if (pick === "login") await runCommand("/login");
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
        toast("Auth error dismissed — /login, /model, or retry when ready.");
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
    if (options.askUserHook) options.askUserHook.current = null;
    unsubscribe?.();
    const draftText = editor.getText();
    tui.stop();
    process.stdout.write(theme.muted("bye.\n"));
    void Promise.allSettled([
      saveTuiState({
        draftText,
        recentPrompts,
        stash,
        queue,
        lastUserPrompt,
      }),
      session.subagents?.dispose(),
      session.connects?.dispose(),
    ]).finally(() => {
      session.dispose();
      process.exit(0);
    });
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
  tui.addInputListener((key) => {
    if (promptDialog && matchesKey(key, "escape")) {
      promptDialog.cancel();
      return { consume: true };
    }
    if (tui.hasOverlay()) {
      return undefined;
    }
    if (matchesKey(key, "ctrl+p")) {
      void openCommandPalette();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+o")) {
      toggleAllDetails();
      return { consume: true };
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
    if (matchesKey(key, "backspace") && editor.getText().length === 0 && queue.length > 0) {
      const removed = queue.pop();
      renderQueue();
      toast(`Removed queued message${removed ? `: ${removed.replace(/\s+/g, " ").trim().slice(0, 60)}` : ""}`);
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+s")) {
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
    if (matchesKey(key, "ctrl+w")) {
      const text = editor.getText();
      if (text) {
        killRing.push(text, { prepend: false, accumulate: false });
        toast(`Copied to kill ring: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
      }
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+y")) {
      const yanked = killRing.peek();
      if (yanked) {
        editor.setText(editor.getText() + yanked);
        tui.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(key, "shift+tab")) {
      if (!busy) cycleMode();
      return { consume: true };
    }
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

  printHeader();
  replaySessionHistory();
  printStatus();
  updateSidebar();
  tui.start();
  if (options.initialPrompt?.trim()) {
    const initial = options.initialPrompt;
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
