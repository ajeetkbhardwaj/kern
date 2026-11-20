import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findAltScreenSearchMatches } from "@earendil-works/pi-tui/dist/alt-screen-search.js";
import { KillRing } from "@earendil-works/pi-tui/dist/kill-ring.js";
import type { SessionEntry } from "@kern/protocol";
import {
  resolveTuiStateFile,
  loadTuiState,
  saveTuiState,
  summarizeArgs,
  getOverlayOpts,
  INVISIBLE_RE,
  DESTRUCTIVE_PATTERNS,
  isDestructiveApproval,
  parseBudgetArgs,
  resolveExportPath,
  buildSessionExportMarkdown,
  collectReplayItems,
  formatReasoningSteps,
  ToolCard,
  CollapsibleText,
  SidebarPanel,
  StatusBar,
  TUI_COMMANDS,
} from "../src/index.js";

describe("tui state persistence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStatePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "kern-tui-state-"));
    dirs.push(dir);
    return resolveTuiStateFile(dir);
  }

  it("resolves state path under ~/.kern/tui-state.json", () => {
    expect(resolveTuiStateFile("/tmp/fake-home")).toBe(join("/tmp/fake-home", ".kern", "tui-state.json"));
  });

  it("saves and loads draft, prompts, stash, queue, and lastUserPrompt", async () => {
    const file = makeStatePath();
    await saveTuiState(
      {
        draftText: "test draft",
        recentPrompts: ["prompt1", "prompt2"],
        stash: "stashed text",
        queue: ["queued1", "queued2"],
        lastUserPrompt: "last prompt",
      },
      file,
    );

    const loaded = await loadTuiState(file);
    expect(loaded.draftText).toBe("test draft");
    expect(loaded.recentPrompts).toEqual(["prompt1", "prompt2"]);
    expect(loaded.stash).toBe("stashed text");
    expect(loaded.queue).toEqual(["queued1", "queued2"]);
    expect(loaded.lastUserPrompt).toBe("last prompt");
  });

  it("handles missing or corrupt state file gracefully", async () => {
    const file = makeStatePath();
    expect(await loadTuiState(file)).toEqual({});

    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not valid json", "utf8");
    expect(await loadTuiState(file)).toEqual({});
  });
});

describe("summarizeArgs", () => {
  it("returns path or command first and truncates long values", () => {
    expect(summarizeArgs({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    expect(summarizeArgs({ command: "ls -la" })).toBe("ls -la");
    const result = summarizeArgs({ path: "a".repeat(150) });
    expect(result).toHaveLength(101);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles null, undefined, and generic key/value args", () => {
    expect(summarizeArgs(null)).toBe("");
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs({ foo: "bar", baz: 123 })).toBe('foo="bar" baz=123');
  });
});

describe("getOverlayOpts", () => {
  it("adapts width and height across terminal column thresholds", () => {
    expect(getOverlayOpts(60)).toEqual({ anchor: "center", width: "95%", maxHeight: "90%" });
    expect(getOverlayOpts(100)).toEqual({ anchor: "center", width: "90%", maxHeight: "85%" });
    expect(getOverlayOpts(150)).toEqual({ anchor: "center", width: "80%", maxHeight: "80%" });
  });
});

describe("kill ring", () => {
  it("pushes, accumulates, and rotates entries", () => {
    const kr = new KillRing();
    kr.push("world", { prepend: false });
    kr.push("hello ", { prepend: true, accumulate: true });
    expect(kr.peek()).toBe("hello world");
    kr.push("next", { prepend: false });
    expect(kr.peek()).toBe("next");
    kr.rotate();
    expect(kr.peek()).toBe("hello world");
  });
});

describe("INVISIBLE_RE & DESTRUCTIVE_PATTERNS", () => {
  it("detects zero-width and bidi invisible characters without false positives", () => {
    expect([...("hello\u200bworld").matchAll(INVISIBLE_RE)].length).toBe(1);
    expect([...("hello\u200eworld").matchAll(INVISIBLE_RE)].length).toBe(1);
    expect([...("hello world").matchAll(INVISIBLE_RE)].length).toBe(0);
  });

  it("matches destructive patterns in prompts and serialized tool args", () => {
    expect(DESTRUCTIVE_PATTERNS.length).toBeGreaterThanOrEqual(10);
    expect(isDestructiveApproval("Run bash", JSON.stringify({ command: "rm -rf /tmp/x" }))).toBe(true);
    expect(isDestructiveApproval("Run bash: git reset --hard")).toBe(true);
    expect(isDestructiveApproval("Run bash: DROP TABLE users")).toBe(true);
    expect(isDestructiveApproval("Run bash: git status")).toBe(false);
  });
});

describe("parseBudgetArgs & export helpers", () => {
  it("parses valid budget limits and rejects unknown or invalid values", () => {
    expect(parseBudgetArgs("")).toEqual({ ok: true, limits: {} });
    expect(parseBudgetArgs("maxCost=0.05 maxTurns=10")).toEqual({
      ok: true,
      limits: { maxCost: 0.05, maxTurns: 10 },
    });
    expect(parseBudgetArgs("maxCost=0")).toEqual({ ok: true, limits: { maxCost: 0 } });
    expect(parseBudgetArgs("maxTurns=1.5").ok).toBe(false);
    expect(parseBudgetArgs("unknown=5").ok).toBe(false);
    expect(parseBudgetArgs("badpair").ok).toBe(false);
  });

  it("confines export paths to the workspace", () => {
    const okRes = resolveExportPath("/tmp/work", "out/notes.md", "s1");
    expect(okRes.ok).toBe(true);
    if (okRes.ok) expect(okRes.path).toBe(join("/tmp/work", "out/notes.md"));

    const escapeRes = resolveExportPath("/tmp/work", "../outside.md", "s1");
    expect(escapeRes.ok).toBe(false);

    const absEscapeRes = resolveExportPath("/tmp/work", "/etc/passwd", "s1");
    expect(absEscapeRes.ok).toBe(false);
  });

  it("formats reasoning steps and builds session export markdown", () => {
    expect(formatReasoningSteps("First look.\n\nSecond check.")).toBe("Step 1: First look.\n\nStep 2: Second check.");
    expect(formatReasoningSteps("1. First\n\n2. Second")).toBe("1. First\n\n2. Second");

    const ts = new Date().toISOString();
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", timestamp: ts, content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: ts,
        message: { role: "assistant", timestamp: ts, content: [{ type: "text", text: "Hi there" }] },
      },
    ];
    const md = buildSessionExportMarkdown(entries, { provider: "openai", modelId: "gpt-4o", cwd: "/tmp/work" });
    expect(md).toContain("- model: openai/gpt-4o");
    expect(md).toContain("## user");
    expect(md).toContain("Hi there");
  });
});

