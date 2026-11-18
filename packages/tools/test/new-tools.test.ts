import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ToolRegistry,
  AllowAllPolicy,
  DefaultPolicy,
  DEFAULT_POLICY_CONFIG,
  HookRegistry,
  HookExecutor,
  getBuiltinHooks,
  createLimitLargeToolResultsHook,
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
});
