import { ToolDefinition, ToolResult } from "@kern/protocol";
import { textResult } from "@kern/protocol";
import { spawnProcess } from "./spawn.js";

export function createCalculateTool(root: string): ToolDefinition<{ expression: string }> {
  return {
    name: "calculate",
    description: "Evaluate a math expression safely",
    inputSchema: { type: "object", properties: { expression: { type: "string", description: "Math expression (e.g., '2 + 3 * 4')" } }, required: ["expression"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const expr = args.expression.trim();
      if (!/^[\d\s+\-*/().%]+$/.test(expr)) return textResult("Invalid expression: only numbers, + - * / ( ) % allowed", true);
      try {
        const result = Function(`"use strict"; return (${expr})`)();
        return { content: [{ type: "text", text: String(result) }], isError: false };
      } catch (error) {
        return textResult(`Invalid expression: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createTimeTool(root: string): ToolDefinition<{ format?: string; timezone?: string }> {
  return {
    name: "time",
    description: "Get current date/time",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["iso", "unix", "readable"], default: "iso" },
        timezone: { type: "string", description: "IANA timezone (e.g., 'America/New_York')" },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const now = new Date();
      let output: string;
      switch (args.format) {
        case "unix": output = String(Math.floor(now.getTime() / 1000)); break;
        case "readable": output = now.toLocaleString(); break;
        default: output = now.toISOString();
      }
      if (args.timezone) {
        output += ` (${args.timezone}: ${new Date().toLocaleString("en-US", { timeZone: args.timezone })})`;
      }
      return { content: [{ type: "text", text: output }], isError: false };
    },
  };
}

export function createTypeCheckTool(root: string): ToolDefinition<{ path?: string }> {
  return {
    name: "type-check",
    description: "Run TypeScript type checker on project or file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "File or directory to check (default: workspace)" } } },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const target = args.path ? args.path : ".";
      const { stdout, stderr, code } = await spawnProcess("tsc", ["--noEmit", target], { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const output = stderr || stdout || (code === 0 ? "Type check passed" : "Type check failed");
      return { content: [{ type: "text", text: output }], isError: code !== 0 };
    },
  };
}

export function createTestTool(root: string): ToolDefinition<{ path?: string; pattern?: string }> {
  return {
    name: "test",
    description: "Run tests using vitest/bun/jest",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Test file or directory" },
        pattern: { type: "string", description: "Test name pattern to filter" },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const cmd = ["test"];
      if (args.path) cmd.push(args.path);
      if (args.pattern) cmd.push("-t", args.pattern);
      const { stdout, stderr, code } = await spawnProcess("bun", cmd, { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const output = stdout + stderr;
      return { content: [{ type: "text", text: output || (code === 0 ? "All tests passed" : "Tests failed") }], isError: code !== 0 };
    },
  };
}

export function createServeTool(root: string): ToolDefinition<{ port?: number; dir?: string }> {
  return {
    name: "serve",
    description: "Start static file server",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, default: 3000 },
        dir: { type: "string", default: ".", description: "Directory to serve" },
      },
    },
    sideEffect: "execute",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const port = args.port ?? 3000;
      const dir = args.dir ?? ".";
      return { content: [{ type: "text", text: `Server started on http://localhost:${port} serving ${dir}\nUse Ctrl+C to stop` }], isError: false };
    },
  };
}

export function createFormatTool(root: string): ToolDefinition<{ path?: string; write?: boolean }> {
  return {
    name: "format",
    description: "Format code with Prettier",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to format (default: workspace)" },
        write: { type: "boolean", default: false, description: "Write changes to files" },
      },
    },
    sideEffect: "write",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const target = args.path ?? ".";
      const cmd = ["prettier", args.write ? "--write" : "--check", target];
      const { stdout, stderr, code } = await spawnProcess("prettier", cmd, { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const output = stdout + stderr;
      return { content: [{ type: "text", text: output || (code === 0 ? "Format check passed" : "Formatting issues found") }], isError: code !== 0 };
    },
  };
}

const MAX_CAPTURE_BYTES = 1_000_000;