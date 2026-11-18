import { ToolDefinition, ToolResult, boundText, textResult } from "@kern/protocol";
import { stat, mkdir, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { safeResolveSync } from "../../path-safety.js";
import { spawnProcess } from "./spawn.js";

const MAX_READ_BYTES = 2_000_000;

export function createMkdirTool(_root: string): ToolDefinition<{ path: string; recursive?: boolean }> {
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
      let target: string;
      try {
        target = safeResolveSync(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      try {
        await mkdir(target, { recursive: args.recursive ?? true });
        return { content: [{ type: "text", text: `Created directory: ${args.path}` }], isError: false, details: { changedPaths: [args.path] } };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createRmTool(_root: string): ToolDefinition<{ path: string; recursive?: boolean; force?: boolean }> {
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
      let target: string;
      try {
        target = safeResolveSync(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      const rootReal = safeResolveSync(ctx.workspaceRoot, ".");
      if (resolve(target) === resolve(rootReal)) {
        return textResult("Refusing to remove the workspace root directory", true, { code: "E_TOOL_DENIED" });
      }
      try {
        await rm(target, { recursive: args.recursive, force: args.force });
        return { content: [{ type: "text", text: `Removed: ${args.path}` }], isError: false, details: { changedPaths: [args.path] } };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

async function readSafeTextFile(workspaceRoot: string, pathArg: string): Promise<{ ok: true; content: string; size: number } | { ok: false; result: ToolResult }> {
  let target: string;
  try {
    target = safeResolveSync(workspaceRoot, pathArg);
  } catch (error) {
    return { ok: false, result: textResult(String(error), true, { code: "E_TOOL_DENIED" }) };
  }
  try {
    const st = await stat(target);
    if (st.isDirectory()) {
      return { ok: false, result: textResult(`Path is a directory: ${pathArg}`, true, { code: "E_TOOL_FAILED" }) };
    }
    if (st.size > MAX_READ_BYTES) {
      return { ok: false, result: textResult(`File too large (${st.size} bytes, cap 2 MB).`, true, { code: "E_TOOL_FAILED" }) };
    }
    const content = await readFile(target, "utf8");
    if (content.includes("\0")) {
      return {
        ok: false,
        result: {
          content: [{ type: "text", text: `Binary file (${st.size} bytes). Refusing to inject into context.` }],
          isError: false,
          details: { binary: true, size: st.size },
        },
      };
    }
    return { ok: true, content, size: st.size };
  } catch (error) {
    return { ok: false, result: textResult(String(error), true, { code: "E_TOOL_FAILED" }) };
  }
}

export function createCatTool(_root: string): ToolDefinition<{ path: string }> {
  return {
    name: "cat",
    description: "Read entire file content (bounded)",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const res = await readSafeTextFile(ctx.workspaceRoot, args.path);
      if (!res.ok) return res.result;
      const bounded = boundText(res.content);
      return {
        content: [{ type: "text", text: bounded.text }],
        isError: false,
        details: bounded.truncated ? { truncated: true } : undefined,
      };
    },
  };
}

export function createHeadTool(_root: string): ToolDefinition<{ path: string; lines?: number }> {
  return {
    name: "head",
    description: "Read first N lines of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, default: 10 } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const res = await readSafeTextFile(ctx.workspaceRoot, args.path);
      if (!res.ok) return res.result;
      const n = Math.max(1, Math.min(2000, args.lines ?? 10));
      const bounded = boundText(res.content.split("\n").slice(0, n).join("\n"));
      return {
        content: [{ type: "text", text: bounded.text }],
        isError: false,
        details: bounded.truncated ? { truncated: true } : undefined,
      };
    },
  };
}

export function createTailTool(_root: string): ToolDefinition<{ path: string; lines?: number }> {
  return {
    name: "tail",
    description: "Read last N lines of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, default: 10 } }, required: ["path"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const res = await readSafeTextFile(ctx.workspaceRoot, args.path);
      if (!res.ok) return res.result;
      const n = Math.max(1, Math.min(2000, args.lines ?? 10));
      const bounded = boundText(res.content.split("\n").slice(-n).join("\n"));
      return {
        content: [{ type: "text", text: bounded.text }],
        isError: false,
        details: bounded.truncated ? { truncated: true } : undefined,
      };
    },
  };
}

export function createWhichTool(_root: string): ToolDefinition<{ command: string }> {
  return {
    name: "which",
    description: "Find executable path in PATH",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const { stdout } = await spawnProcess("which", [args.command], { cwd: ctx.workspaceRoot, maxBytes: 10000 });
      const resolvedPath = stdout.trim();
      if (resolvedPath) return { content: [{ type: "text", text: resolvedPath }], isError: false };
      return textResult(`Command not found: ${args.command}`, true, { code: "E_TOOL_FAILED" });
    },
  };
}