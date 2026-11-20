import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonSchema, ToolAnnotations } from "@kern/protocol";
import type { McpPromptInfo, McpResourceInfo, ResolvedMcpServerDef } from "./types.js";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "kern", version: "1.0.0" };

export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface McpContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: {
    uri?: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

export interface McpCallResult {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpResourceReadResult {
  contents?: Array<{
    uri?: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  }>;
}

export interface McpPromptGetResult {
  description?: string;
  messages?: Array<{
    role?: string;
    content?: McpContentItem | McpContentItem[];
  }>;
}

export interface McpServerMeta {
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export type McpListChangedKind = "tools" | "resources" | "prompts";

export interface McpTransportHooks {
  onListChanged?: (kind: McpListChangedKind) => void;
}

export interface McpTransportClient {
  connect(): Promise<McpServerMeta>;
  listTools(): Promise<RawMcpTool[]>;
  listResources(): Promise<McpResourceInfo[]>;
  listPrompts(): Promise<McpPromptInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpResourceReadResult>;
  getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpPromptGetResult>;
  ping(): Promise<boolean>;
  isConnected(): boolean;
  dispose(): Promise<void>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isMethodNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /method not found|-32601|not implemented|unsupported/i.test(msg);
}

function listChangedKindForMethod(method: unknown): McpListChangedKind | null {
  if (method === "notifications/tools/list_changed") return "tools";
  if (method === "notifications/resources/list_changed") return "resources";
  if (method === "notifications/prompts/list_changed") return "prompts";
  return null;
}

function formatHttpAuthError(status: number, context: string, res: Response, errBody: string): Error {
  if (status === 401 || status === 403) {
    const wwwAuth = res.headers?.get?.("www-authenticate")?.trim();
    const hint = `Authentication required (HTTP ${status}) on ${context}. Configure an Authorization Bearer token header via /mcp, \`kern mcp add --header "Authorization=Bearer $TOKEN"\`, or ~/.kern/mcp.json.`;
    const extra = [wwwAuth ? `WWW-Authenticate: ${wwwAuth.slice(0, 160)}` : "", errBody ? errBody.slice(0, 160) : ""]
      .filter(Boolean)
      .join(" | ");
    const err = new Error(extra ? `${hint} (${extra})` : hint);
    (err as { status?: number }).status = status;
    return err;
  }
  const err = new Error(`MCP HTTP ${status} on ${context}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
  (err as { status?: number }).status = status;
  return err;
}

/**
 * Persistent stdio MCP JSON-RPC 2.0 client.
 * Keeps child process alive across calls for stateful servers and disposes cleanly.
 */
export class StdioMcpClient implements McpTransportClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private connected = false;
  private connectPromise: Promise<McpServerMeta> | null = null;
  private serverMeta: McpServerMeta = {};
  private stderrTail = "";
  private exitHandler: (() => void) | null = null;

  constructor(
    private readonly def: ResolvedMcpServerDef,
    private readonly hooks: McpTransportHooks = {},
  ) {}

  isConnected(): boolean {
    return this.connected && this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
  }

  async connect(): Promise<McpServerMeta> {
    if (this.isConnected()) return this.serverMeta;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        await this.spawnProcess();
        const initRes = (await this.rawRequest(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          this.def.timeoutMs,
        )) as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> } | undefined;

        this.rawNotify("notifications/initialized", {});
        this.connected = true;
        this.serverMeta = {
          serverInfo: initRes?.serverInfo,
          capabilities: initRes?.capabilities,
        };
        return this.serverMeta;
      } catch (err) {
        await this.teardownProcess();
        const detail = this.stderrTail.trim();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(detail ? `${msg} (${detail})` : msg);
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private async spawnProcess(): Promise<void> {
    await this.teardownProcess();
    this.stderrTail = "";

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.def.env ?? {}),
    };

    const proc = this.def.shellCommand
      ? spawn("sh", ["-c", this.def.shellCommand], {
          cwd: this.def.cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(this.def.command!, this.def.args ?? [], {
          cwd: this.def.cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail += chunk.toString("utf8");
      if (this.stderrTail.length > 4096) {
        this.stderrTail = this.stderrTail.slice(-4096);
      }
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    proc.on("error", (err) => {
      this.connected = false;
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    proc.on("close", (code, sig) => {
      this.connected = false;
      this.proc = null;
      const tail = this.stderrTail.trim();
      const suffix = tail ? `: ${tail.slice(-300)}` : "";
      this.failAll(new Error(`MCP stdio server "${this.def.name}" exited (code=${code ?? "null"}, signal=${sig ?? "none"})${suffix}`));
    });

    this.exitHandler = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    process.once("exit", this.exitHandler);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") {
      const changed = listChangedKindForMethod(msg.method);
      if (changed) this.hooks.onListChanged?.(changed);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(msg.error.message ?? `MCP error (${msg.error.code ?? "unknown"})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private rawNotify(method: string, params?: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
    } catch {
      /* ignore write failures on notifications */
    }
  }

  private rawRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const proc = this.proc;
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      return Promise.reject(new Error(`MCP server "${this.def.name}" is not running`));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error(`MCP request "${method}" aborted`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const cleanupAbort = () => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanupAbort();
        this.rawNotify("notifications/cancelled", { requestId: id, reason: "timeout" });
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const onAbort = signal
        ? () => {
            if (settled) return;
            settled = true;
            this.pending.delete(id);
            clearTimeout(timer);
            cleanupAbort();
            this.rawNotify("notifications/cancelled", { requestId: id, reason: "aborted" });
            reject(new Error(`MCP request aborted: ${method}`));
          }
        : undefined;

      if (signal && onAbort) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (v) => {
          if (settled) return;
          settled = true;
          cleanupAbort();
          resolve(v);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          cleanupAbort();
          reject(e);
        },
        timer,
      });

      proc.stdin!.write(payload, (err) => {
        if (err && !settled) {
          settled = true;
          this.pending.delete(id);
          clearTimeout(timer);
          cleanupAbort();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.isConnected()) {
      await this.connect();
    }
    try {
      return await this.rawRequest(method, params, this.def.timeoutMs, signal);
    } catch (err) {
      // Transparent one-shot reconnect if the child died between calls
      if (!this.isConnected() && !signal?.aborted) {
        await this.connect();
        return await this.rawRequest(method, params, this.def.timeoutMs, signal);
      }
      throw err;
    }
  }

  private async listPaginated(method: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && items.length < 500; page++) {
      const res = (await this.request(method, cursor ? { cursor } : {})) as {
        [k: string]: unknown;
        nextCursor?: unknown;
      };
      const chunk = res?.[key];
      if (Array.isArray(chunk)) items.push(...chunk.slice(0, 500 - items.length));
      if (typeof res?.nextCursor === "string" && res.nextCursor.length > 0) cursor = res.nextCursor;
      else break;
    }
    return items;
  }

  async listTools(): Promise<RawMcpTool[]> {
    const list = await this.listPaginated("tools/list", "tools");
    return (list as RawMcpTool[]).filter((t) => typeof t?.name === "string" && t.name.length > 0);
  }

  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const list = await this.listPaginated("resources/list", "resources");
      return (list as Array<{ uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown }>)
        .filter((r) => typeof r?.uri === "string" && r.uri.length > 0)
        .map((r) => ({
          uri: String(r.uri),
          name: typeof r.name === "string" && r.name ? r.name : String(r.uri),
          ...(typeof r.description === "string" ? { description: r.description } : {}),
          ...(typeof r.mimeType === "string" ? { mimeType: r.mimeType } : {}),
        }));
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      throw err;
    }
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const list = await this.listPaginated("prompts/list", "prompts");
      return (list as McpPromptInfo[]).filter((p) => typeof p?.name === "string" && p.name.length > 0);
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args ?? {} }, signal)) as McpCallResult;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceReadResult> {
    return (await this.request("resources/read", { uri }, signal)) as McpResourceReadResult;
  }

  async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpPromptGetResult> {
    return (await this.request("prompts/get", { name, arguments: args ?? {} }, signal)) as McpPromptGetResult;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  private async teardownProcess(): Promise<void> {
    if (this.exitHandler) {
      process.off("exit", this.exitHandler);
      this.exitHandler = null;
    }
    const proc = this.proc;
    this.proc = null;
    this.connected = false;
    this.failAll(new Error("MCP client disposed"));
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    await Promise.race([
      new Promise<void>((r) => proc.once("close", () => r())),
      new Promise<void>((r) => setTimeout(r, 350)),
    ]);
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }

  async dispose(): Promise<void> {
    await this.teardownProcess();
  }
}

