import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, SettingsManager } from "../src/index.js";

describe("Phase 5 session runtime + settings", () => {
  it("loads project settings, keeps them mergeable, and enforces fail-closed project safety", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-settings-"));
    try {
      mkdirSync(join(root, ".kern"), { recursive: true });
      writeFileSync(
        join(root, ".kern", "settings.json"),
        JSON.stringify({
          thinkingLevel: "high",
          safetyMode: "autonomous",
          permissionRules: {
            allowRules: ["rm -rf"],
            denyRules: ["curl evil.com"],
          },
          budgets: { maxTurns: 5 },
        }),
      );

      const settings = await SettingsManager.load(root, { budgets: { maxTurns: 12 } });
      // Project thinkingLevel & denyRules apply; project safetyMode & allowRules are rejected (fail-closed)
      expect(settings.thinkingLevel).toBe("high");
      expect(settings.safetyMode).not.toBe("autonomous");
      expect(settings.permissionRules?.denyRules).toContain("curl evil.com");
      expect(settings.permissionRules?.allowRules).toBeUndefined();
      // Explicit runtime overrides apply
      expect(settings.budgets?.maxTurns).toBe(12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a session and exposes runtime ops", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd(), loadResources: false, enableCompaction: false });
    expect(typeof session.prompt).toBe("function");
    expect(typeof session.thinkingMode).toBe("function");
    expect(typeof session.setThinkingLevel).toBe("function");
    expect(session.toolNames()).toEqual(["read", "write", "edit", "bash", "git-status", "git-diff", "git-log", "grep", "find", "todo"]);
    session.dispose();
  });

  it("wires default tool_response_transform hooks (secret redaction + truncation) on sessions", async () => {
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      loadResources: false,
      enableCompaction: false,
      extraTools: [{
        name: "emit-secret",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
        sideEffect: "read",
        async execute() {
          return {
            content: [{ type: "text", text: `api_key: sk-testsecret1234567890\n${"a".repeat(31_000)}` }],
            isError: false,
          };
        },
      }],
    });
    const res = await session.callToolAsUser("emit-secret", {});
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).not.toContain("sk-testsecret1234567890");
    expect(res.content[0]?.text).toContain("[REDACTED]");
    expect(res.content[0]?.text).toContain("characters truncated");
    session.dispose();
  });

  it("forks only the root-to-entry path into a new session with forkedFrom provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-fork-"));
    try {
      const { session, manager } = await createAgentSession({
        cwd: root,
        storageRoot: join(root, "sessions"),
        loadResources: false,
        enableCompaction: false,
      });
      const e1 = await manager.appendUserMessage("step 1");
      const e2 = await manager.appendUserMessage("step 2");
      await manager.appendUserMessage("step 3 (discard after fork)");
      // Also create an abandoned sibling branch under e1
      manager.branchTo(e1.id);
      await manager.appendUserMessage("abandoned sibling");
      manager.branchTo(e2.id);

      const forked = await session.fork!(e2.id);
      expect(forked.manager.sessionId).not.toBe(manager.sessionId);
      expect(forked.manager.sessionFile).not.toBe(manager.sessionFile);
      const forkedPath = forked.manager.getActivePath();
      const header = forkedPath[0];
      expect(header?.type).toBe("session_header");
      if (header?.type === "session_header") {
        expect((header.meta?.forkedFrom as { sessionId?: string; entryId?: string })?.sessionId).toBe(manager.sessionId);
        expect((header.meta?.forkedFrom as { sessionId?: string; entryId?: string })?.entryId).toBe(e2.id);
      }
      const forkedMsgs = forked.manager.getActiveMessages().map((m) =>
        m.message.content[0]?.type === "text" ? m.message.content[0].text : "",
      );
      expect(forkedMsgs).toEqual(["step 1", "step 2"]);

      await forked.session.branchSummary!(e1.id, "Abandoned sibling summary");
      expect(forked.session.exportMarkdown?.()).toContain("## Branch Summary");

      forked.session.dispose();
      session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
