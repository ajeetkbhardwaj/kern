import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ToolRegistry,
  AllowAllPolicy,
  DefaultPolicy,
  DEFAULT_POLICY_CONFIG,
  HookRegistry,
  HookExecutor,
  getBuiltinHooks,
  createLimitLargeToolResultsHook,
  registerDefaultBuiltinHandlers,
  loadDefaultHookConfigs,
  createReadTool,
  createEditTool,
  createBashTool,
  BackgroundJobManager,
  createBashStatusTool,
  createBashStopTool,
  createWebFetchTool,
  isBlockedIp,
  htmlToReadableText,
  createAskUserTool,
  createGrepTool,
  createFindTool,
  createGitDiffTool,
  createTodoTool,
} from "../src/index.js";

describe("v1.0 tools, hooks, and search tools", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kern-newtools-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("grep finds matching lines and respects .agentignore", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "ignored"), { recursive: true });
    writeFileSync(join(root, ".agentignore"), "ignored/\n");
    writeFileSync(join(root, "src", "app.ts"), "export const helloWorld = 42;\nconst other = 1;\n");
    writeFileSync(join(root, "ignored", "secret.ts"), "const helloWorld = 99;\n");

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createGrepTool(root));

    const res = await registry.callTool("grep", { pattern: "helloWorld" });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("src/app.ts:1:");
    expect(res.content[0]?.text).not.toContain("ignored/secret.ts");
  });

  it("find discovers workspace files by glob pattern", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, "src", "b.md"), "b");

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createFindTool(root));

    const res = await registry.callTool("find", { pattern: "*.ts" });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("src/a.ts");
    expect(res.content[0]?.text).not.toContain("b.md");
  });

  it("git-diff works against a real git repo without double-git bug", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "file.txt"), "line1\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "file.txt"), "line1\nline2\n");

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createGitDiffTool(root));

    const res = await registry.callTool("git-diff", {});
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("+line2");
  });

  it("todo persists across fresh tool instances in .kern/", async () => {
    const r1 = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    r1.register(createTodoTool(root));

    await r1.callTool("todo", { action: "add", content: "Write docs" });

    const r2 = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    r2.register(createTodoTool(root));

    const todo = await r2.callTool("todo", { action: "list" });
    expect(todo.content[0]?.text).toContain("Write docs");
  });

  it("DefaultPolicy preserves sibling rules in updatePermissionRules and respects annotations", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, approvalMode: "ask" });
    policy.updatePermissionRules({ denyRules: ["rm -rf *"], allowRules: ["echo *"] });

    const denied = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "rm -rf /tmp/x" },
      cwd: root,
      origin: "model",
      sideEffect: "execute",
    });
    expect(denied.decision).toBe("deny");

    const destructiveAnnotated = await policy.evaluate({
      toolName: "custom-tool",
      arguments: {},
      cwd: root,
      origin: "model",
      sideEffect: "read",
      annotations: { destructiveHint: true },
    });
    expect(destructiveAnnotated.decision).toBe("require_approval");
  });

  it("limitLargeToolResultsHook and redactSecretsHook compose via HookExecutor.runTransform", async () => {
    const hookRegistry = new HookRegistry();
    for (const reg of getBuiltinHooks({ redactMode: "auto", maxResultChars: 120 })) {
      hookRegistry.register(reg);
    }
    const hookExecutor = new HookExecutor(hookRegistry);

    const registry = new ToolRegistry({
      workspaceRoot: root,
      policy: new AllowAllPolicy(),
      hookExecutor,
    });
    registry.register({
      name: "echo-big",
      description: "Emit secret and long text",
      inputSchema: { type: "object", properties: {} },
      sideEffect: "read",
      async execute() {
        return {
          content: [{ type: "text", text: `token: sk-secret1234567890abcd\n${"x".repeat(300)}` }],
          isError: false,
        };
      },
    });

    const res = await registry.callTool("echo-big", {});
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).not.toContain("sk-secret1234567890abcd");
    expect(res.content[0]?.text).toContain("[REDACTED]");
    expect(res.content[0]?.text).toContain("characters truncated");
    expect(res.details?.truncated).toBe(true);
  });

  it("createLimitLargeToolResultsHook handles zero limit without slice(-0) bug", async () => {
    const hook = createLimitLargeToolResultsHook(0);
    const ctx = { timestamp: new Date().toISOString() };
    const out = (await hook(ctx, {
      toolName: "read",
      args: {},
      origin: "model",
      result: { content: [{ type: "text", text: "abcdefghij" }], isError: false },
    })) as [typeof ctx, { result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> } }];

    expect(out[1].result.content[0]?.text).toContain("10 characters truncated");
    expect(out[1].result.content[0]?.text).not.toContain("abcdefghij");
    expect(out[1].result.details?.truncated).toBe(true);
  });

  it("ToolRegistry withholds deferred tools until activated and repairs malformed JSON args", async () => {
    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register({
      name: "always-on",
      description: "Normal tool",
      inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      sideEffect: "read",
      async execute(args: { count: number }) {
        return { content: [{ type: "text", text: `count=${args.count}` }], isError: false };
      },
    });
    registry.register({
      name: "lazy-tool",
      description: "Deferred tool",
      inputSchema: { type: "object", properties: {} },
      sideEffect: "read",
      deferred: true,
      async execute() {
        return { content: [{ type: "text", text: "lazy-ok" }], isError: false };
      },
    });

    expect(registry.listModelSchemas().map((t) => t.name)).toEqual(["always-on"]);
    expect(registry.activateTool("lazy-tool")).toBe(true);
    expect(registry.listModelSchemas().map((t) => t.name)).toEqual(["always-on", "lazy-tool"]);

    const repaired: string[] = [];
    const res = await registry.callTool("always-on", { _raw: '{"count": "7",}' }, {
      onArgRepair: (r: string[]) => repaired.push(...r),
    });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe("count=7");
    expect(repaired.length).toBeGreaterThan(0);
  });

  it("executes YAML-configured builtin hooks loaded via loadDefaultHookConfigs without spread error", async () => {
    mkdirSync(join(root, ".kern"), { recursive: true });
    writeFileSync(
      join(root, ".kern", "hooks.yaml"),
      [
        "hooks:",
        "  - event: tool_response_transform",
        "    handler: redact_secrets_response",
        "    priority: 100",
        "  - event: tool_response_transform",
        "    handler: limit_large_tool_results",
        "    priority: 200",
        "",
      ].join("\n"),
    );

    registerDefaultBuiltinHandlers();
    const hookRegistry = new HookRegistry();
    const loaded = await loadDefaultHookConfigs(hookRegistry, root);
    expect(loaded.loaded).toBe(2);

    const hookExecutor = new HookExecutor(hookRegistry);
    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy(), hookExecutor });
    registry.register({
      name: "yaml-test-tool",
      description: "Emit secret",
      inputSchema: { type: "object", properties: {} },
      sideEffect: "read",
      async execute() {
        return {
          content: [{ type: "text", text: "token: ghp_1234567890abcdefghij123456" }],
          isError: false,
        };
      },
    });

    const res = await registry.callTool("yaml-test-tool", {});
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).not.toContain("ghp_1234567890abcdefghij123456");
    expect(res.content[0]?.text).toContain("[REDACTED]");
  });

  it("manages background bash jobs via bash(background), bash-status, and bash-stop", async () => {
    const manager = new BackgroundJobManager();
    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createBashTool({ root, backgroundManager: manager }));
    registry.register(createBashStatusTool(manager));
    registry.register(createBashStopTool(manager));

    try {
      const started = await registry.callTool("bash", {
        command: 'echo "bg-ready"; sleep 30',
        background: true,
      });
      expect(started.isError).toBe(false);
      const jobId = started.details?.jobId as string;
      expect(jobId).toMatch(/^bg_/);
      expect(started.details?.running).toBe(true);
      expect(started.content[0]?.text).toContain("bg-ready");

      const list = await registry.callTool("bash-status", {});
      expect(list.isError).toBe(false);
      expect(list.content[0]?.text).toContain(jobId);
      expect(list.content[0]?.text).toContain("running");

      const detail = await registry.callTool("bash-status", { jobId, incremental: true });
      expect(detail.isError).toBe(false);
      expect(detail.content[0]?.text).toContain("bg-ready");

      const stopped = await registry.callTool("bash-stop", { jobId });
      expect(stopped.isError).toBe(false);
      expect(stopped.details?.running).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("web-fetch blocks private/local SSRF targets and formats HTML and JSON safely", async () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("172.16.5.1")).toBe(true);
    expect(isBlockedIp("192.168.1.10")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);

    expect(
      htmlToReadableText("<html><body><script>bad()</script><h1>Title</h1><p>Hello &amp; world</p></body></html>"),
    ).toBe("Title\n\nHello & world");

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createWebFetchTool());

    for (const badUrl of [
      "http://127.0.0.1:3000/",
      "http://localhost:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
    ]) {
      const denied = await registry.callTool("web-fetch", { url: badUrl });
      expect(denied.isError).toBe(true);
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (u === "https://93.184.216.34/redirect-local") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
      }
      return new Response("<html><style>x{}</style><body><p>Public Docs</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof fetch;

    try {
      const okRes = await registry.callTool("web-fetch", { url: "https://93.184.216.34/docs" });
      expect(okRes.isError).toBe(false);
      expect(okRes.content[0]?.text).toContain("HTTP 200");
      expect(okRes.content[0]?.text).toContain("Public Docs");
      expect(okRes.content[0]?.text).not.toContain("<style>");

      const redirectBlocked = await registry.callTool("web-fetch", { url: "https://93.184.216.34/redirect-local" });
      expect(redirectBlocked.isError).toBe(true);
      expect(redirectBlocked.content[0]?.text).toContain("Blocked IP");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("ask-user fails closed when no handler is configured and returns user answer when wired", async () => {
    const headlessRegistry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    headlessRegistry.register(createAskUserTool());

    const denied = await headlessRegistry.callTool("ask-user", { question: "Continue?" });
    expect(denied.isError).toBe(true);
    expect(denied.details?.code).toBe("E_TOOL_DENIED");

    const interactiveRegistry = new ToolRegistry({
      workspaceRoot: root,
      policy: new AllowAllPolicy(),
      askUser: async (req) => (req.question.includes("framework") ? "Vitest" : null),
    });
    interactiveRegistry.register(createAskUserTool());

    const answered = await interactiveRegistry.callTool("ask-user", {
      question: "Pick a test framework",
      options: ["Vitest", "Node test"],
    });
    expect(answered.isError).toBe(false);
    expect(answered.content[0]?.text).toBe("User answered: Vitest");

    const cancelled = await interactiveRegistry.callTool("ask-user", { question: "Cancel me" });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.details?.cancelled).toBe(true);
  });

  it("read appends line-range pagination footer for partial slices", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(root, "sample.txt"), lines);

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createReadTool(root));

    const first = await registry.callTool("read", { path: "sample.txt", offset: 1, limit: 5 });
    expect(first.isError).toBe(false);
    expect(first.content[0]?.text).toContain("[Lines 1-5 of 20 — use offset=6 to read more]");

    const tail = await registry.callTool("read", { path: "sample.txt", offset: 16, limit: 10 });
    expect(tail.isError).toBe(false);
    expect(tail.content[0]?.text).toContain("[Lines 16-20 of 20]");
    expect(tail.content[0]?.text).not.toContain("use offset=");

    const full = await registry.callTool("read", { path: "sample.txt" });
    expect(full.isError).toBe(false);
    expect(full.content[0]?.text).not.toContain("[Lines ");
  });

  it("edit applies multi-hunk edits atomically and diagnoses indentation mismatches", async () => {
    const filePath = join(root, "code.ts");
    writeFileSync(filePath, "function greet() {\n    return 'hello';\n}\nconst x = 1;\n");

    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createEditTool(root));

    const mismatch = await registry.callTool("edit", {
      path: "code.ts",
      oldText: "function greet() {\n  return 'hello';\n}",
      newText: "function greet() {\n  return 'hi';\n}",
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0]?.text).toContain("oldText not found");
    expect(mismatch.content[0]?.text).toContain("different indentation/whitespace near line 1");

    const failedBatch = await registry.callTool("edit", {
      path: "code.ts",
      edits: [
        { oldText: "return 'hello';", newText: "return 'hi';" },
        { oldText: "nonexistent line", newText: "y" },
      ],
    });
    expect(failedBatch.isError).toBe(true);
    // Atomic guarantee: first hunk must not have been written when second hunk fails
    expect(readFileSync(filePath, "utf8")).toContain("return 'hello';");

    const okBatch = await registry.callTool("edit", {
      path: "code.ts",
      edits: [
        { oldText: "return 'hello';", newText: "return 'hi';" },
        { oldText: "const x = 1;", newText: "const x = 2;\nconst y = 3;" },
      ],
    });
    expect(okBatch.isError).toBe(false);
    expect(okBatch.content[0]?.text).toContain("2 replacements");
    expect(readFileSync(filePath, "utf8")).toBe("function greet() {\n    return 'hi';\n}\nconst x = 2;\nconst y = 3;\n");
  });
});
