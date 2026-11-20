import { describe, expect, it, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, ToolDefinition } from "@kern/protocol";
import {
  CONNECTOR_PRESETS,
  ConnectManager,
  expandEnvString,
  findConnectorPreset,
  loadMcpConfigs,
  makeMcpToolName,
  removeMcpServerConfig,
  saveMcpServerConfig,
  type ToolRegistryLike,
} from "../src/index.js";

function makeToolCtx(dir: string, signal = new AbortController().signal): ToolContext {
  return { cwd: dir, workspaceRoot: dir, signal, emitProgress: () => {} };
}

function makeTestRegistry(): ToolRegistryLike & { map: Map<string, ToolDefinition> } {
  const map = new Map<string, ToolDefinition>();
  return {
    map,
    register(tool: ToolDefinition) {
      map.set(tool.name, tool);
    },
    unregister(name: string) {
      map.delete(name);
    },
    has(name: string) {
      return map.has(name);
    },
    toolNames() {
      return [...map.keys()];
    },
  };
}

/** Inline Node MCP stdio server implementing initialize, paginated tools/list, stateful tools/call, resources, and prompts. */
const STDIO_MCP_SCRIPT = `
const readline = require("node:readline");
let counter = 0;
const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "test-stdio-mcp", version: "1.2.3" },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
  }
  if (msg.method === "ping") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "tools/list") {
    const cursor = msg.params && msg.params.cursor;
    if (!cursor) {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "bump_counter",
              description: "Increment stateful counter",
              inputSchema: {
                type: "object",
                properties: { step: { type: "number" } },
              },
              annotations: { readOnlyHint: true },
            },
          ],
          nextCursor: "page2",
        },
      });
    }
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "emit_secret",
            description: "Mutating write operation returning secret",
            inputSchema: { type: "object", properties: {} },
            annotations: { destructiveHint: true },
          },
          {
            name: "slow_op",
            description: "Slow cancellable operation",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === "bump_counter") {
      counter += Number(args.step ?? 1);
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "counter=" + counter + " pid=" + process.pid }], isError: false },
      });
    }
    if (name === "emit_secret") {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "api_key: sk-secretvalue1234567890" }], isError: false },
      });
    }
    if (name === "slow_op") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slow done" }] } });
      }, 4000);
      return;
    }
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown tool: " + name } });
  }
  if (msg.method === "resources/list") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { resources: [{ uri: "mem://greeting", name: "greeting", description: "Greeting doc", mimeType: "text/plain" }] },
    });
  }
  if (msg.method === "resources/read") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: "hello from mcp resource" }] },
    });
  }
  if (msg.method === "prompts/list") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { prompts: [{ name: "review", description: "Code review template" }] },
    });
  }
  if (msg.method === "prompts/get") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        description: "Review",
        messages: [{ role: "user", content: { type: "text", text: "Review target: " + (msg.params.arguments?.target || "all") } }],
      },
    });
  }
  return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
});
`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

