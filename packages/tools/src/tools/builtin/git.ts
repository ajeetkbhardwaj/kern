import { ToolDefinition, ToolResult, boundText, textResult } from "@kern/protocol";
import { safeResolveSync } from "../../path-safety.js";
import { spawnProcess } from "./spawn.js";

const MAX_CAPTURE_BYTES = 1_000_000;

export function createGitStatusTool(_root: string): ToolDefinition<{ path?: string }> {
  return {
    name: "git-status",
    description: "Show git status of working tree",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Repository path (default: workspace root)" } },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      const { stdout, stderr, code } = await spawnProcess("git", ["status", "--short"], { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(code !== 0 && !stdout ? stderr : stdout);
      return { content: [{ type: "text", text: out.text || "(clean)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitDiffTool(_root: string): ToolDefinition<{ path?: string; staged?: boolean }> {
  return {
    name: "git-diff",
    description: "Show git diff of working tree or staged changes",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path" },
        staged: { type: "boolean", description: "Show staged changes instead of working tree" },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      const cmdArgs = args.staged ? ["diff", "--cached"] : ["diff"];
      const { stdout, stderr, code } = await spawnProcess("git", cmdArgs, { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(code !== 0 && !stdout ? stderr : stdout);
      return { content: [{ type: "text", text: out.text || "(no changes)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitLogTool(_root: string): ToolDefinition<{ path?: string; limit?: number }> {
  return {
    name: "git-log",
    description: "Show git commit history",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      const limit = Math.max(1, Math.min(100, args.limit ?? 20));
      const { stdout, stderr, code } = await spawnProcess("git", ["log", "--oneline", `-${limit}`], { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(code !== 0 && !stdout ? stderr : stdout);
      return { content: [{ type: "text", text: out.text || "(no commits)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitCheckoutTool(_root: string): ToolDefinition<{ branch: string; create?: boolean; path?: string }> {
  return {
    name: "git-checkout",
    description: "Switch branches or create new branch",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name to checkout" },
        create: { type: "boolean", description: "Create new branch (-b)" },
        path: { type: "string", description: "Repository path" },
      },
      required: ["branch"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      const cmdArgs = args.create ? ["checkout", "-b", args.branch] : ["checkout", args.branch];
      const { stdout, stderr, code } = await spawnProcess("git", cmdArgs, { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stdout);
      const err = boundText(stderr);
      let text = `Exit code: ${code ?? -1}\n`;
      if (out.text) text += `stdout:\n${out.text}\n`;
      if (err.text) text += `stderr:\n${err.text}\n`;
      return { content: [{ type: "text", text }], isError: code !== 0 };
    },
  };
}