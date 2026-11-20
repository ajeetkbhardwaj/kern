import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BudgetTracker, ContextBuilder } from "@kern/agent-core";
import { ConnectManager } from "@kern/connects";
import { nullLogger, type ModelAdapter, type ModelRequest, type ModelStreamEvent } from "@kern/protocol";
import {
  DEFAULT_POLICY_CONFIG,
  DEFAULT_SAFETY_POLICY_CONFIG,
  DefaultPolicy,
  ToolRegistry,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "@kern/tools";
import {
  SUBAGENT_PRESETS,
  SubagentManager,
  discoverA2ACard,
  expandToolsList,
  findSubagentPreset,
  parseSubagentFile,
  parseSubagentMarkdown,
  parseSubagentYaml,
  renderSubagentMarkdown,
  renderSubagentTemplate,
  renderSubagentYaml,
  saveSubagentConfig,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

function makeHostSetup(opts: {
  cwd: string;
  model: ModelAdapter;
  parentBudget?: BudgetTracker;
  connects?: ConnectManager;
  safetyMode?: "strict" | "balanced" | "restricted" | "autonomous";
  approvalMode?: "ask" | "never" | "auto-allowlist";
  requestApproval?: (prompt: string) => Promise<boolean | "session">;
}) {
  const policyConfig = { ...DEFAULT_POLICY_CONFIG, approvalMode: opts.approvalMode ?? ("never" as const) };
  const policy = new DefaultPolicy(policyConfig, {
    ...DEFAULT_SAFETY_POLICY_CONFIG,
    mode: opts.safetyMode ?? "autonomous",
  });
  const registry = new ToolRegistry({
    workspaceRoot: opts.cwd,
    policy,
    requestApproval: opts.requestApproval,
  });
  registry.register(createReadTool(opts.cwd));
  registry.register(createWriteTool(opts.cwd));
  registry.register(createEditTool(opts.cwd));
  registry.register(createBashTool({ root: opts.cwd }));
  registry.register(createGrepTool(opts.cwd));
  registry.register(createFindTool(opts.cwd));

  const contextBuilder = new ContextBuilder({
    baseSystemPrompt: "You are Kern.",
    toolRegistry: registry,
    logger: nullLogger,
  });

  const parentBudget = opts.parentBudget ?? new BudgetTracker({ maxCost: 0, maxTotalTokens: 0 });
  const subagents = new SubagentManager({
    cwd: opts.cwd,
    logger: nullLogger,
    userAgentsDir: join(opts.cwd, "__user_agents"),
    userAgentsJsonPath: join(opts.cwd, "__user_agents.json"),
    trustFilePath: join(opts.cwd, "__agent_trust.json"),
  });

  subagents.bindRuntime(registry, {
    cwd: opts.cwd,
    logger: nullLogger,
    getModel: () => opts.model,
    getThinkingLevel: () => "medium",
    getParentBudget: () => parentBudget,
    getBudgetLimits: () => ({ maxCost: 0, maxTotalTokens: 0, maxInputTokens: 0, maxOutputTokens: 0 }),
    getPolicyConfig: () => policyConfig,
    getSafetyMode: () => opts.safetyMode ?? "autonomous",
    requestApproval: opts.requestApproval,
    connects: opts.connects,
    contextBuilder,
    storageRoot: join(opts.cwd, "__sessions"),
    parentSessionId: "root-sess",
  });

  return { registry, contextBuilder, parentBudget, subagents };
}

describe("@kern/subagents", () => {
  it("stays completely dormant (zero delegate tools and empty <team> section) when 0 specialists are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-dormant-"));
    try {
      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "finished", reason: "stop" };
        },
      };
      const { registry, contextBuilder, subagents } = makeHostSetup({ cwd: root, model: dummyModel });
      const res = await subagents.discover();
      expect(res.agents).toEqual([]);
      expect(registry.has("delegate")).toBe(false);
      expect(registry.has("delegate-status")).toBe(false);
      expect(registry.has("delegate-stop")).toBe(false);
      expect(subagents.buildTeamPromptSection()).toBe("");
      expect(contextBuilder.systemPrompt()).not.toContain("<team>");
      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses/renders markdown agents and provides opt-in presets", () => {
    expect(SUBAGENT_PRESETS.map((p) => p.id)).toEqual(["explorer", "reviewer", "coder", "researcher"]);
    const explorer = findSubagentPreset("explorer")!;
    const md = renderSubagentMarkdown(explorer.entry);
    const parsed = parseSubagentMarkdown(md, "explorer")!;
    expect(parsed.name).toBe("explorer");
    expect(parsed.mode).toBe("readonly");
    expect(parsed.tools).toEqual(["read", "grep", "find", "git-status", "git-diff", "git-log"]);
    expect(parsed.instruction).toContain("read-only codebase explorer");
  });

  it("enforces fail-closed trust on project-local write/MCP/A2A subagents while allowing pure-read ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-trust-"));
    try {
      mkdirSync(join(root, ".kern", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".kern", "agents", "scout.md"),
        "---\nname: scout\ndescription: Read-only scout\nmode: readonly\ntools: [read, grep, find]\n---\nFind code.",
      );
      writeFileSync(
        join(root, ".kern", "agents", "fixer.md"),
        "---\nname: fixer\ndescription: Write fixer\nmode: write\ntools: [read, edit]\n---\nFix code.",
      );
      writeFileSync(
        join(root, ".kern", "agents.json"),
        JSON.stringify({
          agents: {
            remote: {
              type: "a2a",
              url: "http://127.0.0.1:49999",
              description: "Remote team member",
            },
          },
        }),
      );

      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "finished", reason: "stop" };
        },
      };
      const { registry, subagents } = makeHostSetup({ cwd: root, model: dummyModel });
      await subagents.discover();

      expect(subagents.getStatus("scout")?.state).toBe("ready");
      expect(subagents.getStatus("fixer")?.state).toBe("untrusted");
      expect(subagents.getStatus("remote")?.state).toBe("untrusted");

      // Untrusted fixer refuses execution
      const denied = await registry.execute(
        "delegate",
        { agent: "fixer", task: "edit something" },
        new AbortController().signal,
      );
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain("untrusted");

      // Explicitly trusting unlocks it
      const trusted = await subagents.trustSubagent("fixer");
      expect(trusted.state).toBe("ready");
      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("charges parent BudgetTracker wallet and enforces child maxTurns & tool filtering in readonly mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-budget-"));
    try {
      const seenToolSets: string[][] = [];
      const model: ModelAdapter = {
        info: {
          provider: "mock",
          modelId: "child-m1",
          contextWindow: 32_000,
          maxOutputTokens: 1000,
          inputCostPer1M: 100,
          outputCostPer1M: 200,
        },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          seenToolSets.push(req.tools.map((t) => t.name));
          yield { type: "text_delta", delta: "Explored successfully." };
          yield {
            type: "usage",
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          };
          yield { type: "finished", reason: "stop" };
        },
      };

      const parentBudget = new BudgetTracker({ maxCost: 0.03 });
      const { registry, subagents } = makeHostSetup({ cwd: root, model, parentBudget });

      // Even if a readonly agent declares write/bash, runner must strip write tools!
      await subagents.addSubagent(
        {
          name: "explorer",
          description: "Read-only investigator",
          mode: "readonly",
          tools: ["read", "write", "bash", "grep"],
        },
        { scope: "memory" },
      );

      expect(registry.has("delegate")).toBe(true);
      const first = await registry.execute(
        "delegate",
        { agent: "explorer", task: "Inspect repo" },
        new AbortController().signal,
      );
      expect(first.isError).toBe(false);
      expect(first.content[0]?.text).toContain("Explored successfully.");
      expect(seenToolSets[0]).toEqual(["read", "grep"]);
      expect(parentBudget.usage().cost).toBeCloseTo(0.02, 5);
      expect(parentBudget.usage().inputTokens + parentBudget.usage().outputTokens).toBe(150);

      // Second delegation charges parent wallet past maxCost=0.03 -> child hits parent budget limit
      const second = await registry.execute(
        "delegate",
        { agent: "explorer", task: "Inspect again" },
        new AbortController().signal,
      );
      expect(parentBudget.usage().cost).toBeCloseTo(0.04, 5);
      expect(second.isError).toBe(true);
      expect(second.content[0]?.text).toContain("budget");

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent exclusive write subagents cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-exclusive-"));
    try {
      const timeline: Array<{ start: number; end: number }> = [];
      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 40));
          const end = Date.now();
          timeline.push({ start, end });
          yield { type: "text_delta", delta: "done" };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { registry, subagents } = makeHostSetup({ cwd: root, model });
      await subagents.addSubagent(
        {
          name: "coder",
          description: "Exclusive writer",
          mode: "write",
          isolation: "exclusive",
        },
        { scope: "memory" },
      );

      const [r1, r2] = await Promise.all([
        registry.execute("delegate", { agent: "coder", task: "Task A" }, new AbortController().signal),
        registry.execute("delegate", { agent: "coder", task: "Task B" }, new AbortController().signal),
      ]);
      expect(r1.isError).toBe(false);
      expect(r2.isError).toBe(false);
      expect(timeline.length).toBe(2);
      // Second run must start after first run ends (no overlapping execution)
      expect(timeline[1]!.start).toBeGreaterThanOrEqual(timeline[0]!.end - 1);

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs worktree-isolated write subagents without dirtying main working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-worktree-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Kern Test"], { cwd: root });
      writeFileSync(join(root, "app.txt"), "initial\n");
      await execFileAsync("git", ["add", "app.txt"], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

      let turn = 0;
      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(): AsyncIterable<ModelStreamEvent> {
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call_complete",
              call: { type: "tool_call", id: "w1", name: "write", arguments: { path: "app.txt", content: "modified in worktree\n", overwrite: true } },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          yield { type: "text_delta", delta: "Wrote change inside worktree." };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { registry, subagents } = makeHostSetup({ cwd: root, model });
      await subagents.addSubagent(
        {
          name: "wt-coder",
          description: "Worktree writer",
          mode: "write",
          isolation: "worktree",
          tools: ["read", "write"],
        },
        { scope: "memory" },
      );

      const res = await registry.execute(
        "delegate",
        { agent: "wt-coder", task: "Update app.txt cleanly" },
        new AbortController().signal,
      );
      expect(res.isError).toBe(false);
      expect(res.content[0]?.text).toContain("Wrote change inside worktree.");
      expect(res.content[0]?.text).toContain("<worktree_changes>");
      expect(res.content[0]?.text).toContain("app.txt");

      // Main workspace file must remain untouched!
      expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("initial\n");
      const { stdout: wtList } = await execFileAsync("git", ["worktree", "list"], { cwd: root });
      expect(wtList.trim().split("\n").length).toBe(1);

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares live parent ConnectManager MCP tools with allowlisted subagent without duplicating connections", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-mcp-"));
    try {
      const mcpScript = `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
        rl.on("line", (line) => {
          if (!line.trim()) return;
          const m = JSON.parse(line);
          if (m.id === undefined) return;
          if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "docs" }, capabilities: { tools: {} } } });
          if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
            { name: "search", description: "Search docs", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
            { name: "publish", description: "Write docs", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } }
          ] } });
          if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "doc-hit:" + m.params.arguments.q }] } });
          send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
        });
      `;

      const connects = new ConnectManager({
        cwd: root,
        logger: nullLogger,
        userConfigPath: join(root, "u-mcp.json"),
        trustFilePath: join(root, "mcp-trust.json"),
      });
      await connects.addServer("docs", { transport: "stdio", command: process.execPath, args: ["-e", mcpScript] }, { scope: "memory" });

      let turn = 0;
      const seenTools: string[] = [];
      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          if (turn === 0) seenTools.push(...req.tools.map((t) => t.name));
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call_complete",
              call: { type: "tool_call", id: "mc1", name: "mcp__docs__search", arguments: { q: "subagents" } },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          const toolMsg = req.messages.find((m) => m.role === "tool");
          const toolText = toolMsg?.content[0]?.type === "tool_result" ? toolMsg.content[0].content[0]?.text ?? "" : "";
          yield { type: "text_delta", delta: `Found: ${toolText}` };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { registry, subagents } = makeHostSetup({ cwd: root, model, connects });
      await subagents.addSubagent(
        {
          name: "doc-scout",
          description: "Docs MCP researcher",
          mode: "readonly",
          tools: ["read"],
          mcpServers: ["docs"],
        },
        { scope: "memory" },
      );

      const res = await registry.execute(
        "delegate",
        { agent: "doc-scout", task: "Search subagents docs" },
        new AbortController().signal,
      );
      expect(res.isError).toBe(false);
      expect(seenTools).toContain("mcp__docs__search");
      // Write MCP tool is filtered out in readonly subagent
      expect(seenTools).not.toContain("mcp__docs__publish");
      expect(res.content[0]?.text).toContain("Found: doc-hit:subagents");

      await subagents.dispose();
      await connects.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports background delegation status + abort stop and blocks recursive cycles / depth > 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-bg-cycle-"));
    try {
      let releaseChild!: () => void;
      const slowGate = new Promise<void>((r) => {
        releaseChild = r;
      });

      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          if (req.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("slow-bg")))) {
            await slowGate;
            yield { type: "text_delta", delta: "finished late" };
            yield { type: "finished", reason: "stop" };
            return;
          }
          // Try delegating back to self ("looper") to trigger cycle guard
          const hasToolRes = req.messages.find((m) => m.role === "tool");
          if (!hasToolRes) {
            yield {
              type: "tool_call_complete",
              call: { type: "tool_call", id: "rec1", name: "delegate", arguments: { agent: "looper", task: "loop" } },
            };
            yield { type: "finished", reason: "tool_use" };
            return;
          }
          const txt = hasToolRes.content[0]?.type === "tool_result" ? hasToolRes.content[0].content[0]?.text ?? "" : "";
          yield { type: "text_delta", delta: `Child observed: ${txt}` };
          yield { type: "finished", reason: "stop" };
        },
      };

      const { registry, subagents } = makeHostSetup({ cwd: root, model });
      await subagents.addSubagent(
        {
          name: "looper",
          description: "Cycle test agent",
          mode: "readonly",
          allowDelegation: true,
        },
        { scope: "memory" },
      );

      // Cycle detection: looper -> looper must be blocked
      const cycleRes = await registry.execute(
        "delegate",
        { agent: "looper", task: "test cycle" },
        new AbortController().signal,
      );
      expect(cycleRes.isError).toBe(false);
      expect(cycleRes.content[0]?.text).toContain("Refusing recursive cycle");

      // Background delegation -> status -> stop
      const startBg = await registry.execute(
        "delegate",
        { agent: "looper", task: "slow-bg task", background: true },
        new AbortController().signal,
      );
      expect(startBg.isError).toBe(false);
      const jobId = String(startBg.details?.jobId ?? "");
      expect(jobId).toMatch(/^sub_/);

      const st = await registry.execute("delegate-status", { jobId }, new AbortController().signal);
      expect(st.content[0]?.text).toContain("running");

      const stop = await registry.execute("delegate-stop", { jobId }, new AbortController().signal);
      expect(stop.isError).toBe(false);
      releaseChild();
      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers remote A2A Agent Card, polls working tasks, handles input-required, and sends tasks/cancel on abort", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-a2a-"));
    let pollCount = 0;
    let canceledIds: string[] = [];

    const a2aServer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: "remote-qa",
            description: "Remote A2A QA specialist",
            skills: [{ id: "qa", name: "qa-audit", description: "Audit endpoints" }],
          }),
        );
        return;
      }
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params?: any };
        res.writeHead(200, { "content-type": "application/json" });
        if (rpc.method === "message/send") {
          const text: string = rpc.params?.message?.parts?.[0]?.text ?? "";
          if (text.includes("need-input")) {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  id: "task-ask-1",
                  status: { state: "input-required", message: { parts: [{ kind: "text", text: "Which env: staging or prod?" }] } },
                },
              }),
            );
            return;
          }
          if (text.includes("never-finish")) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: "task-slow-1", status: { state: "working" } } }));
            return;
          }
          pollCount = 0;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: "task-1", status: { state: "working" } } }));
          return;
        }
        if (rpc.method === "tasks/get") {
          pollCount += 1;
          if (rpc.params?.id === "task-slow-1" || pollCount < 2) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: rpc.params?.id, status: { state: "working" } } }));
            return;
          }
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                id: "task-1",
                status: { state: "completed" },
                artifacts: [{ name: "report", parts: [{ kind: "text", text: "All A2A checks passed" }] }],
              },
            }),
          );
          return;
        }
        if (rpc.method === "tasks/cancel") {
          canceledIds.push(String(rpc.params?.id));
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: rpc.params?.id, status: { state: "canceled" } } }));
          return;
        }
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => a2aServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = a2aServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const card = await discoverA2ACard(baseUrl);
      expect(card.skills.map((s) => s.name)).toEqual(["qa-audit"]);

      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "finished", reason: "stop" };
        },
      };
      const { registry, subagents } = makeHostSetup({ cwd: root, model: dummyModel });
      const status = await subagents.addSubagent(
        {
          name: "remote-qa",
          type: "a2a",
          url: baseUrl,
          description: "Remote A2A QA service",
        },
        { scope: "user" },
      );
      expect(status.state).toBe("ready");
      expect(status.skills?.[0]?.name).toBe("qa-audit");

      const okRes = await registry.execute(
        "delegate",
        { agent: "remote-qa", task: "Run health audit" },
        new AbortController().signal,
      );
      expect(okRes.isError).toBe(false);
      expect(okRes.content[0]?.text).toContain("All A2A checks passed");

      const askRes = await registry.execute(
        "delegate",
        { agent: "remote-qa", task: "need-input deploy" },
        new AbortController().signal,
      );
      expect(askRes.isError).toBe(false);
      expect(askRes.content[0]?.text).toContain("taskId=task-ask-1");
      expect(askRes.content[0]?.text).toContain("Which env: staging or prod?");

      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 150);
      const cancelRes = await registry.execute(
        "delegate",
        { agent: "remote-qa", task: "never-finish check" },
        abortCtrl.signal,
      );
      expect(cancelRes.isError).toBe(true);
      expect(canceledIds).toContain("task-slow-1");

      await subagents.dispose();
    } finally {
      await new Promise<void>((resolve) => a2aServer.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses plain Markdown without frontmatter, YAML, single-file JSON, aliases, and tool-group shorthands", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-formats-"));
    try {
      mkdirSync(join(root, ".kern", "agents"), { recursive: true });

      // 1) Frontmatter-free plain Markdown with # Heading, Key: Value aliases, tool shorthand & ## Instructions
      const plainMd = [
        "# auditor",
        "Audits authentication and API boundaries for security risks.",
        "Mode: readonly",
        "Tools: readonly",
        "Max_Turns: 9",
        "",
        "## Instructions",
        "Inspect auth middleware and report exact file paths.",
      ].join("\n");
      writeFileSync(join(root, ".kern", "agents", "auditor.md"), plainMd);

      // 2) Single-agent YAML with multiline `instruction: |` and aliases in user agents dir
      mkdirSync(join(root, "__user_agents"), { recursive: true });
      const yamlDef = [
        "name: triager",
        "summary: Triages failing tests using readonly inspection",
        "mode: read-only",
        "tools: research",
        "max_turns: 7",
        "instruction: |",
        "  Identify the root cause of test failures.",
        "  Cite failing line numbers clearly.",
      ].join("\n");
      writeFileSync(join(root, "__user_agents", "triager.yaml"), yamlDef);

      // 3) Single-file JSON in .kern/agents/
      writeFileSync(
        join(root, ".kern", "agents", "linter.json"),
        JSON.stringify({
          name: "linter",
          description: "Checks formatting and lint conventions",
          mode: "readonly",
          tools: ["read", "grep"],
          instruction: "Check style issues.",
        }),
      );

      // Unit-check parseSubagentFile & renderSubagentTemplate
      const parsedYaml = parseSubagentYaml(yamlDef, "triager")!;
      expect(parsedYaml.name).toBe("triager");
      expect(parsedYaml.description).toBe("Triages failing tests using readonly inspection");
      expect(parsedYaml.mode).toBe("readonly");
      expect(parsedYaml.tools).toEqual(["web-fetch", "read", "grep", "find"]);
      expect(parsedYaml.maxTurns).toBe(7);
      expect(parsedYaml.instruction).toContain("Identify the root cause");

      const tplMd = renderSubagentTemplate(parsedYaml, "md");
      const tplYaml = renderSubagentTemplate(parsedYaml, "yaml");
      const tplJson = renderSubagentTemplate(parsedYaml, "json");
      expect(parseSubagentFile(tplMd, ".md")?.name).toBe("triager");
      expect(parseSubagentFile(renderSubagentYaml(parsedYaml), ".yaml")?.name).toBe("triager");
      expect(parseSubagentFile(tplYaml, ".yaml")?.name).toBe("triager");
      expect(parseSubagentFile(tplJson, ".json")?.name).toBe("triager");

      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "finished", reason: "stop" };
        },
      };
      const { subagents } = makeHostSetup({ cwd: root, model: dummyModel });
      await subagents.discover();

      const auditor = subagents.getStatus("auditor");
      expect(auditor?.state).toBe("ready");
      expect(auditor?.mode).toBe("readonly");
      expect(auditor?.tools).toEqual(["read", "grep", "find", "git-status", "git-diff", "git-log"]);

      const triager = subagents.getStatus("triager");
      expect(triager?.state).toBe("ready");
      expect(triager?.tools).toEqual(["web-fetch", "read", "grep", "find"]);

      const linter = subagents.getStatus("linter");
      expect(linter?.state).toBe("ready");
      expect(linter?.tools).toEqual(["read", "grep"]);

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates create-subagent behind explicit user permission (fails closed when headless or denied, runs immediately when approved)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-create-gate-"));
    try {
      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "text_delta", delta: "Deep analysis finished." };
          yield { type: "finished", reason: "stop" };
        },
      };

      // 1) Headless (no requestApproval and no askUser) must fail closed even in autonomous mode
      const headless = makeHostSetup({
        cwd: root,
        model: dummyModel,
        safetyMode: "autonomous",
        approvalMode: "never",
      });
      await headless.subagents.discover();
      expect(headless.registry.has("create-subagent")).toBe(true);
      const headlessRes = await headless.registry.execute(
        "create-subagent",
        {
          name: "perf-analyst",
          description: "Profiles hot loops",
          instruction: "Analyze bottlenecks.",
          mode: "readonly",
          reason: "Complex performance audit",
        },
        new AbortController().signal,
      );
      expect(headlessRes.isError).toBe(true);
      expect(headlessRes.details?.code).toBe("E_TOOL_DENIED");
      expect(headless.subagents.getStatus("perf-analyst")).toBeUndefined();
      await headless.subagents.dispose();

      // 2) Interactive user denial must refuse creation and not persist/register the agent
      const denialPrompts: string[] = [];
      const deniedSetup = makeHostSetup({
        cwd: root,
        model: dummyModel,
        safetyMode: "autonomous",
        approvalMode: "never",
        requestApproval: async (prompt) => {
          denialPrompts.push(prompt);
          return false;
        },
      });
      await deniedSetup.subagents.discover();
      const deniedRes = await deniedSetup.registry.execute(
        "create-subagent",
        {
          name: "perf-analyst",
          description: "Profiles hot loops",
          instruction: "Analyze bottlenecks.",
          mode: "readonly",
          reason: "Need focused trace",
        },
        new AbortController().signal,
      );
      expect(denialPrompts.length).toBe(1);
      expect(denialPrompts[0]).toContain("perf-analyst");
      expect(deniedRes.isError).toBe(true);
      expect(deniedRes.details?.code).toBe("E_TOOL_DENIED");
      expect(deniedSetup.subagents.getStatus("perf-analyst")).toBeUndefined();
      await deniedSetup.subagents.dispose();

      // 3) Interactive user approval creates specialist AND immediately executes optional task
      const approvedPrompts: string[] = [];
      const approvedSetup = makeHostSetup({
        cwd: root,
        model: dummyModel,
        safetyMode: "autonomous",
        approvalMode: "never",
        requestApproval: async (prompt) => {
          approvedPrompts.push(prompt);
          return true;
        },
      });
      await approvedSetup.subagents.discover();
      expect(approvedSetup.registry.has("delegate")).toBe(false);

      const okRes = await approvedSetup.registry.execute(
        "create-subagent",
        {
          name: "perf-analyst",
          description: "Profiles hot loops",
          instruction: "Analyze bottlenecks concisely.",
          mode: "readonly",
          tools: ["readonly"],
          scope: "memory",
          reason: "Large multi-module hot-path analysis",
          task: "Audit hot loop bottlenecks",
        },
        new AbortController().signal,
      );
      expect(approvedPrompts.length).toBe(1);
      expect(approvedPrompts[0]).toContain('Allow creating & running subagent "perf-analyst"');
      expect(approvedPrompts[0]).toContain("Initial Task: Audit hot loop bottlenecks");
      expect(okRes.isError).toBe(false);
      expect(okRes.content[0]?.text).toContain('[created subagent="perf-analyst"');
      expect(okRes.content[0]?.text).toContain("Deep analysis finished.");
      expect(approvedSetup.subagents.getStatus("perf-analyst")?.state).toBe("ready");
      expect(approvedSetup.registry.has("delegate")).toBe(true);

      await approvedSetup.subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles bug-hunt edge cases: traversal names, plain MD blank lines & bullets, commented YAML auto-detect, project overrides, and format switching", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-bughunt-"));
    try {
      const userAgentsDir = join(root, "__user_agents");
      const userAgentsJsonPath = join(root, "__user_agents.json");
      const trustFilePath = join(root, "__agent_trust.json");
      mkdirSync(userAgentsDir, { recursive: true });
      mkdirSync(join(root, ".kern", "agents"), { recursive: true });

      // 1) Reject traversal & leading-dot names
      for (const bad of [".", "..", ".hidden", "../escape"]) {
        await expect(
          saveSubagentConfig("project", root, { name: bad, description: "Invalid" }, { userAgentsDir, userAgentsJsonPath }),
        ).rejects.toThrow(/Invalid subagent name/i);
      }

      // 2) Plain Markdown with spaces in heading, blank line before metadata, and bulleted tools list
      const spacedMd = [
        "# Security Reviewer",
        "Reviews authentication flows and session checks.",
        "",
        "Mode: readonly",
        "Tools:",
        "  - read",
        "  - grep",
        "",
        "## Instructions",
        "Check every token verifier carefully.",
      ].join("\n");
      const parsedSpaced = parseSubagentFile(spacedMd, "", "custom-agent")!;
      expect(parsedSpaced.name).toBe("security-reviewer");
      expect(parsedSpaced.description).toBe("Reviews authentication flows and session checks.");
      expect(parsedSpaced.tools).toEqual(["read", "grep"]);
      expect(parsedSpaced.instruction).toBe("Check every token verifier carefully.");

      // 3) Commented YAML template pasted without file extension auto-detects as YAML
      const commentedYaml = renderSubagentTemplate(
        {
          name: "yaml-worker",
          description: "Handles YAML-defined tasks",
          mode: "readonly",
          tools: ["readonly"],
          instruction: "Inspect code thoroughly.",
        },
        "yaml",
      );
      const parsedAutoYaml = parseSubagentFile(commentedYaml, "")!;
      expect(parsedAutoYaml.name).toBe("yaml-worker");
      expect(parsedAutoYaml.tools).toEqual(expandToolsList(["readonly"]));

      // 4) Switching format from md -> yaml removes stale .md sibling and project overrides user cleanly
      await saveSubagentConfig(
        "user",
        root,
        { name: "auditor", description: "User global auditor", mode: "readonly", tools: ["read"] },
        { userAgentsDir, userAgentsJsonPath, format: "md" },
      );
      expect(readFileSync(join(userAgentsDir, "auditor.md"), "utf8")).toContain("User global auditor");

      await saveSubagentConfig(
        "user",
        root,
        { name: "auditor", description: "User YAML auditor", mode: "readonly", tools: ["read", "grep"] },
        { userAgentsDir, userAgentsJsonPath, format: "yaml" },
      );
      expect(() => readFileSync(join(userAgentsDir, "auditor.md"), "utf8")).toThrow();
      expect(readFileSync(join(userAgentsDir, "auditor.yaml"), "utf8")).toContain("User YAML auditor");

      // Project override of "auditor" wins over user default, while write mode still enforces fail-closed trust
      writeFileSync(
        join(root, ".kern", "agents", "auditor.md"),
        "---\nname: auditor\ndescription: Project write auditor\nmode: write\ntools: [read, edit]\n---\nEdit carefully.",
      );

      const dummyModel: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream() {
          yield { type: "text_delta", delta: "ok" };
          yield { type: "finished", reason: "stop" };
        },
      };
      const subagents = new SubagentManager({
        cwd: root,
        logger: nullLogger,
        userAgentsDir,
        userAgentsJsonPath,
        trustFilePath,
      });
      await subagents.discover();
      const overridden = subagents.getStatus("auditor");
      expect(overridden?.origin).toBe("project");
      expect(overridden?.state).toBe("untrusted");
      expect(overridden?.description).toBe("Project write auditor");

      // Project subagent created with shorthand tools ("coding") must remain trusted after discover()
      await subagents.addSubagent(
        { name: "writer-shorthand", description: "Fix code", mode: "write", tools: ["coding"], instruction: "Edit files." },
        { scope: "project", format: "md" },
      );
      expect(subagents.getStatus("writer-shorthand")?.state).toBe("ready");
      await subagents.discover();
      expect(subagents.getStatus("writer-shorthand")?.state).toBe("ready");
      expect(subagents.getStatus("writer-shorthand")?.tools).toEqual(expandToolsList(["coding"]));

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves memory subagents on discover(), expands tool shorthands in create-subagent, and warns on overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "kern-sub-mem-"));
    try {
      const seenChildTools: string[] = [];
      const model: ModelAdapter = {
        info: { provider: "mock", modelId: "m1", contextWindow: 32_000, maxOutputTokens: 1000 },
        async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
          seenChildTools.push(...req.tools.map((t) => t.name));
          yield { type: "text_delta", delta: "inspected with expanded tools" };
          yield { type: "finished", reason: "stop" };
        },
      };

      const prompts: string[] = [];
      const { registry, subagents } = makeHostSetup({
        cwd: root,
        model,
        requestApproval: async (prompt) => {
          prompts.push(prompt);
          return true;
        },
      });
      await subagents.discover();

      // Reject dot traversal name inside create-subagent
      const badCreate = await registry.execute(
        "create-subagent",
        { name: "..", description: "bad", instruction: "bad" },
        new AbortController().signal,
      );
      expect(badCreate.isError).toBe(true);
      expect(badCreate.details?.code).toBe("E_TOOL_INVALID_ARGS");

      // Create memory agent with tools: ["readonly"] shorthand -> runner MUST expose expanded read/grep/find/git-* tools
      const createRes = await registry.execute(
        "create-subagent",
        {
          name: "scout-mem",
          description: "Session-only codebase scout",
          instruction: "Search cleanly.",
          mode: "readonly",
          tools: ["readonly"],
          scope: "memory",
          task: "Scan workspace",
        },
        new AbortController().signal,
      );
      expect(createRes.isError).toBe(false);
      expect(createRes.content[0]?.text).toContain("inspected with expanded tools");
      expect(seenChildTools).toContain("read");
      expect(seenChildTools).toContain("grep");
      expect(seenChildTools).toContain("find");

      // discover() must NOT wipe memory-scoped agents!
      await subagents.discover();
      expect(subagents.getStatus("scout-mem")?.state).toBe("ready");
      expect(registry.has("delegate")).toBe(true);

      // Re-proposing same name warns that it replaces an existing subagent
      await registry.execute(
        "create-subagent",
        {
          name: "scout-mem",
          description: "Updated scout",
          instruction: "Search again.",
          mode: "readonly",
        },
        new AbortController().signal,
      );
      expect(prompts[1]).toContain('replaces existing memory subagent "scout-mem"');

      await subagents.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