describe("@kern/connects", () => {
  const cleanupDirs: string[] = [];
  const managers: ConnectManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      const m = managers.pop();
      if (m) await m.dispose().catch(() => {});
    }
    while (cleanupDirs.length > 0) {
      const d = cleanupDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function makeTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "kern-connects-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("exposes curated connector presets and safe bounded tool names", () => {
    expect(CONNECTOR_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(findConnectorPreset("context7")?.transport).toBe("http");
    expect(findConnectorPreset("github")?.transport).toBe("stdio");

    const name = makeMcpToolName("my.server", "weird/tool name");
    expect(name).toBe("mcp__my_server__weird_tool_name");
    const longName = makeMcpToolName("very_long_server_identifier_name", "very_long_remote_tool_identifier_name_here");
    expect(longName.length).toBeLessThanOrEqual(64);
    expect(longName).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("expands env vars cleanly and enforces fail-closed project stdio trust", async () => {
    const dir = makeTmp();
    const userPath = join(dir, "user-mcp.json");
    const trustPath = join(dir, "trust.json");
    const projectDir = join(dir, "proj");
    mkdirSync(projectDir, { recursive: true });

    const exp = expandEnvString("Bearer ${API_TOKEN:-fallback} $MISSING_VAR", { API_TOKEN: "tok123" });
    expect(exp.value).toBe("Bearer tok123 ");
    expect(exp.missing).toEqual(["MISSING_VAR"]);

    await saveMcpServerConfig("user", projectDir, "remote-doc", {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${TOK}" },
    }, { userConfigPath: userPath });

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "untrusted-local": { command: process.execPath, args: ["-e", STDIO_MCP_SCRIPT] },
        },
      }),
    );

    const loaded = await loadMcpConfigs(projectDir, {
      userConfigPath: userPath,
      trustFilePath: trustPath,
      envSource: { TOK: "abc" },
    });
    const remote = loaded.defs.find((d) => d.name === "remote-doc");
    const projStdio = loaded.defs.find((d) => d.name === "untrusted-local");
    expect(remote?.trusted).toBe(true);
    expect(remote?.headers?.Authorization).toBe("Bearer abc");
    expect(projStdio?.trusted).toBe(false);
    expect(loaded.warnings.some((w) => w.includes("untrusted-local"))).toBe(true);

    const mgr = new ConnectManager({ cwd: projectDir, userConfigPath: userPath, trustFilePath: trustPath });
    managers.push(mgr);
    const reg = makeTestRegistry();
    mgr.bindRegistry(reg);

    await mgr.discoverAndConnect();
    expect(mgr.getServerStatus("untrusted-local")?.state).toBe("untrusted");
    expect(reg.has("mcp__untrusted-local__bump_counter")).toBe(false);

    // Explicitly trusting project server connects it and registers tools live
    const trustedStatus = await mgr.trustServer("untrusted-local");
    expect(trustedStatus.state).toBe("connected");
    expect(reg.has("mcp__untrusted-local__bump_counter")).toBe(true);

    // Removing deletes from file and unregisters tools
    await mgr.removeServer("untrusted-local", { scope: "project" });
    expect(reg.has("mcp__untrusted-local__bump_counter")).toBe(false);
    const afterProj = JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(afterProj.mcpServers["untrusted-local"]).toBeUndefined();

    expect(await removeMcpServerConfig("user", projectDir, "remote-doc", { userConfigPath: userPath })).toBe(true);
  });

  it("runs full persistent stdio MCP lifecycle (pagination, stateful calls, resources, prompts, redaction, abort, dispose)", async () => {
    const dir = makeTmp();
    const userPath = join(dir, "mcp.json");
    const trustPath = join(dir, "trust.json");
    const mgr = new ConnectManager({ cwd: dir, userConfigPath: userPath, trustFilePath: trustPath });
    managers.push(mgr);
    const reg = makeTestRegistry();
    mgr.bindRegistry(reg);

    const status = await mgr.addServer(
      "local",
      { command: process.execPath, args: ["-e", STDIO_MCP_SCRIPT], timeoutMs: 5000 },
      { scope: "user" },
    );

    expect(status.state).toBe("connected");
    expect(status.serverInfo?.name).toBe("test-stdio-mcp");
    expect(status.tools.map((t) => t.registeredName)).toEqual([
      "mcp__local__bump_counter",
      "mcp__local__emit_secret",
      "mcp__local__slow_op",
    ]);
    expect(status.resources).toHaveLength(1);
    expect(status.prompts).toHaveLength(1);

    // Registry checks including annotations -> sideEffect mapping
    const bumpTool = reg.map.get("mcp__local__bump_counter")!;
    const secretTool = reg.map.get("mcp__local__emit_secret")!;
    expect(bumpTool.sideEffect).toBe("read");
    expect(bumpTool.allowRepeatedCalls).toBe(true);
    expect(secretTool.sideEffect).toBe("execute");
    expect(reg.has("mcp_resources")).toBe(true);
    expect(reg.has("mcp_prompts")).toBe(true);

    // Stateful across multiple calls on same child PID
    const ctx = makeToolCtx(dir);
    const r1 = await bumpTool.execute({ step: 2 }, ctx);
    const r2 = await bumpTool.execute({ step: 3 }, ctx);
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(r1.content[0]?.text).toContain("counter=2");
    expect(r2.content[0]?.text).toContain("counter=5");
    // Verify identical child PID across calls
    const pid1 = r1.content[0]?.text.match(/pid=(\d+)/)?.[1];
    const pid2 = r2.content[0]?.text.match(/pid=(\d+)/)?.[1];
    expect(pid1).toBeTruthy();
    expect(pid1).toBe(pid2);

    // Secret redaction on MCP output
    const secretRes = await secretTool.execute({}, ctx);
    expect(secretRes.content[0]?.text).not.toContain("sk-secretvalue1234567890");
    expect(secretRes.content[0]?.text).toContain("[REDACTED");

    // Resources + Prompts tools
    const resList = await reg.map.get("mcp_resources")!.execute({ action: "list" }, ctx);
    expect(resList.content[0]?.text).toContain("mem://greeting");
    const resRead = await reg.map.get("mcp_resources")!.execute({ action: "read", server: "local", uri: "mem://greeting" }, ctx);
    expect(resRead.content[0]?.text).toContain("hello from mcp resource");

    const promptGet = await reg.map.get("mcp_prompts")!.execute({ action: "get", server: "local", name: "review", arguments: { target: "main.ts" } }, ctx);
    expect(promptGet.content[0]?.text).toContain("Review target: main.ts");

    // Abort signal cancels slow call promptly
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 50);
    const abortedRes = await reg.map.get("mcp__local__slow_op")!.execute({}, makeToolCtx(dir, abortCtrl.signal));
    expect(abortedRes.isError).toBe(true);
    expect(abortedRes.content[0]?.text).toMatch(/aborted/i);

    // Toggle disabled removes tools cleanly, re-enable restores them
    const disabledStatus = await mgr.toggleServer("local", true);
    expect(disabledStatus.state).toBe("disabled");
    expect(reg.has("mcp__local__bump_counter")).toBe(false);

    const enabledStatus = await mgr.toggleServer("local", false);
    expect(enabledStatus.state).toBe("connected");
    expect(reg.has("mcp__local__bump_counter")).toBe(true);

    // Child process terminates on dispose
    const childPid = Number(pid1);
    await mgr.dispose();
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("connects to Streamable HTTP MCP server (Mcp-Session-Id + SSE response + 404 reinit)", async () => {
    let sessionCounter = 0;
    let currentSessionId = "";
    let expiredOnce = false;

    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const bodyStr = await readBody(req);
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      const msg = JSON.parse(bodyStr) as { id?: number; method: string; params?: { name?: string; arguments?: { msg?: string } } };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        currentSessionId = `sid-${++sessionCounter}`;
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": currentSessionId,
        });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2024-11-05", serverInfo: { name: "http-mcp", version: "1.0" }, capabilities: { tools: {} } },
        }));
        return;
      }
      const reqSid = req.headers["mcp-session-id"];
      if (reqSid !== currentSessionId) {
        res.writeHead(404).end("Unknown session");
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{
              name: "echo_http",
              description: "Echo over Streamable HTTP",
              inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
              annotations: { readOnlyHint: true },
            }],
          },
        }));
        return;
      }
      if (msg.method === "tools/call") {
        // Simulate server restart once -> 404 -> client should automatically re-initialize and retry
        if (!expiredOnce) {
          expiredOnce = true;
          currentSessionId = "expired";
          res.writeHead(404).end("Session expired");
          return;
        }
        // Respond using SSE framing over Streamable HTTP
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `http-echo:${msg.params?.arguments?.msg ?? ""}:${currentSessionId}` }] },
        })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    });

    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const dir = makeTmp();
      const mgr = new ConnectManager({ cwd: dir, userConfigPath: join(dir, "mcp.json"), trustFilePath: join(dir, "trust.json") });
      managers.push(mgr);
      const reg = makeTestRegistry();
      mgr.bindRegistry(reg);

      const status = await mgr.addServer("remotehttp", { type: "http", url: `http://127.0.0.1:${port}/mcp` }, { scope: "memory" });
      expect(status.state).toBe("connected");
      expect(reg.has("mcp__remotehttp__echo_http")).toBe(true);

      const out = await reg.map.get("mcp__remotehttp__echo_http")!.execute(
        { msg: "ping" },
        makeToolCtx(dir),
      );
      expect(out.isError).toBe(false);
      expect(out.content[0]?.text).toBe("http-echo:ping:sid-2");
    } finally {
      srv.close();
    }
  });

  it("connects to Legacy HTTP+SSE MCP server (GET event:endpoint + POST)", async () => {
    const sseStreams: ServerResponse[] = [];
    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseStreams.push(res);
        res.write(`event: endpoint\ndata: /messages\n\n`);
        return;
      }
      if (req.method === "POST" && url === "/messages") {
        const msg = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { arguments?: { x?: number } } };
        res.writeHead(202).end("accepted");
        const stream = sseStreams[sseStreams.length - 1];
        if (msg.id === undefined || !stream) return;
        let result: unknown = {};
        if (msg.method === "initialize") {
          result = { protocolVersion: "2024-11-05", serverInfo: { name: "legacy-sse-mcp" }, capabilities: { tools: {} } };
        } else if (msg.method === "tools/list") {
          result = { tools: [{ name: "double", description: "Double x", inputSchema: { type: "object", properties: { x: { type: "number" } } } }] };
        } else if (msg.method === "tools/call") {
          result = { content: [{ type: "text", text: String(Number(msg.params?.arguments?.x ?? 0) * 2) }] };
        }
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const dir = makeTmp();
      const mgr = new ConnectManager({ cwd: dir, userConfigPath: join(dir, "mcp.json"), trustFilePath: join(dir, "trust.json") });
      managers.push(mgr);
      const reg = makeTestRegistry();
      mgr.bindRegistry(reg);

      const status = await mgr.addServer("legacysse", { type: "sse", url: `http://127.0.0.1:${port}/sse` }, { scope: "memory" });
      expect(status.state).toBe("connected");
      expect(reg.has("mcp__legacysse__double")).toBe(true);

      const out = await reg.map.get("mcp__legacysse__double")!.execute(
        { x: 21 },
        makeToolCtx(dir),
      );
      expect(out.isError).toBe(false);
      expect(out.content[0]?.text).toBe("42");
    } finally {
      for (const s of sseStreams) s.end();
      srv.close();
    }
  });

  it("supports deferred MCP servers with mcp_tool_search on-demand activation", async () => {
    const dir = makeTmp();
    const mgr = new ConnectManager({ cwd: dir, userConfigPath: join(dir, "mcp.json"), trustFilePath: join(dir, "trust.json") });
    managers.push(mgr);
    const { ToolRegistry, AllowAllPolicy } = await import("../../tools/src/index.js");
    const reg = new ToolRegistry({ workspaceRoot: dir, policy: new AllowAllPolicy() });
    mgr.bindRegistry(reg);

    const status = await mgr.addServer(
      "lazysrv",
      { command: process.execPath, args: ["-e", STDIO_MCP_SCRIPT], deferred: true, timeoutMs: 5000 },
      { scope: "user" },
    );
    expect(status.state).toBe("connected");
    expect(status.deferred).toBe(true);
    // Deferred tools should be registered but withheld from listModelSchemas until searched
    expect(reg.has("mcp__lazysrv__bump_counter")).toBe(true);
    expect(reg.has("mcp_tool_search")).toBe(true);
    const initialSchemas = reg.listModelSchemas().map((t) => t.name);
    expect(initialSchemas).toContain("mcp_tool_search");
    expect(initialSchemas).not.toContain("mcp__lazysrv__bump_counter");
    expect(initialSchemas).not.toContain("mcp__lazysrv__slow_op");

    const searchRes = await reg.callTool("mcp_tool_search", { query: "bump" });
    expect(searchRes.isError).toBe(false);
    expect(searchRes.content[0]?.text).toContain("mcp__lazysrv__bump_counter");
    expect(searchRes.content[0]?.text).toContain("Activated 1 tool");

    const afterSchemas = reg.listModelSchemas().map((t) => t.name);
    expect(afterSchemas).toContain("mcp__lazysrv__bump_counter");
    expect(afterSchemas).not.toContain("mcp__lazysrv__slow_op");

    // Re-toggling/removing resets deferred activation state via ToolRegistry.unregister
    await mgr.removeServer("lazysrv");
    expect(reg.has("mcp__lazysrv__bump_counter")).toBe(false);
    expect(reg.has("mcp_tool_search")).toBe(false);
  });

  it("refreshes tools live when stdio server sends notifications/tools/list_changed", async () => {
    const dynamicScript = `
      const readline = require("node:readline");
      let unlocked = false;
      const rl = readline.createInterface({ input: process.stdin });
      function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
          return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "dyn" }, capabilities: { tools: { listChanged: true } } } });
        }
        if (msg.method === "tools/list") {
          const tools = [{ name: "unlock", inputSchema: { type: "object", properties: {} } }];
          if (unlocked) tools.push({ name: "dynamic_tool", description: "Added dynamically", inputSchema: { type: "object", properties: {} } });
          return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
        }
        if (msg.method === "tools/call" && msg.params?.name === "unlock") {
          unlocked = true;
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "unlocked" }] } });
          setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} }), 20);
          return;
        }
        return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "dyn-ok" }] } });
      });
    `;

    const dir = makeTmp();
    const mgr = new ConnectManager({ cwd: dir, userConfigPath: join(dir, "mcp.json"), trustFilePath: join(dir, "trust.json") });
    managers.push(mgr);
    const reg = makeTestRegistry();
    mgr.bindRegistry(reg);

    await mgr.addServer("dyn", { command: process.execPath, args: ["-e", dynamicScript], timeoutMs: 5000 }, { scope: "memory" });
    expect(reg.has("mcp__dyn__unlock")).toBe(true);
    expect(reg.has("mcp__dyn__dynamic_tool")).toBe(false);

    await reg.map.get("mcp__dyn__unlock")!.execute({}, makeToolCtx(dir));
    for (let i = 0; i < 30 && !reg.has("mcp__dyn__dynamic_tool"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(reg.has("mcp__dyn__dynamic_tool")).toBe(true);
  });

  it("surfaces actionable auth hints on HTTP 401 and expands KERN_MCP_COMMAND", async () => {
    const srv = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end("Unauthorized");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const dir = makeTmp();
      const mgr = new ConnectManager({ cwd: dir, userConfigPath: join(dir, "mcp.json"), trustFilePath: join(dir, "trust.json") });
      managers.push(mgr);
      const status = await mgr.addServer("authed", { type: "http", url: `http://127.0.0.1:${port}/mcp` }, { scope: "memory" });
      expect(status.state).toBe("error");
      expect(status.error).toContain("HTTP 401");
      expect(status.error).toContain("Authorization Bearer");
      expect(status.error).toContain("WWW-Authenticate");

      const loaded = await loadMcpConfigs(dir, {
        userConfigPath: join(dir, "missing.json"),
        trustFilePath: join(dir, "trust.json"),
        envSource: { KERN_MCP_COMMAND: "echo ${MCP_ARG:-ok}", MCP_ARG: "expanded" },
      });
      expect(loaded.defs.find((d) => d.name === "env")?.shellCommand).toBe("echo expanded");
    } finally {
      srv.close();
    }
  });

  it("rejects dot and traversal server names in loadMcpConfigs and saveMcpServerConfig", async () => {
    const dir = makeTmp();
    const userPath = join(dir, "mcp.json");
    const trustPath = join(dir, "trust.json");
    for (const badName of [".", "..", ".hidden", "../escape"]) {
      await expect(
        saveMcpServerConfig("user", dir, badName, { url: "https://example.com/mcp" }, { userConfigPath: userPath }),
      ).rejects.toThrow(/Invalid server name/i);
    }

    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ".": { url: "https://example.com/a" },
          "..": { url: "https://example.com/b" },
          "valid-srv": { url: "https://example.com/c" },
        },
      }),
    );

    const loaded = await loadMcpConfigs(dir, { userConfigPath: userPath, trustFilePath: trustPath });
    expect(loaded.defs.map((d) => d.name)).toEqual(["valid-srv"]);
    expect(loaded.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
