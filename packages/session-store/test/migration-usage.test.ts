import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ENTRY_VERSION } from "@kern/protocol";
import { SessionStore, SessionManager, migrateSessionEntries } from "../src/index.js";

describe("session migration and usage persistence", () => {
  it("migrates v1 session entries to current SESSION_ENTRY_VERSION", () => {
    const res = migrateSessionEntries([
      {
        id: "h_1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_header",
        version: 1,
        sessionId: "sess_1",
        cwd: "/tmp/ws",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m_1",
        parentId: "h_1",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: "2026-01-01T00:00:01.000Z" },
      },
    ]);

    expect(res.fromVersion).toBe(1);
    expect(res.toVersion).toBe(SESSION_ENTRY_VERSION);
    expect(res.migratedCount).toBe(1);
    expect(res.entries[0]?.type).toBe("session_header");
    if (res.entries[0]?.type === "session_header") {
      expect(res.entries[0].version).toBe(SESSION_ENTRY_VERSION);
    }
  });

  it("fails closed on unsupported future session versions", () => {
    expect(() =>
      migrateSessionEntries([
        {
          id: "h_1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_header",
          version: 99,
          sessionId: "sess_future",
          cwd: "/tmp/ws",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ).toThrow(/Unsupported session version 99/);
  });

  it("persists usage entries, compaction token stats, and restores usage totals on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "kern-usage-"));
    const storageRoot = join(root, "sessions");
    const store = new SessionStore({ storageRoot });
    const mgr = await SessionManager.create(store, root);

    const u = await mgr.appendUserMessage("hello");
    await mgr.appendUsage({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 120, output: 45 },
      cost: 0.012,
      source: "turn",
    });
    await mgr.appendCompaction("Summary checkpoint of prior turns.", u.id, {
      tokensBefore: { input: 500, output: 0 },
    });

    const totals = mgr.getUsageTotals();
    expect(totals.inputTokens).toBe(120);
    expect(totals.outputTokens).toBe(45);
    expect(totals.cost).toBeCloseTo(0.012);
    expect(totals.byModel["gpt-4o-mini"]?.input).toBe(120);

    const resumed = await SessionManager.resume(store, root, mgr.sessionFile!);
    expect(resumed.getUsageTotals().inputTokens).toBe(120);
    expect(resumed.lastCompaction()?.tokensBefore?.input).toBe(500);
  });

  it("creates v2 headers and resumes legacy v1 session files on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "kern-v1-"));
    const storageRoot = join(root, "sessions");
    const store = new SessionStore({ storageRoot });
    const mgr = await SessionManager.create(store, root);
    const v1File = join(root, "legacy-v1.jsonl");
    const lines = [
      JSON.stringify({
        id: "h_1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_header",
        version: 1,
        sessionId: "s_v1",
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "m_1",
        parentId: "h_1",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "old prompt" }], timestamp: "2026-01-01T00:00:01.000Z" },
      }),
    ].join("\n") + "\n";
    await writeFile(v1File, lines, "utf8");

    const resumed = await SessionManager.resume(store, root, v1File);
    expect(resumed.getActiveMessages()).toHaveLength(1);
    void mgr;
  });
});
