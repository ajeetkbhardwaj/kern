import { ToolDefinition, ToolResult } from "@kern/protocol";
import { stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { safeResolveSync } from "../../path-safety.js";
import { boundText, textResult } from "@kern/protocol";
import { spawnProcess } from "./spawn.js";

const MAX_CAPTURE_BYTES = 1_000_000;

export function createGitStatusTool(root: string): ToolDefinition<{ path?: string }> {
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
      const target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      const { stdout, code } = await spawnProcess("git", ["status", "--short"], { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stdout);
      return { content: [{ type: "text", text: out.text || "(clean)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitDiffTool(root: string): ToolDefinition<{ path?: string; staged?: boolean }> {
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
      const target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      const cmd = args.staged ? ["git", "diff", "--cached"] : ["git", "diff"];
      const { stdout, code } = await spawnProcess("git", cmd, { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stdout);
      return { content: [{ type: "text", text: out.text || "(no changes)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitLogTool(root: string): ToolDefinition<{ path?: string; limit?: number }> {
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
      const target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      const limit = args.limit ?? 20;
      const { stdout, code } = await spawnProcess("git", ["log", "--oneline", `-${limit}`], { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stdout);
      return { content: [{ type: "text", text: out.text || "(no commits)" }], isError: code !== 0, details: out.truncated ? { truncated: true } : undefined };
    },
  };
}

export function createGitCheckoutTool(root: string): ToolDefinition<{ branch: string; create?: boolean; path?: string }> {
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
      const target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      const cmd = args.create ? ["git", "checkout", "-b", args.branch] : ["git", "checkout", args.branch];
      const { stdout, stderr, code } = await spawnProcess("git", cmd, { cwd: target, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stdout);
      const err = boundText(stderr);
      let text = `Exit code: ${code ?? -1}\n`;
      if (out.text) text += `stdout:\n${out.text}\n`;
      if (err.text) text += `stderr:\n${err.text}\n`;
      return { content: [{ type: "text", text }], isError: code !== 0 };
    },
  };
}