/** Parse SSE response payload for a JSON-RPC message matching `expectedId` (or the last JSON-RPC response). */
function parseSseJsonRpc(body: string, expectedId: number): { result?: unknown; error?: { message?: string; code?: number } } {
  const normalized = body.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  let lastValid: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } } | null = null;
  for (const block of blocks) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n").trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const msg = JSON.parse(raw) as { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      if (msg.id === expectedId) return msg;
      if ("result" in msg || "error" in msg) lastValid = msg;
    } catch {
      /* ignore non-JSON keepalive / comments */
    }
  }
  if (lastValid) return lastValid;
  throw new Error("No JSON-RPC response in MCP SSE body");
}

function parseHttpJsonOrSse(
  body: string,
  expectedId: number,
): { result?: unknown; error?: { message?: string; code?: number } } {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Empty MCP HTTP response");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const match = (parsed as Array<{ id?: unknown; result?: unknown; error?: { message?: string; code?: number } }>)
        .find((m) => m.id === expectedId);
      return match ?? (parsed[0] as { result?: unknown; error?: { message?: string; code?: number } }) ?? {};
    }
    return parsed as { result?: unknown; error?: { message?: string; code?: number } };
  }
  return parseSseJsonRpc(trimmed, expectedId);
}

/**
 * MCP HTTP Client supporting both:
 * 1. Streamable HTTP (POST JSON-RPC + Mcp-Session-Id header + JSON or SSE response body)
 * 2. Legacy HTTP+SSE (GET stream emitting `event: endpoint`, POST requests, responses over SSE stream)
 */