describe("collectReplayItems", () => {
  it("pairs tool calls with tool results and preserves user/reasoning/assistant/checkpoints", () => {
    const ts = new Date().toISOString();
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", timestamp: ts, content: [{ type: "text", text: "Inspect README" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          timestamp: ts,
          content: [
            { type: "reasoning", text: "Checking README first." },
            { type: "tool_call", id: "tc1", name: "read", arguments: { path: "README.md" } },
          ],
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: ts,
        message: {
          role: "tool",
          timestamp: ts,
          content: [{ type: "tool_result", toolCallId: "tc1", content: [{ type: "text", text: "# Kern" }], isError: false }],
        },
      },
      {
        type: "compaction",
        id: "c1",
        parentId: "t1",
        timestamp: ts,
        summary: "Earlier turns summarized",
        replacesThroughId: "u1",
        tokensBefore: { input: 1200, output: 0 },
      },
      {
        type: "message",
        id: "a2",
        parentId: "c1",
        timestamp: ts,
        message: { role: "assistant", timestamp: ts, content: [{ type: "text", text: "Done." }] },
      },
    ];

    const res = collectReplayItems(entries);
    expect(res.userTurns).toBe(1);
    expect(res.items.map((i) => i.kind)).toEqual(["user", "reasoning", "tool", "checkpoint", "assistant"]);
    const toolItem = res.items[2];
    expect(toolItem?.kind).toBe("tool");
    if (toolItem?.kind === "tool") {
      expect(toolItem.toolName).toBe("read");
      expect(toolItem.argsSummary).toBe("README.md");
      expect(toolItem.output).toBe("# Kern");
      expect(toolItem.done).toBe(true);
      expect(toolItem.isError).toBe(false);
    }
  });
});

describe("TUI components, command catalog & live search integration", () => {
  it("exposes search, palette, thinking, fork, expand/collapse, login/logout, and mcp commands", () => {
    const names = new Set(TUI_COMMANDS.map((c) => c.name));
    for (const expected of ["search", "find", "palette", "thinking", "fork", "expand", "collapse", "budget", "session", "login", "logout", "mcp", "connects"]) {
      expect(names.has(expected)).toBe(true);
    }
    expect(names.has("connect")).toBe(false);
  });

  it("toggles ToolCard and CollapsibleText expansion via mouse click and API", () => {
    const card = new ToolCard("read", "src/index.ts");
    expect(card.render(80).join("\n")).toContain("tool running…");
    card.appendOutput("line 1\nline 2");
    const runningOut = card.render(80).join("\n");
    expect(runningOut).toContain("line 1");
    expect(runningOut).toContain("line 2");
    card.finish(false);
    expect(card.isExpanded()).toBe(false);
    expect(card.render(80).join("\n")).toContain("click header to expand");

    card.handleMouse({ type: "click", x: 0, y: 0, button: "left" } as any);
    expect(card.isExpanded()).toBe(true);
    expect(card.render(80).join("\n")).toContain("line 1");

    const thinking = new CollapsibleText("thinking");
    thinking.setText("analyzing types");
    expect(thinking.isExpanded()).toBe(false);
    thinking.setExpanded(true);
    expect(thinking.render(80).join("\n")).toContain("analyzing types");
  });

  it("renders StatusBar and toggles SidebarPanel sections", () => {
    const bar = new StatusBar();
    bar.setSegments(["openai/gpt-4o", "think: medium", "↑ scrolled"]);
    const barLines = bar.render(80);
    expect(barLines[0]).toContain("openai/gpt-4o");
    expect(barLines[0]).toContain("↑ scrolled");

    const sidebar = new SidebarPanel({ leftBorder: true });
    sidebar.setSections([{ key: "s", title: "Session", lines: ["Model: gpt-4o"], collapsible: true }]);
    expect(sidebar.render(40).join("\n")).toContain("Model: gpt-4o");
    sidebar.handleMouse({ type: "click", x: 2, y: 0, button: "left" } as any);
    expect(sidebar.render(40).join("\n")).not.toContain("Model: gpt-4o");
  });

  it("finds live search matches across rendered transcript lines via pi-tui matcher", () => {
    const matches = findAltScreenSearchMatches(["hello kern", "error in kern/tui", "done"], "kern");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.segments[0]?.row).toBe(0);
    expect(matches[1]?.segments[0]?.row).toBe(1);
  });
});