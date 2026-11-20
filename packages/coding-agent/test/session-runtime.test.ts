import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, SettingsManager } from "../src/index.js";
import { resolveSkillInvocation } from "@kern/agent-core";
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from "@kern/protocol";

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
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      loadResources: false,
      enableCompaction: false,
      enableConnects: false,
    });
    expect(typeof session.prompt).toBe("function");
    expect(typeof session.thinkingMode).toBe("function");
    expect(typeof session.setThinkingLevel).toBe("function");
    expect(session.toolNames()).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "bash-status",
      "bash-stop",
      "git-status",
      "git-diff",
      "git-log",
      "grep",
      "find",
      "todo",
      "web-fetch",
      "ask-user",
      "create-subagent",
    ]);
    session.dispose();

    const noSub = await createAgentSession({
      cwd: process.cwd(),
      loadResources: false,
      enableCompaction: false,
      enableConnects: false,
      enableSubagents: false,
    });
    expect(noSub.session.toolNames()).not.toContain("create-subagent");
    noSub.session.dispose();
  });

  it("wires askUser handler when provided and fails closed when absent", async () => {
    const headless = await createAgentSession({ cwd: process.cwd(), loadResources: false, enableCompaction: false });
    const denied = await headless.session.callToolAsUser("ask-user", { question: "Which DB?" });
    expect(denied.isError).toBe(true);
    expect(denied.details?.code).toBe("E_TOOL_DENIED");
    headless.session.dispose();

    const interactive = await createAgentSession({
      cwd: process.cwd(),
      loadResources: false,
      enableCompaction: false,
      askUser: async (req) => (req.options?.[1] ?? "PostgreSQL"),
    });
    const answered = await interactive.session.callToolAsUser("ask-user", {
      question: "Which DB?",
      options: ["SQLite", "PostgreSQL"],
    });
    expect(answered.isError).toBe(false);
    expect(answered.content[0]?.text).toBe("User answered: PostgreSQL");
    interactive.session.dispose();
  });

  it("disposes background bash jobs on session.dispose()", async () => {
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      loadResources: false,
      enableCompaction: false,
      safetyMode: "autonomous",
    });
    const started = await session.callToolAsUser("bash", {
      command: "sleep 30",
      background: true,
    });
    expect(started.isError).toBe(false);
    const pid = started.details?.pid as number | undefined;
    expect(typeof pid).toBe("number");

    session.dispose();
    await new Promise((r) => setTimeout(r, 250));

    let alive = true;
    try {
      if (pid !== undefined) process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("updates budget limits live via session.setBudgetLimits", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd(), loadResources: false, enableCompaction: false });
    const updated = session.setBudgetLimits?.({ maxCost: 0.25, maxTurns: 4 });
    expect(updated?.maxCost).toBe(0.25);
    expect(updated?.maxTurns).toBe(4);
    expect(session.budgetLimits?.().maxCost).toBe(0.25);
    expect(session.budgetLimits?.().maxTurns).toBe(4);
    session.dispose();
  });

  it("resolves /skill:<name> invocations and reports unknown skills clearly", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-skill-"));
    try {
      mkdirSync(join(root, ".agents", "skills", "review-pr"), { recursive: true });
      writeFileSync(
        join(root, ".agents", "skills", "review-pr", "SKILL.md"),
        "---\nname: review-pr\ndescription: Review diff carefully\n---\nCheck for bugs and missing tests.",
      );

      const resolved = await resolveSkillInvocation("/skill:review-pr src/app.ts", root);
      expect(resolved.error).toBeUndefined();
      expect(resolved.skill?.name).toBe("review-pr");
      expect(resolved.expandedPrompt).toContain('<skill name="review-pr"');
      expect(resolved.expandedPrompt).toContain("Check for bugs and missing tests.");
      expect(resolved.expandedPrompt).toContain("</skill>\n\nsrc/app.ts");

      const missing = await resolveSkillInvocation("/skill:nonexistent", root);
      expect(missing.error).toContain('Unknown skill "nonexistent"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("restores persisted thinkingLevel when resuming a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-think-"));
    const storageRoot = join(root, "sessions");
    try {
      const first = await createAgentSession({
        cwd: root,
        storageRoot,
        loadResources: false,
        enableCompaction: false,
      });
      expect(first.session.thinkingMode()).toBe("medium");
      await first.session.setThinkingLevel("high");
      const sessionId = first.manager.sessionId!;
      first.session.dispose();

      const resumed = await createAgentSession({
        cwd: root,
        storageRoot,
        loadResources: false,
        enableCompaction: false,
        resumeSession: sessionId,
      });
      expect(resumed.session.thinkingMode()).toBe("high");
      resumed.session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes MCP server tools end-to-end during an agent prompt turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-e2e-mcp-"));
    try {
      const mcpServerScript = `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
        rl.on("line", (line) => {
          if (!line.trim()) return;
          const m = JSON.parse(line);
          if (m.id === undefined) return;
          if (m.method === "initialize") {
            return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "calc" }, capabilities: { tools: {} } } });
          }
          if (m.method === "tools/list") {
            return send({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                tools: [{
                  name: "add",
                  description: "Add two numbers",
                  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
                  annotations: { readOnlyHint: true },
                }],
              },
            });
          }
          if (m.method === "tools/call") {
            const sum = Number(m.params.arguments.a) + Number(m.params.arguments.b);
            return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sum=" + sum }] } });
          }
          send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not found" } });
        });
      `;

      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            calc: { command: process.execPath, args: ["-e", mcpServerScript] },
          },
        }),
      );

      let turnCount = 0;
      const seenRequests: ModelRequest[] = [];
      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "mock-1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          seenRequests.push(req);
          turnCount += 1;
          if (turnCount === 1) {
            yield {
              type: "tool_call_complete",
              call: { type: "tool_call", id: "call-1", name: "mcp__calc__add", arguments: { a: 17, b: 25 } },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          const toolMsg = req.messages.find((m) => m.role === "tool");
          const toolText = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
          yield { type: "text_delta", delta: `Result from MCP: ${toolText}` };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { session, manager } = await createAgentSession({
        cwd: root,
        storageRoot: join(root, "sessions"),
        loadResources: false,
        enableCompaction: false,
        model,
        connectsOptions: {
          userConfigPath: join(root, "user-mcp.json"),
          trustFilePath: join(root, "trust.json"),
        },
      });

      // Project stdio starts untrusted (fail-closed)
      expect(session.connects?.getServerStatus("calc")?.state).toBe("untrusted");
      expect(session.toolNames()).not.toContain("mcp__calc__add");

      // User trusts server -> connects live and updates tool registry
      const trusted = await session.connects!.trustServer("calc");
      expect(trusted.state).toBe("connected");
      expect(session.toolNames()).toContain("mcp__calc__add");

      await session.prompt("Please compute 17 + 25 using calc.");

      expect(turnCount).toBe(2);
      expect(seenRequests[0]!.tools.some((t) => t.name === "mcp__calc__add")).toBe(true);
      const msgs = manager.getActiveMessages();
      const last = msgs[msgs.length - 1];
      const finalText = last?.message.content.find((b) => b.type === "text");
      expect(finalText?.type === "text" ? finalText.text : "").toBe("Result from MCP: sum=42");

      await session.connects!.dispose();
      session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps delegate absent by default and executes orchestrator -> explorer delegation end-to-end when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-e2e-subagents-"));
    try {
      writeFileSync(join(root, "secret-note.txt"), "team-delegation-token-99\n");

      let rootTurns = 0;
      let childTurns = 0;
      const model: ModelAdapter = {
        info: {
          provider: "mock",
          modelId: "orch-1",
          contextWindow: 32_000,
          maxOutputTokens: 1000,
          inputCostPer1M: 40,
          outputCostPer1M: 40,
        },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          const isChild = req.systemPrompt.includes('You are "explorer"');
          if (isChild) {
            childTurns += 1;
            if (childTurns === 1) {
              yield {
                type: "tool_call_complete",
                call: { type: "tool_call", id: "c1", name: "read", arguments: { path: "secret-note.txt" } },
              };
              yield { type: "usage", usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } };
              yield { type: "finished", reason: "tool_use" };
              return;
            }
            const toolMsg = req.messages.find((m) => m.role === "tool");
            const txt = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
            yield { type: "text_delta", delta: `Found token: ${txt.trim()}` };
            yield { type: "usage", usage: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0 } };
            yield { type: "finished", reason: "stop" };
            return;
          }

          rootTurns += 1;
          if (rootTurns === 1) {
            expect(req.systemPrompt).toContain("<team>");
            yield {
              type: "tool_call_complete",
              call: { type: "tool_call", id: "d1", name: "delegate", arguments: { agent: "explorer", task: "Read secret-note.txt" } },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          const toolMsg = req.messages.find((m) => m.role === "tool");
          const report = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
          yield { type: "text_delta", delta: `Orchestrator received -> ${report}` };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { session, manager } = await createAgentSession({
        cwd: root,
        storageRoot: join(root, "sessions"),
        loadResources: false,
        enableCompaction: false,
        enableConnects: false,
        model,
        subagentsOptions: {
          userAgentsDir: join(root, "user-agents"),
          userAgentsJsonPath: join(root, "user-agents.json"),
          trustFilePath: join(root, "agent-trust.json"),
        },
      });

      // Zero default bloat
      expect(session.subagents?.listStatuses()).toEqual([]);
      expect(session.toolNames()).not.toContain("delegate");

      // Opt-in explorer added dynamically
      await session.subagents!.addSubagent(
        {
          name: "explorer",
          description: "Read-only file investigator",
          mode: "readonly",
          tools: ["read"],
        },
        { scope: "user" },
      );
      expect(session.toolNames()).toContain("delegate");

      await session.prompt("Find the value in secret-note.txt via explorer.");
      const msgs = manager.getActiveMessages();
      const last = msgs[msgs.length - 1];
      const finalText = last?.message.content.find((b) => b.type === "text");
      expect(finalText?.type === "text" ? finalText.text : "").toContain("team-delegation-token-99");
      expect(session.budgetUsage().cost).toBeCloseTo(0.003, 5);

      await session.subagents!.dispose();
      session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows root orchestrator to propose and run a new specialist via create-subagent after explicit user approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-e2e-create-sub-"));
    try {
      writeFileSync(join(root, "architecture.txt"), "dynamic-specialist-verified-77\n");

      let rootTurns = 0;
      let childTurns = 0;
      const approvalRequests: string[] = [];

      const model: ModelAdapter = {
        info: {
          provider: "mock",
          modelId: "orch-dyn",
          contextWindow: 32_000,
          maxOutputTokens: 1000,
        },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          const isChild = req.systemPrompt.includes('You are "arch-auditor"');
          if (isChild) {
            childTurns += 1;
            if (childTurns === 1) {
              yield {
                type: "tool_call_complete",
                call: { type: "tool_call", id: "c1", name: "read", arguments: { path: "architecture.txt" } },
              };
              yield { type: "finished", reason: "tool_use" };
              return;
            }
            const toolMsg = req.messages.find((m) => m.role === "tool");
            const txt = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
            yield { type: "text_delta", delta: `Child audited: ${txt.trim()}` };
            yield { type: "finished", reason: "stop" };
            return;
          }

          rootTurns += 1;
          if (rootTurns === 1) {
            yield {
              type: "tool_call_complete",
              call: {
                type: "tool_call",
                id: "cs1",
                name: "create-subagent",
                arguments: {
                  name: "arch-auditor",
                  description: "Inspects architecture documents",
                  instruction: "Read architecture.txt and report exact values.",
                  mode: "readonly",
                  tools: ["read"],
                  scope: "memory",
                  reason: "Dedicated context for complex architecture check",
                  task: "Read architecture.txt and confirm verification token",
                },
              },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          const toolMsg = req.messages.find((m) => m.role === "tool");
          const out = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
          yield { type: "text_delta", delta: `Final synthesis -> ${out}` };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { session, manager } = await createAgentSession({
        cwd: root,
        storageRoot: join(root, "sessions"),
        loadResources: false,
        enableCompaction: false,
        enableConnects: false,
        safetyMode: "autonomous",
        policy: { approvalMode: "never" },
        model,
        requestApproval: async (prompt) => {
          approvalRequests.push(prompt);
          return true;
        },
        subagentsOptions: {
          userAgentsDir: join(root, "user-agents"),
          userAgentsJsonPath: join(root, "user-agents.json"),
          trustFilePath: join(root, "agent-trust.json"),
        },
      });

      await session.prompt("Solve this complex architecture check by spinning up a specialist if helpful.");

      expect(approvalRequests.length).toBe(1);
      expect(approvalRequests[0]).toContain("arch-auditor");
      const msgs = manager.getActiveMessages();
      const last = msgs[msgs.length - 1];
      const finalText = last?.message.content.find((b) => b.type === "text");
      expect(finalText?.type === "text" ? finalText.text : "").toContain("dynamic-specialist-verified-77");
      expect(session.subagents?.getStatus("arch-auditor")?.state).toBe("ready");

      await session.subagents!.dispose();
      session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
