import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { ToolDefinition, ToolResult, boundText, textResult } from "@kern/protocol";
import { safeResolveSync } from "../../path-safety.js";
import { spawnProcess } from "./spawn.js";

const MAX_CAPTURE_BYTES = 1_000_000;

const activeStaticServers = new Map<string, { server: Server; port: number; dir: string }>();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export function createCalculateTool(_root: string): ToolDefinition<{ expression: string }> {
  return {
    name: "calculate",
    description: "Evaluate a math expression safely",
    inputSchema: { type: "object", properties: { expression: { type: "string", description: "Math expression (e.g., '2 + 3 * 4')" } }, required: ["expression"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args): Promise<ToolResult> {
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

export function createTimeTool(_root: string): ToolDefinition<{ format?: string; timezone?: string }> {
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
    async execute(args): Promise<ToolResult> {
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

export function createTypeCheckTool(_root: string): ToolDefinition<{ path?: string }> {
  return {
    name: "type-check",
    description: "Run TypeScript type checker on project or file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "File or tsconfig to check (default: workspace tsconfig.json)" } } },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const cmdArgs = ["tsc", "--noEmit"];
      if (!args.path || args.path === ".") {
        cmdArgs.push("-p", "tsconfig.json");
      } else {
        let resolved: string;
        try {
          resolved = safeResolveSync(ctx.workspaceRoot, args.path);
        } catch (error) {
          return textResult(String(error), true, { code: "E_TOOL_DENIED" });
        }
        if (resolved.endsWith(".json")) cmdArgs.push("-p", resolved);
        else cmdArgs.push(resolved);
      }
      const { stdout, stderr, code } = await spawnProcess("npx", cmdArgs, { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText(stderr || stdout || (code === 0 ? "Type check passed" : "Type check failed"));
      return { content: [{ type: "text", text: out.text }], isError: code !== 0 };
    },
  };
}

export function createTestTool(_root: string): ToolDefinition<{ path?: string; pattern?: string }> {
  return {
    name: "test",
    description: "Run tests using vitest",
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
      const cmdArgs = ["vitest", "run"];
      if (args.path) {
        try {
          safeResolveSync(ctx.workspaceRoot, args.path);
        } catch (error) {
          return textResult(String(error), true, { code: "E_TOOL_DENIED" });
        }
        cmdArgs.push(args.path);
      }
      if (args.pattern) cmdArgs.push("-t", args.pattern);
      const { stdout, stderr, code } = await spawnProcess("npx", cmdArgs, { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText([stdout, stderr].filter(Boolean).join("\n"));
      return { content: [{ type: "text", text: out.text || (code === 0 ? "All tests passed" : "Tests failed") }], isError: code !== 0 };
    },
  };
}

export function createServeTool(_root: string): ToolDefinition<{ action?: "start" | "stop" | "status"; port?: number; dir?: string }> {
  return {
    name: "serve",
    description: "Manage a local loopback static file server for the workspace",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"], default: "start" },
        port: { type: "integer", minimum: 0, maximum: 65535, default: 0, description: "Port to bind on 127.0.0.1 (0 = ephemeral)" },
        dir: { type: "string", default: ".", description: "Directory to serve inside workspace" },
      },
    },
    sideEffect: "execute",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const action = args.action ?? "start";
      const key = ctx.workspaceRoot;

      if (action === "status") {
        const running = activeStaticServers.get(key);
        if (!running) return textResult("No active static server for this workspace.");
        return textResult(`Static server running on http://127.0.0.1:${running.port} serving ${running.dir}`);
      }

      if (action === "stop") {
        const running = activeStaticServers.get(key);
        if (!running) return textResult("No active static server to stop.");
        await new Promise<void>((res) => running.server.close(() => res()));
        activeStaticServers.delete(key);
        return textResult(`Stopped static server on port ${running.port}`);
      }

      let serveDir: string;
      try {
        serveDir = safeResolveSync(ctx.workspaceRoot, args.dir ?? ".");
        const st = await stat(serveDir);
        if (!st.isDirectory()) return textResult(`Not a directory: ${args.dir ?? "."}`, true, { code: "E_TOOL_INVALID_ARGS" });
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }

      const existing = activeStaticServers.get(key);
      if (existing) {
        await new Promise<void>((res) => existing.server.close(() => res()));
        activeStaticServers.delete(key);
      }

      const requestedPort = args.port ?? 0;
      try {
        const server = createServer(async (req, res) => {
          const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0] || "/");
          const relPath = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
          let filePath: string;
          try {
            filePath = safeResolveSync(serveDir, relPath);
          } catch {
            res.writeHead(403, { "content-type": "text/plain" });
            res.end("Forbidden");
            return;
          }
          try {
            const st = await stat(filePath);
            if (st.isDirectory()) {
              filePath = safeResolveSync(filePath, "index.html");
            }
            const body = await readFile(filePath);
            const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
            res.writeHead(200, { "content-type": mime });
            res.end(body);
          } catch {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found");
          }
        });

        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(requestedPort, "127.0.0.1", () => {
            server.off("error", rejectListen);
            resolveListen();
          });
        });
        server.unref();

        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
        activeStaticServers.set(key, { server, port: actualPort, dir: serveDir });
        return {
          content: [{ type: "text", text: `Static server started on http://127.0.0.1:${actualPort} serving ${args.dir ?? "."}` }],
          isError: false,
          details: { port: actualPort, host: "127.0.0.1", dir: serveDir },
        };
      } catch (error) {
        return textResult(`Failed to start static server: ${error instanceof Error ? error.message : String(error)}`, true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createFormatTool(_root: string): ToolDefinition<{ path?: string; write?: boolean }> {
  return {
    name: "format",
    description: "Check or format code with Prettier",
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
      let target = ".";
      if (args.path) {
        try {
          safeResolveSync(ctx.workspaceRoot, args.path);
          target = args.path;
        } catch (error) {
          return textResult(String(error), true, { code: "E_TOOL_DENIED" });
        }
      }
      const cmdArgs = ["prettier", args.write ? "--write" : "--check", target];
      const { stdout, stderr, code } = await spawnProcess("npx", cmdArgs, { cwd: ctx.workspaceRoot, maxBytes: MAX_CAPTURE_BYTES });
      const out = boundText([stdout, stderr].filter(Boolean).join("\n"));
      return { content: [{ type: "text", text: out.text || (code === 0 ? "Format check passed" : "Formatting issues found") }], isError: code !== 0 };
    },
  };
}