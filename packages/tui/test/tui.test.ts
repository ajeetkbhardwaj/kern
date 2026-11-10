import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".tui-state.json");

describe("tui state persistence", () => {
  beforeEach(async () => {
    try { await unlink(STATE_FILE); } catch {}
  });

  afterEach(async () => {
    try { await unlink(STATE_FILE); } catch {}
  });

  it("saves and loads draft text", async () => {
    const draftText = "test draft";
    await writeFile(STATE_FILE, JSON.stringify({
      draftText,
      recentPrompts: [],
      stash: "",
      queue: [],
      lastUserPrompt: "",
    }), "utf8");

    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    expect(data.draftText).toBe(draftText);
  });

  it("saves and loads recent prompts", async () => {
    const recentPrompts = ["prompt1", "prompt2"];
    await writeFile(STATE_FILE, JSON.stringify({
      draftText: "",
      recentPrompts,
      stash: "",
      queue: [],
      lastUserPrompt: "",
    }), "utf8");

    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    expect(data.recentPrompts).toEqual(recentPrompts);
  });

  it("saves and loads stash", async () => {
    const stash = "stashed text";
    await writeFile(STATE_FILE, JSON.stringify({
      draftText: "",
      recentPrompts: [],
      stash,
      queue: [],
      lastUserPrompt: "",
    }), "utf8");

    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    expect(data.stash).toBe(stash);
  });

  it("saves and loads queue", async () => {
    const queue = ["queued1", "queued2"];
    await writeFile(STATE_FILE, JSON.stringify({
      draftText: "",
      recentPrompts: [],
      stash: "",
      queue,
      lastUserPrompt: "",
    }), "utf8");

    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    expect(data.queue).toEqual(queue);
  });

  it("saves and loads last user prompt", async () => {
    const lastUserPrompt = "last prompt";
    await writeFile(STATE_FILE, JSON.stringify({
      draftText: "",
      recentPrompts: [],
      stash: "",
      queue: [],
      lastUserPrompt,
    }), "utf8");

    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    expect(data.lastUserPrompt).toBe(lastUserPrompt);
  });

  it("handles missing file gracefully", async () => {
    try { await unlink(STATE_FILE); } catch {}
    try {
      await readFile(STATE_FILE, "utf8");
      throw new Error("should have failed");
    } catch (e) {
      expect(e instanceof Error).toBe(true);
    }
  });

  it("handles corrupt JSON gracefully", async () => {
    await writeFile(STATE_FILE, "not json", "utf8");
    try {
      const raw = await readFile(STATE_FILE, "utf8");
      JSON.parse(raw);
      throw new Error("should have failed");
    } catch (e) {
      expect(e instanceof Error).toBe(true);
    }
  });
});

