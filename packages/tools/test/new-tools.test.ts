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
  createGrepTool,
  createFindTool,
  createGitDiffTool,
  createRmTool,
  createCatTool,
  createMemoryTool,
  createPlanTool,
  createTodoTool,
  createServeTool,
} from "../src/index.js";

describe("v1.0 tools fixes & search tools", () => {
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

  it("rm refuses deleting workspace root and cat blocks escapes cleanly", async () => {
    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createRmTool(root));
    registry.register(createCatTool(root));

    const rmRes = await registry.callTool("rm", { path: ".", recursive: true });
    expect(rmRes.isError).toBe(true);
    expect(rmRes.content[0]?.text).toContain("workspace root");

    const catRes = await registry.callTool("cat", { path: "../outside.txt" });
    expect(catRes.isError).toBe(true);
    expect(catRes.details?.code).toBe("E_TOOL_DENIED");
  });

  it("memory, plan, and todo persist across fresh tool instances in .kern/", async () => {
    const r1 = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    r1.register(createMemoryTool(root));
    r1.register(createPlanTool(root));
    r1.register(createTodoTool(root));

    await r1.callTool("memory", { action: "set", key: "branch", value: "main" });
    await r1.callTool("plan", { action: "add", id: "p1", title: "Release" });
    await r1.callTool("todo", { action: "add", content: "Write docs" });

    const r2 = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    r2.register(createMemoryTool(root));
    r2.register(createPlanTool(root));
    r2.register(createTodoTool(root));

    const mem = await r2.callTool("memory", { action: "get", key: "branch" });
    expect(mem.content[0]?.text).toBe("main");
    const plan = await r2.callTool("plan", { action: "list" });
    expect(plan.content[0]?.text).toContain("p1: Release");
    const todo = await r2.callTool("todo", { action: "list" });
    expect(todo.content[0]?.text).toContain("Write docs");
  });

  it("serve starts and stops a real loopback static server", async () => {
    writeFileSync(join(root, "hello.txt"), "hello-from-serve");
    const registry = new ToolRegistry({ workspaceRoot: root, policy: new AllowAllPolicy() });
    registry.register(createServeTool(root));

    const started = await registry.callTool("serve", { action: "start", port: 0, dir: "." });
    expect(started.isError).toBe(false);
    const port = started.details?.port as number;
    expect(port).toBeGreaterThan(0);

    const resp = await fetch(`http://127.0.0.1:${port}/hello.txt`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("hello-from-serve");

    const stopped = await registry.callTool("serve", { action: "stop" });
    expect(stopped.isError).toBe(false);
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
});
