import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ToolRegistry, createReadTool, createWriteTool, createEditTool, createBashTool, DefaultPolicy, AllowAllPolicy } from "../src/index.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy-config.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let testRoot: string;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tools-test-"));
  testRoot = root;
  return root;
}

beforeEach(() => {
  testRoot = freshRoot();
});

afterEach(() => {
  if (testRoot) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("ToolRegistry", () => {
  it("registers and retrieves tools", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    const tool = createReadTool(testRoot);
    registry.register(tool);
    expect(registry.has("read")).toBe(true);
    expect(registry.toolNames()).toContain("read");
  });

  it("unregisters tools", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    const tool = createReadTool(testRoot);
    registry.register(tool);
    registry.unregister("read");
    expect(registry.has("read")).toBe(false);
  });

  it("returns unknown tool error for unregistered tool", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    const result = await registry.callTool("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });

  it("lists model schemas", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    registry.register(createWriteTool(testRoot));
    const schemas = registry.listModelSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map(s => s.name).sort()).toEqual(["read", "write"]);
  });

  it("enforces argument validation", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    const result = await registry.callTool("read", { invalid: "args" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid arguments");
  });
});

describe("ReadTool", () => {
  it("reads a file", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    writeFileSync(join(testRoot, "test.txt"), "hello world");
    const result = await registry.callTool("read", { path: "test.txt" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("hello world");
  });

  it("reads a directory", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    mkdirSync(join(testRoot, "subdir"));
    writeFileSync(join(testRoot, "subdir", "a.txt"), "a");
    writeFileSync(join(testRoot, "subdir", "b.txt"), "b");
    const result = await registry.callTool("read", { path: "subdir" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("a.txt");
    expect(result.content[0]?.text).toContain("b.txt");
  });

  it("denies paths outside workspace", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    const result = await registry.callTool("read", { path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("escapes workspace");
  });

  it("handles offset and limit", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot });
    registry.register(createReadTool(testRoot));
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(testRoot, "big.txt"), lines);
    const result = await registry.callTool("read", { path: "big.txt", offset: 50, limit: 10 });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("50: line 50");
    expect(result.content[0]?.text).toContain("59: line 59");
  });
});

describe("WriteTool", () => {
  it("writes a new file", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createWriteTool(testRoot));
    const result = await registry.callTool("write", { path: "new.txt", content: "new content" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("Wrote new.txt");
  });

  it("creates parent directories", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createWriteTool(testRoot));
    const result = await registry.callTool("write", { path: "deep/nested/file.txt", content: "nested" });
    expect(result.isError).toBe(false);
  });

  it("rejects overwrite when file exists and overwrite is false", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createWriteTool(testRoot));
    writeFileSync(join(testRoot, "existing.txt"), "original");
    const result = await registry.callTool("write", { path: "existing.txt", content: "new", overwrite: false });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("File exists");
  });

  it("allows overwrite when explicitly set", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createWriteTool(testRoot));
    writeFileSync(join(testRoot, "existing.txt"), "original");
    const result = await registry.callTool("write", { path: "existing.txt", content: "new", overwrite: true });
    expect(result.isError).toBe(false);
  });

  it("rejects content too large", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createWriteTool(testRoot));
    const largeContent = "x".repeat(600_000);
    const result = await registry.callTool("write", { path: "large.txt", content: largeContent });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("too large");
  });
});

describe("EditTool", () => {
  it("replaces text in a file", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createEditTool(testRoot));
    writeFileSync(join(testRoot, "edit.txt"), "hello world");
    const result = await registry.callTool("edit", { path: "edit.txt", oldText: "world", newText: "universe" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("Edited edit.txt");
    expect(result.content[0]?.text).toContain("1 replacement");
  });

  it("rejects non-existent oldText", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createEditTool(testRoot));
    writeFileSync(join(testRoot, "edit.txt"), "hello world");
    const result = await registry.callTool("edit", { path: "edit.txt", oldText: "missing", newText: "universe" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("oldText not found");
  });

  it("rejects non-unique oldText without replaceAll", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createEditTool(testRoot));
    writeFileSync(join(testRoot, "edit.txt"), "hello world hello");
    const result = await registry.callTool("edit", { path: "edit.txt", oldText: "hello", newText: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not unique");
  });

  it("replaces all occurrences with replaceAll", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createEditTool(testRoot));
    writeFileSync(join(testRoot, "edit.txt"), "hello world hello");
    const result = await registry.callTool("edit", { path: "edit.txt", oldText: "hello", newText: "hi", replaceAll: true });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("Edited edit.txt");
    expect(result.content[0]?.text).toContain("2 replacements");
  });
});