export class HttpMcpClient implements McpTransportClient {
  private nextId = 1;
  private connected = false;
  private connectPromise: Promise<McpServerMeta> | null = null;
  private serverMeta: McpServerMeta = {};
  private sessionId: string | null = null;

  // Legacy SSE transport state
  private sseEndpointUrl: string | null = null;
  private sseAbort: AbortController | null = null;
  private ssePending = new Map<number, PendingRpc>();

  constructor(
    private readonly def: ResolvedMcpServerDef,
    private readonly hooks: McpTransportHooks = {},
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.def.headers ?? {}),
      ...extra,
    };
  }

  async connect(): Promise<McpServerMeta> {
    if (this.connected) return this.serverMeta;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        if (this.def.transport === "sse") {
          await this.connectLegacySse();
        } else {
          await this.connectStreamableHttp();
        }
        return this.serverMeta;
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private async connectStreamableHttp(): Promise<void> {
    const res = await this.rawStreamableRpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      this.def.timeoutMs,
    );
    const meta = (res ?? {}) as McpServerMeta;
    this.serverMeta = { serverInfo: meta.serverInfo, capabilities: meta.capabilities };
    this.connected = true;
    await this.rawStreamableNotify("notifications/initialized", {}).catch(() => {});
  }

  private async connectLegacySse(): Promise<void> {
    await this.closeLegacySse();
    const ctrl = new AbortController();
    this.sseAbort = ctrl;

    const timeoutTimer = setTimeout(() => ctrl.abort(), this.def.timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

    const response = await fetch(this.def.url!, {
      method: "GET",
      headers: this.baseHeaders({ Accept: "text/event-stream" }),
      signal: ctrl.signal,
    });
    if (!response.ok || !response.body) {
      clearTimeout(timeoutTimer);
      const errBody = await response.text().catch(() => "");
      throw formatHttpAuthError(response.status, "SSE connect", response, errBody);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let endpointResolved = false;

    let resolveEndpoint!: (url: string) => void;
    let rejectEndpoint!: (err: Error) => void;
    const endpointPromise = new Promise<string>((res, rej) => {
      resolveEndpoint = res;
      rejectEndpoint = rej;
    });

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            this.handleSseEvent(rawEvent, (url) => {
              if (!endpointResolved) {
                endpointResolved = true;
                clearTimeout(timeoutTimer);
                resolveEndpoint(url);
              }
            });
          }
        }
        const err = new Error("MCP SSE stream closed");
        if (!endpointResolved) rejectEndpoint(err);
        this.failSsePending(err);
        this.connected = false;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!endpointResolved) rejectEndpoint(e);
        this.failSsePending(e);
        this.connected = false;
      } finally {
        clearTimeout(timeoutTimer);
      }
    };
    void pump();

    this.sseEndpointUrl = await endpointPromise;
    const initRes = (await this.rawLegacySseRpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      this.def.timeoutMs,
    )) as McpServerMeta | undefined;
    this.serverMeta = { serverInfo: initRes?.serverInfo, capabilities: initRes?.capabilities };
    this.connected = true;
    await this.rawLegacySseNotify("notifications/initialized", {}).catch(() => {});
  }

  private handleSseEvent(rawEvent: string, onEndpoint: (url: string) => void): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (!data) return;

    if (eventName === "endpoint") {
      try {
        onEndpoint(new URL(data, this.def.url!).toString());
      } catch {
        onEndpoint(data);
      }
      return;
    }

    try {
      const msg = JSON.parse(data) as { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      if (typeof msg.id !== "number") {
        const changed = listChangedKindForMethod(msg.method);
        if (changed) this.hooks.onListChanged?.(changed);
        return;
      }
      const pending = this.ssePending.get(msg.id);
      if (!pending) return;
      this.ssePending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? `MCP error (${msg.error.code ?? "unknown"})`));
      else pending.resolve(msg.result);
    } catch {
      /* ignore non-JSON SSE data */
    }
  }

  private failSsePending(err: Error): void {
    for (const [, p] of this.ssePending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.ssePending.clear();
  }

  private async closeLegacySse(): Promise<void> {
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    this.sseEndpointUrl = null;
    this.failSsePending(new Error("MCP SSE client closed"));
  }

  private async rawLegacySseNotify(method: string, params: unknown): Promise<void> {
    if (!this.sseEndpointUrl) return;
    await fetch(this.sseEndpointUrl, {
      method: "POST",
      headers: this.baseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
    });
  }

  private rawLegacySseRpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.sseEndpointUrl) {
      return Promise.reject(new Error("MCP SSE endpoint not established"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePending.delete(id);
        reject(new Error(`MCP SSE request timed out: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const onAbort = () => {
        this.ssePending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP SSE request aborted: ${method}`));
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error(`MCP SSE request aborted: ${method}`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      this.ssePending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });

      fetch(this.sseEndpointUrl!, {
        method: "POST",
        headers: this.baseHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const pending = this.ssePending.get(id);
            if (pending) {
              this.ssePending.delete(id);
              clearTimeout(pending.timer);
              pending.reject(new Error(`MCP SSE POST HTTP ${res.status} on ${method}`));
            }
            return;
          }
          // Some SSE servers return JSON directly in POST body rather than on GET stream
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) {
            const text = await res.text();
            if (text.trim()) {
              const parsed = parseHttpJsonOrSse(text, id);
              const pending = this.ssePending.get(id);
              if (pending) {
                this.ssePending.delete(id);
                clearTimeout(pending.timer);
                if (parsed.error) pending.reject(new Error(parsed.error.message ?? `MCP ${method} error`));
                else pending.resolve(parsed.result);
              }
            }
          }
        })
        .catch((err) => {
          const pending = this.ssePending.get(id);
          if (pending) {
            this.ssePending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
    });
  }

  private async rawStreamableNotify(method: string, params: unknown): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetch(this.def.url!, {
        method: "POST",
        headers: this.baseHeaders({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
        body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    } finally {
      clearTimeout(timer);
    }
  }

  private async rawStreamableRpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (signal?.aborted) throw new Error(`MCP request aborted: ${method}`);
    signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    try {
      const res = await fetch(this.def.url!, {
        method: "POST",
        headers: this.baseHeaders({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw formatHttpAuthError(res.status, method, res, errBody);
      }
      const parsed = parseHttpJsonOrSse(await res.text(), id);
      if (parsed.error) throw new Error(parsed.error.message ?? `MCP ${method} error`);
      return parsed.result;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`MCP request timed out: ${method}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }
    if (this.def.transport === "sse") {
      return await this.rawLegacySseRpc(method, params, this.def.timeoutMs, signal);
    }
    try {
      return await this.rawStreamableRpc(method, params, this.def.timeoutMs, signal);
    } catch (err) {
      // If session expired (404), re-initialize once
      const status = (err as { status?: number })?.status;
      if (status === 404 && this.sessionId) {
        this.sessionId = null;
        this.connected = false;
        await this.connect();
        return await this.rawStreamableRpc(method, params, this.def.timeoutMs, signal);
      }
      throw err;
    }
  }

  private async listPaginated(method: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && items.length < 500; page++) {
      const res = (await this.request(method, cursor ? { cursor } : {})) as {
        [k: string]: unknown;
        nextCursor?: unknown;
      };
      const chunk = res?.[key];
      if (Array.isArray(chunk)) items.push(...chunk.slice(0, 500 - items.length));
      if (typeof res?.nextCursor === "string" && res.nextCursor.length > 0) cursor = res.nextCursor;
      else break;
    }
    return items;
  }

  async listTools(): Promise<RawMcpTool[]> {
    const list = await this.listPaginated("tools/list", "tools");
    return (list as RawMcpTool[]).filter((t) => typeof t?.name === "string" && t.name.length > 0);
  }

  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const list = await this.listPaginated("resources/list", "resources");
      return (list as Array<{ uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown }>)
        .filter((r) => typeof r?.uri === "string" && r.uri.length > 0)
        .map((r) => ({
          uri: String(r.uri),
          name: typeof r.name === "string" && r.name ? r.name : String(r.uri),
          ...(typeof r.description === "string" ? { description: r.description } : {}),
          ...(typeof r.mimeType === "string" ? { mimeType: r.mimeType } : {}),
        }));
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      throw err;
    }
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const list = await this.listPaginated("prompts/list", "prompts");
      return (list as McpPromptInfo[]).filter((p) => typeof p?.name === "string" && p.name.length > 0);
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args ?? {} }, signal)) as McpCallResult;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceReadResult> {
    return (await this.request("resources/read", { uri }, signal)) as McpResourceReadResult;
  }

  async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpPromptGetResult> {
    return (await this.request("prompts/get", { name, arguments: args ?? {} }, signal)) as McpPromptGetResult;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    const sid = this.sessionId;
    this.connected = false;
    this.sessionId = null;
    await this.closeLegacySse();
    if (sid && this.def.url && this.def.transport !== "sse") {
      try {
        await fetch(this.def.url, {
          method: "DELETE",
          headers: { ...(this.def.headers ?? {}), "Mcp-Session-Id": sid },
        });
      } catch {
        /* best-effort session teardown */
      }
    }
  }
}

export function createMcpClient(def: ResolvedMcpServerDef, hooks: McpTransportHooks = {}): McpTransportClient {
  return def.transport === "stdio" ? new StdioMcpClient(def, hooks) : new HttpMcpClient(def, hooks);
}
