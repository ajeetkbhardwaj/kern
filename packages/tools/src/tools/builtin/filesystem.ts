import { ToolDefinition, ToolResult } from "@kern/protocol";
import { stat, mkdir, rm, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { safeResolveSync } from "../../path-safety.js";
import { boundText, textResult } from "@kern/protocol";
import { spawnProcess } from "./spawn.js";

export function createMkdirTool(root: string): ToolDefinition<{ path: string; recursive?: boolean }> {
  return {
    name: "mkdir",
    description: "Create directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to create" },
        recursive: { type: "boolean", default: true, description: "Create parent directories" },
      },
      required: ["path"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const target = safeResolveSync(ctx.workspaceRoot, args.path);
      try {
        await mkdir(target, { recursive: args.recursive ?? true });
        return { content: [{ type: "text", text: `Created directory: ${args.path}` }], isError: false, details: { changedPaths: [args.path] } };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createRmTool(root: string): ToolDefinition<{ path: string; recursive?: boolean; force?: boolean }> {
  return {
    name: "rm",
    description: "Remove file or directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to remove" },
        recursive: { type: "boolean", default: false, description: "Remove directories recursively" },
        force: { type: "boolean", default: false, description: "Ignore nonexistent files" },
      },
      required: ["path"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const target = safeResolveSync(ctx.workspaceRoot, args.path);
      try {
        await rm(target, { recursive: args.recursive, force: args.force });
        return { content: [{ type: "text", text: `Removed: ${args.path}` }], isError: false, details: { changedPaths: [args.path] } };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createCatTool(root: string): ToolDefinition<{ path: string }> {
  return {
    name: "cat",
    description: "Read entire file content",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const target = safeResolveSync(ctx.workspaceRoot, args.path);
      try {
        const content = await readFile(target, "utf8");
        return { content: [{ type: "text", text: content }], isError: false };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createHeadTool(root: string): ToolDefinition<{ path: string; lines?: number }> {
  return {
    name: "head",
    description: "Read first N lines of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, default: 10 } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const target = safeResolveSync(ctx.workspaceRoot, args.path);
      try {
        const content = await readFile(target, "utf8");
        const lines = content.split("\n").slice(0, args.lines ?? 10).join("\n");
        return { content: [{ type: "text", text: lines }], isError: false };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createTailTool(root: string): ToolDefinition<{ path: string; lines?: number }> {
  return {
    name: "tail",
    description: "Read last N lines of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, default: 10 } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const target = safeResolveSync(ctx.workspaceRoot, args.path);
      try {
        const content = await readFile(target, "utf8");
        const lines = content.split("\n").slice(-(args.lines ?? 10)).join("\n");
        return { content: [{ type: "text", text: lines }], isError: false };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createWhichTool(root: string): ToolDefinition<{ command: string }> {
  return {
    name: "which",
    description: "Find executable path in PATH",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const { stdout, code } = await spawnProcess("which", [args.command], { cwd: ctx.workspaceRoot, maxBytes: 10000 });
      const path = stdout.trim();
      if (path) return { content: [{ type: "text", text: path }], isError: false };
      return textResult(`Command not found: ${args.command}`, true, { code: "E_TOOL_FAILED" });
    },
  };
}