describe("BashTool", () => {
  it("executes a simple command", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createBashTool({ root: testRoot }));
    const result = await registry.callTool("bash", { command: "echo hello" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("hello");
  });

  it("handles command failure", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createBashTool({ root: testRoot }));
    const result = await registry.callTool("bash", { command: "exit 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Exit code: 1");
  });

  it("captures stdout and stderr", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createBashTool({ root: testRoot }));
    const result = await registry.callTool("bash", { command: 'bash -c "echo stdout; echo stderr >&2"' });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("stdout");
    expect(result.content[0]?.text).toContain("stderr");
  });

  it("times out long-running commands", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register(createBashTool({ root: testRoot, timeoutMs: 500, sandbox: false }));
    const result = await registry.callTool("bash", { command: "sleep 10" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timeout");
  });
});

describe("DefaultPolicy", () => {
  it("allows read tools by default", async () => {
    const policy = new DefaultPolicy();
    const decision = await policy.evaluate({
      toolName: "read",
      arguments: { path: "test.txt" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "read",
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies tools in denylist", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, denylistTools: ["bash"] });
    const decision = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "echo test" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toContain("denylist");
  });

  it("allows only tools in allowlist when set", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, allowlistTools: ["read"] });
    const decision = await policy.evaluate({
      toolName: "write",
      arguments: { path: "test.txt", content: "x" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "write",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toContain("not in allowlist");
  });

  it("blocks sensitive paths", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, blockSensitivePaths: true });
    const decision = await policy.evaluate({
      toolName: "read",
      arguments: { path: "/home/user/.ssh/id_rsa" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "read",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toContain("sensitive path");
  });

  it("requires approval for destructive bash commands", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, approvalMode: "ask" });
    const decision = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "find /tmp -delete" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("require_approval");
  });

  it("respects destructiveAlwaysRequiresApproval when disabled", async () => {
    const policy = new DefaultPolicy({
      ...DEFAULT_POLICY_CONFIG,
      approvalMode: "auto-allowlist",
      destructiveAlwaysRequiresApproval: false,
    });
    const decision = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "find /tmp -delete" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("allow");
  });

  it("allows bash in auto-allowlist mode", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, approvalMode: "auto-allowlist" });
    const decision = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "echo test" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("allow");
  });

  it("allows session-approved tools", async () => {
    const policy = new DefaultPolicy({ ...DEFAULT_POLICY_CONFIG, approvalMode: "ask" });
    policy.allowForSession("bash");
    const decision = await policy.evaluate({
      toolName: "bash",
      arguments: { command: "echo test" },
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("allow");
  });
});

describe("ToolRegistry arg validation", () => {
  it("validates array item schemas", async () => {
    const registry = new ToolRegistry({ workspaceRoot: testRoot, policy: new AllowAllPolicy() });
    registry.register({
      name: "tags",
      description: "tags",
      inputSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
        required: ["tags"],
      },
      sideEffect: "read",
      async execute() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    } as any);
    const result = await registry.callTool("tags", { tags: ["a", 2] } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("$.tags[1]: expected string");
  });
});

describe("AllowAllPolicy", () => {
  it("allows everything", async () => {
    const policy = new AllowAllPolicy();
    const decision = await policy.evaluate({
      toolName: "anything",
      arguments: {},
      cwd: testRoot,
      origin: "model",
      sideEffect: "execute",
    });
    expect(decision.decision).toBe("allow");
  });
});