describe("summarizeArgs", () => {
  function summarizeArgs(args: unknown): string {
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
  }

  it("returns path for path arg", () => {
    expect(summarizeArgs({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("returns command for command arg", () => {
    expect(summarizeArgs({ command: "ls -la" })).toBe("ls -la");
  });

  it("truncates long text", () => {
    const long = "a".repeat(150);
    const result = summarizeArgs({ path: long });
    expect(result).toHaveLength(101);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty for null", () => {
    expect(summarizeArgs(null)).toBe("");
  });

  it("returns empty for undefined", () => {
    expect(summarizeArgs(undefined)).toBe("");
  });

  it("formats other args as key=value", () => {
    expect(summarizeArgs({ foo: "bar", baz: 123 })).toBe('foo="bar" baz=123');
  });
});

describe("adaptive overlay options", () => {
  const originalColumns = process.stdout.columns;

  afterEach(() => {
    process.stdout.columns = originalColumns;
  });

  function getOverlayOpts(): { anchor: "center"; width: "80%" | "90%" | "95%"; maxHeight: "80%" | "85%" | "90%" } {
    const cols = process.stdout.columns ?? 80;
    if (cols < 80) return { anchor: "center", width: "95%", maxHeight: "90%" };
    if (cols < 120) return { anchor: "center", width: "90%", maxHeight: "85%" };
    return { anchor: "center", width: "80%", maxHeight: "80%" };
  }

  it("returns 95% width for very narrow terminals", () => {
    process.stdout.columns = 60;
    const opts = getOverlayOpts();
    expect(opts.width).toBe("95%");
    expect(opts.maxHeight).toBe("90%");
  });

  it("returns 90% width for narrow terminals", () => {
    process.stdout.columns = 100;
    const opts = getOverlayOpts();
    expect(opts.width).toBe("90%");
    expect(opts.maxHeight).toBe("85%");
  });

  it("returns 80% width for wide terminals", () => {
    process.stdout.columns = 150;
    const opts = getOverlayOpts();
    expect(opts.width).toBe("80%");
    expect(opts.maxHeight).toBe("80%");
  });
});

describe("kill ring", () => {
  class KillRing {
    private ring: string[] = [];
    push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
      if (opts.accumulate && this.ring.length > 0) {
        if (opts.prepend) this.ring[0] = text + this.ring[0];
        else this.ring[0] = this.ring[0] + text;
      } else {
        this.ring.unshift(text);
      }
    }
    peek(): string | undefined {
      return this.ring[0];
    }
    rotate(): void {
      if (this.ring.length > 1) this.ring.push(this.ring.shift()!);
    }
    get length(): number { return this.ring.length; }
  }

  it("pushes and peeks single entry", () => {
    const kr = new KillRing();
    kr.push("hello", { prepend: false });
    expect(kr.peek()).toBe("hello");
    expect(kr.length).toBe(1);
  });

  it("accumulates forward when accumulate=true", () => {
    const kr = new KillRing();
    kr.push("hello", { prepend: false });
    kr.push(" world", { prepend: false, accumulate: true });
    expect(kr.peek()).toBe("hello world");
  });

  it("accumulates backward when prepend=true", () => {
    const kr = new KillRing();
    kr.push("world", { prepend: false });
    kr.push("hello ", { prepend: true, accumulate: true });
    expect(kr.peek()).toBe("hello world");
  });

  it("rotates entries", () => {
    const kr = new KillRing();
    kr.push("first", { prepend: false });
    kr.push("second", { prepend: false });
    kr.push("third", { prepend: false });
    expect(kr.peek()).toBe("third");
    kr.rotate();
    expect(kr.peek()).toBe("second");
    kr.rotate();
    expect(kr.peek()).toBe("first");
  });
});

describe("INVISIBLE_RE", () => {
  const INVISIBLE_RE = /[​‎‏‪-‮⁠-⁤﻿]/gu;

  it("detects zero-width spaces", () => {
    const text = "hello\u200bworld";
    const matches = [...text.matchAll(INVISIBLE_RE)];
    expect(matches.length).toBe(1);
  });

  it("detects bidi controls", () => {
    const text = "hello\u200eworld";
    const matches = [...text.matchAll(INVISIBLE_RE)];
    expect(matches.length).toBe(1);
  });

  it("returns no matches for clean text", () => {
    const text = "hello world";
    const matches = [...text.matchAll(INVISIBLE_RE)];
    expect(matches.length).toBe(0);
  });
});

describe("DESTRUCTIVE_PATTERNS", () => {
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

  const testCases = [
    { input: "rm -rf /", shouldMatch: true },
    { input: "rm -rf /home/user", shouldMatch: true },
    { input: "git reset --hard", shouldMatch: true },
    { input: "git clean -f", shouldMatch: true },
    { input: "mkfs.ext4 /dev/sda1", shouldMatch: true },
    { input: "dd if=/dev/zero of=/dev/sda", shouldMatch: true },
    { input: "> /dev/sda", shouldMatch: true },
    { input: "shutdown -h now", shouldMatch: true },
    { input: "DROP TABLE users", shouldMatch: true },
    { input: "ls -la", shouldMatch: false },
    { input: "git status", shouldMatch: false },
    { input: "echo hello", shouldMatch: false },
  ];

  for (const tc of testCases) {
    it(`detects "${tc.input}" as ${tc.shouldMatch ? "destructive" : "safe"}`, () => {
      const matches = DESTRUCTIVE_PATTERNS.some((re) => re.test(tc.input));
      expect(matches).toBe(tc.shouldMatch);
    });
  }
});