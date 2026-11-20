import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  CONNECTOR_PRESETS,
  SUBAGENT_FORMAT_GUIDE,
  SUBAGENT_PRESETS,
  parseSubagentFile,
  renderSubagentTemplate,
  type AgentSession,
  type McpServerConfigEntry,
  type SubagentConfigEntry,
  type SubagentFileFormat,
} from "./packages/coding-agent/src/index.js";
import type { SessionManager } from "./packages/session-store/src/index.js";
import { createLogger, type AgentEvent, type ThinkingLevel } from "./packages/protocol/src/index.js";
import {
  PROVIDER_PRESETS,
  clearAuthKey,
  createAdapterFor,
  createModelRuntime,
  createOpenAIAdapter,
  discoverModels,
  loadAuth,
  loadModelsFile,
  maskKey,
  resolveFallbackAdapters,
  saveAuthKey,
  saveProviderToUserFile,
  type ModelsFile,
  type ProviderConfig,
} from "./packages/model/src/index.js";

function resolveListenPort(): number {
  const explicit = process.env["KERN_PORT"];
  if (explicit) return Number(explicit);
  const envPort = process.env["PORT"];
  const nginxPort = process.env["NGINX_PORT"];
  if (envPort && nginxPort && envPort === nginxPort) {
    return Number(process.env["DEFAULT_APP_PORT"] ?? 3000);
  }
  return Number(envPort ?? process.env["DEFAULT_APP_PORT"] ?? 3000);
}

const PORT = resolveListenPort();
const HOST = "0.0.0.0";
const WORKSPACE_CWD = process.cwd();
const logger = createLogger(process.env["KERN_LOG"] === "debug" ? "debug" : "warn");

interface PendingApproval {
  id: string;
  prompt: string;
  toolName?: string;
  resolve: (decision: boolean | "session") => void;
  timer: NodeJS.Timeout;
}

const sseClients = new Set<ServerResponse>();
const pendingApprovals = new Map<string, PendingApproval>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function requestWebApproval(
  prompt: string,
  meta?: { toolName?: string },
): Promise<boolean | "session"> {
  if (sseClients.size === 0) {
    // Fail-closed when no interactive web client is connected
    return Promise.resolve(false);
  }
  const id = randomUUID();
  return new Promise<boolean | "session">((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      broadcast("approval_resolved", { id, decision: "deny", reason: "timeout" });
      resolve(false);
    }, 60_000);
    if (typeof timer.unref === "function") timer.unref();

    pendingApprovals.set(id, {
      id,
      prompt,
      toolName: meta?.toolName,
      resolve,
      timer,
    });
    broadcast("approval_request", {
      id,
      prompt,
      toolName: meta?.toolName ?? "tool",
    });
  });
}

let activeSession: AgentSession;
let activeManager: SessionManager;
let unsubscribeSession: (() => void) | null = null;
let cachedModelsFile: ModelsFile = {};

function attachSessionEvents(session: AgentSession): void {
  if (unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
  unsubscribeSession = session.subscribe((ev: AgentEvent) => {
    broadcast("agent_event", ev);
  });
}

async function initSession(): Promise<void> {
  try {
    cachedModelsFile = await loadModelsFile(WORKSPACE_CWD);
  } catch (err) {
    logger.warn("models_file_load_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    cachedModelsFile = {};
  }
  const provider = process.env["KERN_PROVIDER"] || cachedModelsFile.defaultProvider;
  let model = process.env["KERN_MODEL"] || cachedModelsFile.defaultModel;
  const baseUrl = process.env["KERN_BASE_URL"];
  const apiKey = process.env["KERN_API_KEY"];

  let providerName = provider;
  if (model && model.includes("/")) {
    const [p, ...rest] = model.split("/");
    providerName = p;
    model = rest.join("/");
  }

  let adapter = undefined;
  let fallbackModels: Awaited<ReturnType<typeof resolveFallbackAdapters>> = [];
  try {
    if (providerName && model) {
      adapter = await createModelRuntime(
        cachedModelsFile,
        { provider: providerName, model, baseUrl, apiKey },
        logger,
      );
      fallbackModels = await resolveFallbackAdapters(cachedModelsFile, { provider: providerName, model }, logger);
    } else if (baseUrl && model) {
      adapter = await createModelRuntime(
        cachedModelsFile,
        { model, baseUrl, apiKey },
        logger,
      );
      fallbackModels = await resolveFallbackAdapters(cachedModelsFile, { provider: providerName, model }, logger);
    }
  } catch (err) {
    logger.warn("initial_model_runtime_skipped", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const created = await createAgentSession({
    cwd: WORKSPACE_CWD,
    logger,
    requestApproval: (prompt: string, meta?: { toolName?: string }) => requestWebApproval(prompt, meta),
    ...(adapter ? { model: adapter } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
  });
  activeSession = created.session;
  activeManager = created.manager;
  attachSessionEvents(activeSession);
}

function sessionSnapshot() {
  const messages = activeManager
    .getActiveMessages()
    .slice(-40)
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      role: entry.message.role,
      content: entry.message.content,
    }));

  return {
    sessionId: activeManager.sessionId,
    sessionName: activeSession.sessionName(),
    sessionFile: activeManager.sessionFile,
    busy: activeSession.isBusy(),
    model: activeSession.modelInfo(),
    thinkingLevel: activeSession.thinkingMode(),
    safetyMode: activeSession.safetyMode(),
    approvalMode: activeSession.approvalMode(),
    budgetUsage: activeSession.budgetUsage(),
    budgetLimits: activeSession.budgetLimits?.() ?? null,
    contextUsage: activeSession.contextUsage(),
    tools: activeSession.toolNames(),
    connects: activeSession.connects?.listStatuses() ?? [],
    subagents: activeSession.subagents?.listStatuses() ?? [],
    subagentJobs: activeSession.subagents?.listBackgroundJobs() ?? [],
    messages,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kern — Terminal Coding Agent Kernel</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0c0e12;
      --panel: #131720;
      --panel-2: #191f2b;
      --border: #262f40;
      --text: #e6ebf5;
      --muted: #8b97ad;
      --accent: #5eead4;
      --accent-dim: rgba(94, 234, 212, 0.14);
      --warn: #fbbf24;
      --err: #f87171;
      --ok: #34d399;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--mono);
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .brand .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      font-family: var(--mono);
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .badge strong { color: var(--text); font-weight: 600; }
    button, select, input {
      font-family: inherit;
      font-size: 13px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      padding: 6px 10px;
    }
    button {
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    button.danger {
      border-color: var(--err);
      color: var(--err);
    }
    main {
      display: grid;
      grid-template-columns: 1fr 310px;
      min-height: 0;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      aside { display: none; }
    }
    .workspace {
      display: grid;
      grid-template-rows: 1fr auto auto;
      min-height: 0;
    }
    #transcript {
      overflow-y: auto;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    .entry {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
    }
    .entry.user { border-left: 3px solid var(--accent); }
    .entry.assistant { border-left: 3px solid #60a5fa; }
    .entry.tool { border-left: 3px solid var(--warn); font-family: var(--mono); font-size: 12px; }
    .entry.system { border-left: 3px solid var(--muted); color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .entry.error { border-left: 3px solid var(--err); color: var(--err); font-family: var(--mono); font-size: 12px; }
    .entry-role {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .entry pre {
      margin: 6px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .reasoning {
      margin-top: 6px;
      padding: 6px 10px;
      background: rgba(255,255,255,0.03);
      border-radius: 6px;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      white-space: pre-wrap;
    }
    #approval-bar {
      display: none;
      margin: 0 16px 8px;
      padding: 10px 14px;
      background: rgba(251, 191, 36, 0.1);
      border: 1px solid var(--warn);
      border-radius: 8px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    #approval-bar.visible { display: flex; }
    .composer {
      padding: 12px 16px;
      background: var(--panel);
      border-top: 1px solid var(--border);
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    textarea {
      flex: 1;
      resize: none;
      min-height: 44px;
      max-height: 160px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      padding: 10px 12px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
    }
    textarea:focus { outline: none; border-color: var(--accent); }
    aside {
      background: var(--panel);
      border-left: 1px solid var(--border);
      padding: 14px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
      font-size: 13px;
    }
    .panel-section h3 {
      margin: 0 0 8px;
      font-size: 11px;
      font-family: var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .kv {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 10px;
      font-family: var(--mono);
      font-size: 12px;
    }
    .kv .k { color: var(--muted); }
    .kv .v { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tools-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .tool-chip {
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 7px;
      border-radius: 4px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--muted);
      cursor: pointer;
    }
    .tool-chip:hover { color: var(--accent); border-color: var(--accent); }
    .mcp-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .mcp-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--mono);
      font-size: 11.5px;
    }
    .mcp-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }
    .mcp-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      margin-right: 5px;
      background: var(--muted);
    }
    .mcp-dot.connected { background: var(--ok); }
    .mcp-dot.error { background: var(--err); }
    .mcp-dot.untrusted { background: var(--warn); }
    .mcp-actions {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 6px;
    }
    .mcp-actions button {
      font-size: 11px;
      padding: 2px 6px;
    }
    dialog {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      width: min(460px, 92vw);
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.65); }
    .form-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .form-row label { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="dot"></span>
      <span>KERN</span>
      <span class="badge">v1.0.0</span>
      <span class="badge" id="model-badge">model: <strong>loading…</strong></span>
    </div>
    <div class="header-actions">
      <span class="badge" id="session-badge">session: <strong>…</strong></span>
      <button id="btn-agents">+ Agent</button>
      <button id="btn-mcp">+ MCP</button>
      <button id="btn-login">Login</button>
      <button id="btn-logout">Logout</button>
      <button id="btn-compact">Compact</button>
      <button id="btn-new-session">New Session</button>
    </div>
  </header>

  <main>
    <section class="workspace">
      <div id="transcript"></div>
      <div id="approval-bar">
        <div style="flex:1; min-width:240px;">
          <strong style="color: var(--warn); font-family: var(--mono);">Approval Required</strong>
          <div id="approval-text" style="font-family: var(--mono); font-size: 12px; margin-top: 4px; white-space: pre-wrap; max-height: 220px; overflow-y: auto; line-height: 1.45;"></div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="primary" id="btn-approve-once">Allow Once</button>
          <button id="btn-approve-session">Allow Session</button>
          <button class="danger" id="btn-approve-deny">Deny</button>
        </div>
      </div>
      <form class="composer" id="prompt-form">
        <textarea id="prompt-input" placeholder="Send a prompt, or run a command: /help, /tools, /tool git-status {}, /tool read {&quot;path&quot;:&quot;README.md&quot;}"></textarea>
        <button class="primary" type="submit" id="btn-send">Send</button>
      </form>
    </section>

    <aside>
      <div class="panel-section">
        <h3>Runtime</h3>
        <div class="kv">
          <span class="k">Session ID</span><span class="v" id="st-id">-</span>
          <span class="k">Status</span><span class="v" id="st-busy">idle</span>
          <span class="k">Safety</span>
          <span class="v">
            <select id="sel-safety">
              <option value="strict">strict</option>
              <option value="balanced">balanced</option>
              <option value="restricted">restricted</option>
              <option value="autonomous">autonomous</option>
            </select>
          </span>
          <span class="k">Approval</span>
          <span class="v">
            <select id="sel-approval">
              <option value="ask">ask</option>
              <option value="auto-allowlist">auto-allowlist</option>
              <option value="never">never</option>
            </select>
          </span>
          <span class="k">Thinking</span>
          <span class="v">
            <select id="sel-thinking">
              <option value="off">off</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </span>
        </div>
      </div>

      <div class="panel-section">
        <h3>Usage &amp; Context</h3>
        <div class="kv">
          <span class="k">Input tokens</span><span class="v" id="st-in">0</span>
          <span class="k">Output tokens</span><span class="v" id="st-out">0</span>
          <span class="k">Cost (USD)</span><span class="v" id="st-cost">$0.0000</span>
          <span class="k">Context</span><span class="v" id="st-ctx">-</span>
        </div>
      </div>

      <div class="panel-section">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <h3 style="margin:0;">Connectors (MCP)</h3>
          <button type="button" id="btn-mcp-side" style="font-size:11px; padding:2px 7px;">+ Add</button>
        </div>
        <div class="mcp-list" id="mcp-list"></div>
      </div>

      <div class="panel-section">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <h3 style="margin:0;">Subagents (Team)</h3>
          <button type="button" id="btn-agents-side" style="font-size:11px; padding:2px 7px;">+ Add</button>
        </div>
        <div class="mcp-list" id="agents-list"></div>
      </div>

      <div class="panel-section">
        <h3>Tools (click to insert)</h3>
        <div class="tools-grid" id="tools-list"></div>
      </div>
    </aside>
  </main>

  <dialog id="login-dialog">
    <h3 style="margin-top:0; font-family: var(--mono);">Provider Login</h3>
    <div id="auth-saved-box" style="margin-bottom:12px;"></div>
    <form method="dialog" id="login-form">
      <div class="form-row">
        <label>Preset</label>
        <select id="cfg-preset"></select>
      </div>
      <div class="form-row">
        <label>Provider Name</label>
        <input id="cfg-provider" required placeholder="openai" />
      </div>
      <div class="form-row">
        <label>Base URL</label>
        <input id="cfg-baseurl" required placeholder="https://api.openai.com/v1" />
      </div>
      <div class="form-row">
        <label>Model ID</label>
        <input id="cfg-model" required placeholder="gpt-4o-mini" />
      </div>
      <div class="form-row">
        <label>API Key (optional for local loopback; saved to ~/.kern/auth.json)</label>
        <input id="cfg-apikey" type="password" placeholder="sk-..." />
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
        <button type="button" id="btn-login-cancel">Cancel</button>
        <button type="submit" class="primary">Log In</button>
      </div>
    </form>
  </dialog>

  <dialog id="mcp-dialog">
    <h3 style="margin-top:0; font-family: var(--mono);">Connect MCP Server</h3>
    <form method="dialog" id="mcp-form">
      <div class="form-row">
        <label>Preset</label>
        <select id="mcp-preset"></select>
      </div>
      <div class="form-row">
        <label>Server Name</label>
        <input id="mcp-name" required placeholder="context7" />
      </div>
      <div class="form-row">
        <label>Transport</label>
        <select id="mcp-transport">
          <option value="http">Streamable HTTP</option>
          <option value="sse">Legacy HTTP + SSE</option>
          <option value="stdio">Local Stdio Process</option>
        </select>
      </div>
      <div id="mcp-remote-fields">
        <div class="form-row">
          <label>Server URL</label>
          <input id="mcp-url" placeholder="https://mcp.context7.com/mcp" />
        </div>
        <div class="form-row">
          <label>Authorization / Bearer Token (optional)</label>
          <input id="mcp-auth" type="password" placeholder="Bearer ... or raw token" />
        </div>
      </div>
      <div id="mcp-stdio-fields" style="display:none;">
        <div class="form-row">
          <label>Command</label>
          <input id="mcp-command" placeholder="npx" />
        </div>
        <div class="form-row">
          <label>Args (space-separated)</label>
          <input id="mcp-args" placeholder="-y @modelcontextprotocol/server-memory" />
        </div>
        <div class="form-row">
          <label>Env Vars (KEY=VAL per line, supports \${VAR})</label>
          <textarea id="mcp-env" style="min-height:54px;" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=\${GITHUB_PERSONAL_ACCESS_TOKEN}"></textarea>
        </div>
      </div>
      <div class="form-row">
        <label>Config Scope</label>
        <select id="mcp-scope">
          <option value="user">User (~/.kern/mcp.json)</option>
          <option value="project">Project (.mcp.json)</option>
          <option value="memory">Session only (in-memory)</option>
        </select>
      </div>
      <div class="form-row" style="display:flex; align-items:center; gap:8px;">
        <input id="mcp-deferred" type="checkbox" style="width:auto;" />
        <label for="mcp-deferred" style="margin:0; text-transform:none; letter-spacing:0;">Defer tool schemas until searched via <code>mcp_tool_search</code></label>
      </div>
      <div id="mcp-preset-hint" style="display:none; font-size:11.5px; color:var(--muted); margin-bottom:8px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
        <button type="button" id="btn-mcp-cancel">Cancel</button>
        <button type="submit" class="primary">Connect Server</button>
      </div>
    </form>
  </dialog>

  <dialog id="agent-dialog">
    <h3 style="margin-top:0; font-family: var(--mono);">Add Specialist / A2A Agent</h3>
    <form method="dialog" id="agent-form">
      <div class="form-row">
        <label>Input Mode &amp; File Format</label>
        <div style="display:flex; gap:8px;">
          <select id="agent-input-mode" style="flex:1;">
            <option value="form">Visual Form Builder</option>
            <option value="file">Paste / Edit Agent File (.md / .yaml / .json)</option>
          </select>
          <select id="agent-file-format" style="width:140px;">
            <option value="md">Markdown (.md)</option>
            <option value="yaml">YAML (.yaml)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </div>
      </div>
      <div id="agent-form-fields">
        <div class="form-row">
          <label>Preset Template (opt-in)</label>
          <select id="agent-preset"></select>
        </div>
        <div class="form-row">
          <label>Agent Name</label>
          <input id="agent-name" required placeholder="explorer" />
        </div>
        <div class="form-row">
          <label>Type</label>
          <select id="agent-type">
            <option value="local">Local Specialist Subagent</option>
            <option value="a2a">Remote A2A Agent (HTTP JSON-RPC)</option>
          </select>
        </div>
        <div class="form-row">
          <label>Routing Description (visible to root orchestrator)</label>
          <input id="agent-description" required placeholder="Read-only specialist for tracing symbols and tests" />
        </div>
        <div id="agent-local-fields">
          <div class="form-row">
            <label>Mode &amp; Isolation</label>
            <div style="display:flex; gap:8px;">
              <select id="agent-mode" style="flex:1;">
                <option value="readonly">readonly</option>
                <option value="write">write</option>
              </select>
              <select id="agent-isolation" style="flex:1;">
                <option value="readonly">readonly</option>
                <option value="exclusive">exclusive lock</option>
                <option value="worktree">git worktree</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <label>Model Override (optional provider/modelId)</label>
            <input id="agent-model" placeholder="leave blank to inherit active model" />
          </div>
          <div class="form-row">
            <label>Allowed Built-in Tools (comma-separated or readonly | coding | research)</label>
            <input id="agent-tools" placeholder="read, grep, find, git-status, git-diff" />
          </div>
          <div class="form-row">
            <label>Shared Parent MCP Servers (comma-separated, optional)</label>
            <input id="agent-mcp" placeholder="context7, github" />
          </div>
          <div class="form-row">
            <label>System Instruction</label>
            <textarea id="agent-instruction" style="min-height:68px;" placeholder="Role instruction for the specialist..."></textarea>
          </div>
        </div>
        <div id="agent-a2a-fields" style="display:none;">
          <div class="form-row">
            <label>A2A Server Base URL</label>
            <input id="agent-url" placeholder="http://127.0.0.1:41241" />
          </div>
          <div class="form-row">
            <label>Authorization / Bearer Header (optional)</label>
            <input id="agent-auth" type="password" placeholder="Bearer ... or $" />
          </div>
        </div>
      </div>
      <div id="agent-file-fields" style="display:none;">
        <div class="form-row">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <label style="margin:0;">Raw Definition (Frontmatter MD, Plain # MD, YAML, or JSON)</label>
            <button type="button" id="btn-agent-template" style="font-size:11px; padding:2px 8px;">Load Starter Template</button>
          </div>
          <textarea id="agent-raw-content" style="min-height:190px; font-size:12px;" placeholder="# reviewer&#10;Audits code and tests for regressions.&#10;Mode: readonly&#10;Tools: readonly&#10;&#10;## Instructions&#10;Inspect changed files and cite line numbers."></textarea>
        </div>
        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; font-size:11.5px; color:var(--muted); font-family:var(--mono);">Supported file formats &amp; shorthands</summary>
          <pre id="agent-format-hint" style="margin:6px 0 0; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; font-size:11px; color:var(--muted); white-space:pre-wrap; max-height:170px; overflow-y:auto;"></pre>
        </details>
      </div>
      <div class="form-row">
        <label>Config Scope</label>
        <select id="agent-scope">
          <option value="user">User (~/.kern/agents)</option>
          <option value="project">Project (.kern/agents)</option>
          <option value="memory">Session only (in-memory)</option>
        </select>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
        <button type="button" id="btn-agent-cancel">Cancel</button>
        <button type="submit" class="primary">Save Agent</button>
      </div>
    </form>
  </dialog>

  <script>
    const transcriptEl = document.getElementById("transcript");
    const promptForm = document.getElementById("prompt-form");
    const promptInput = document.getElementById("prompt-input");
    const approvalBar = document.getElementById("approval-bar");
    const approvalText = document.getElementById("approval-text");
    const loginDialog = document.getElementById("login-dialog");

    let activeApprovalId = null;
    let streamingEl = null;
    let streamingTextEl = null;
    let streamingReasonEl = null;

    function addEntry(kind, role, text) {
      const div = document.createElement("div");
      div.className = "entry " + kind;
      const roleEl = document.createElement("div");
      roleEl.className = "entry-role";
      roleEl.textContent = role;
      const pre = document.createElement("pre");
      pre.textContent = text;
      div.appendChild(roleEl);
      div.appendChild(pre);
      transcriptEl.appendChild(div);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      return { div, pre };
    }

    function ensureStreamingEntry() {
      if (streamingEl) return;
      const div = document.createElement("div");
      div.className = "entry assistant";
      const roleEl = document.createElement("div");
      roleEl.className = "entry-role";
      roleEl.textContent = "assistant";
      const reasonEl = document.createElement("div");
      reasonEl.className = "reasoning";
      reasonEl.style.display = "none";
      const pre = document.createElement("pre");
      div.appendChild(roleEl);
      div.appendChild(reasonEl);
      div.appendChild(pre);
      transcriptEl.appendChild(div);
      streamingEl = div;
      streamingReasonEl = reasonEl;
      streamingTextEl = pre;
    }

    function renderSnapshot(snap) {
      document.getElementById("st-id").textContent = snap.sessionId || "-";
      document.getElementById("st-busy").textContent = snap.busy ? "busy" : "idle";
      document.getElementById("session-badge").innerHTML =
        "session: <strong>" + (snap.sessionName || snap.sessionId || "-") + "</strong>";
      document.getElementById("model-badge").innerHTML =
        "model: <strong>" + snap.model.provider + "/" + snap.model.modelId + "</strong>";
      document.getElementById("sel-safety").value = snap.safetyMode;
      document.getElementById("sel-approval").value = snap.approvalMode;
      document.getElementById("sel-thinking").value = snap.thinkingLevel;
      document.getElementById("st-in").textContent = String(snap.budgetUsage.inputTokens ?? 0);
      document.getElementById("st-out").textContent = String(snap.budgetUsage.outputTokens ?? 0);
      document.getElementById("st-cost").textContent = "$" + Number(snap.budgetUsage.cost ?? 0).toFixed(4);
      document.getElementById("st-ctx").textContent = snap.contextUsage
        ? snap.contextUsage.totalTokens + " / " + snap.model.contextWindow
        : "-";

      const mcpListEl = document.getElementById("mcp-list");
      mcpListEl.innerHTML = "";
      const servers = snap.connects || [];
      if (servers.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color: var(--muted); font-family: var(--mono); font-size: 11.5px;";
        empty.textContent = "No MCP servers configured.";
        mcpListEl.appendChild(empty);
      } else {
        for (const s of servers) {
          const card = document.createElement("div");
          card.className = "mcp-card";
          const head = document.createElement("div");
          head.className = "mcp-card-head";
          const title = document.createElement("span");
          const dot = document.createElement("span");
          dot.className = "mcp-dot " + s.state;
          title.appendChild(dot);
          const strong = document.createElement("strong");
          strong.textContent = s.name;
          title.appendChild(strong);
          const badge = document.createElement("span");
          badge.style.color = "var(--muted)";
          const extraCounts = [
            s.tools.length + " tools",
            s.resources?.length ? s.resources.length + " res" : "",
            s.prompts?.length ? s.prompts.length + " prompts" : "",
            s.deferred ? "deferred" : "",
          ].filter(Boolean).join(" · ");
          badge.textContent = s.state === "connected" ? extraCounts : s.state;
          head.appendChild(title);
          head.appendChild(badge);
          card.appendChild(head);

          const meta = document.createElement("div");
          meta.style.cssText = "color: var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
          meta.textContent = s.transport + " (" + s.origin + ") · " + (s.error || s.warning || s.target);
          card.appendChild(meta);

          const actions = document.createElement("div");
          actions.className = "mcp-actions";
          const mkBtn = (label, onClick, danger = false) => {
            const b = document.createElement("button");
            b.type = "button";
            if (danger) b.className = "danger";
            b.textContent = label;
            b.onclick = onClick;
            actions.appendChild(b);
          };
          mkBtn("Reconnect", async () => {
            const r = await fetch("/api/connects/reconnect", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: s.name }),
            });
            const d = await r.json();
            if (d.snapshot) renderSnapshot(d.snapshot);
            addEntry("system", "mcp", "Reconnected " + s.name + ": " + (d.server?.state || "done"));
          });
          if (s.state === "untrusted") {
            mkBtn("Trust", async () => {
              const r = await fetch("/api/connects/trust", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: s.name }),
              });
              const d = await r.json();
              if (d.snapshot) renderSnapshot(d.snapshot);
            });
          }
          mkBtn(s.disabled ? "Enable" : "Disable", async () => {
            const r = await fetch("/api/connects/toggle", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: s.name, disabled: !s.disabled }),
            });
            const d = await r.json();
            if (d.snapshot) renderSnapshot(d.snapshot);
          });
          mkBtn("Remove", async () => {
            const r = await fetch("/api/connects?name=" + encodeURIComponent(s.name), { method: "DELETE" });
            const d = await r.json();
            if (d.snapshot) renderSnapshot(d.snapshot);
            addEntry("system", "mcp", "Removed " + s.name);
          }, true);
          card.appendChild(actions);
          mcpListEl.appendChild(card);
        }
      }

      const agentsListEl = document.getElementById("agents-list");
      agentsListEl.innerHTML = "";
      const agents = snap.subagents || [];
      const bgJobs = snap.subagentJobs || [];
      if (agents.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color: var(--muted); font-family: var(--mono); font-size: 11.5px;";
        empty.textContent = "Solo mode (0 subagents configured).";
        agentsListEl.appendChild(empty);
      } else {
        for (const a of agents) {
          const card = document.createElement("div");
          card.className = "mcp-card";
          const head = document.createElement("div");
          head.className = "mcp-card-head";
          const title = document.createElement("span");
          const dot = document.createElement("span");
          dot.className = "mcp-dot " + (a.state === "ready" ? "connected" : a.state === "untrusted" ? "untrusted" : a.state === "error" ? "error" : "");
          title.appendChild(dot);
          const strong = document.createElement("strong");
          strong.textContent = a.name;
          title.appendChild(strong);
          const badge = document.createElement("span");
          badge.style.color = "var(--muted)";
          const runningBg = bgJobs.filter((j) => j.agent === a.name && j.running).length;
          badge.textContent = (a.type === "a2a" ? "a2a" : a.mode + "/" + a.isolation) + (runningBg ? " · " + runningBg + " running" : "");
          head.appendChild(title);
          head.appendChild(badge);
          card.appendChild(head);

          const meta = document.createElement("div");
          meta.style.cssText = "color: var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
          meta.textContent = a.warning || a.error || a.description;
          card.appendChild(meta);

          const actions = document.createElement("div");
          actions.className = "mcp-actions";
          const mkBtn = (label, onClick, danger = false) => {
            const b = document.createElement("button");
            b.type = "button";
            if (danger) b.className = "danger";
            b.textContent = label;
            b.onclick = onClick;
            actions.appendChild(b);
          };
          if (a.state === "untrusted") {
            mkBtn("Trust", async () => {
              const r = await fetch("/api/agents/trust", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: a.name }),
              });
              const d = await r.json();
              if (d.snapshot) renderSnapshot(d.snapshot);
            });
          }
          mkBtn(a.disabled ? "Enable" : "Disable", async () => {
            const r = await fetch("/api/agents/toggle", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: a.name, disabled: !a.disabled }),
            });
            const d = await r.json();
            if (d.snapshot) renderSnapshot(d.snapshot);
          });
          mkBtn("Remove", async () => {
            const r = await fetch("/api/agents?name=" + encodeURIComponent(a.name), { method: "DELETE" });
            const d = await r.json();
            if (d.snapshot) renderSnapshot(d.snapshot);
            addEntry("system", "agents", "Removed subagent " + a.name);
          }, true);
          card.appendChild(actions);
          agentsListEl.appendChild(card);
        }
      }

      const toolsEl = document.getElementById("tools-list");
      toolsEl.innerHTML = "";
      for (const t of snap.tools) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tool-chip";
        chip.textContent = t;
        chip.onclick = () => {
          promptInput.value = "/tool " + t + " {}";
          promptInput.focus();
        };
        toolsEl.appendChild(chip);
      }
    }

    async function refreshSession() {
      const res = await fetch("/api/session");
      const snap = await res.json();
      renderSnapshot(snap);
      return snap;
    }

    async function runCommandOrPrompt(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed === "/help") {
        addEntry("system", "help",
          "Commands:\\n" +
          "  /help                     Show this help\\n" +
          "  /login                    Open provider login dialog\\n" +
          "  /logout [provider|--all]  Clear saved provider credentials\\n" +
          "  /tools                    List registered kernel & MCP tools\\n" +
          "  /mcp                      Show connected MCP servers & status\\n" +
          "  /agents                   Show configured subagents & A2A team members\\n" +
          "  /tool <name> [json-args]  Invoke a kernel tool directly (e.g. /tool read {\\"path\\":\\"README.md\\"})\\n" +
          "  /compact [instructions]   Compact session context\\n" +
          "  /new                      Start a new session\\n" +
          "  <any text>                Send prompt to active model adapter"
        );
        return;
      }
      if (trimmed === "/login") {
        await openLoginDialog();
        return;
      }
      if (trimmed === "/logout" || trimmed.startsWith("/logout ")) {
        const arg = trimmed.slice(7).trim();
        await performLogout(arg === "--all" || arg === "all" ? { all: true } : arg ? { provider: arg } : undefined);
        return;
      }
      if (trimmed === "/mcp") {
        const snap = await refreshSession();
        const lines = (snap.connects || []).map((s) =>
          s.name + " [" + s.transport + ", " + s.origin + (s.deferred ? ", deferred" : "") + "]: " + s.state +
          (s.tools?.length ? " (" + s.tools.map((t) => t.registeredName).join(", ") + ")" : "") +
          (s.resources?.length ? " [" + s.resources.length + " resource(s)]" : "") +
          (s.prompts?.length ? " [" + s.prompts.length + " prompt(s)]" : "") +
          (s.error ? " — " + s.error : "")
        );
        addEntry("system", "mcp", lines.join("\\n") || "No MCP servers configured. Click '+ MCP' to add one.");
        return;
      }
      if (trimmed === "/agents" || trimmed === "/team") {
        const snap = await refreshSession();
        const lines = (snap.subagents || []).map((a) =>
          a.name + " [" + a.type + ", " + (a.type === "a2a" ? a.url : a.mode + "/" + a.isolation) + ", " + a.origin + "]: " + a.state +
          (a.model ? " (model=" + a.model + ")" : "") +
          (a.warning ? " — " + a.warning : "")
        );
        addEntry("system", "agents", lines.join("\\n") || "No subagents configured (solo mode). Click '+ Agent' to add an opt-in specialist or A2A agent.");
        return;
      }
      if (trimmed === "/tools") {
        const snap = await refreshSession();
        addEntry("system", "tools", snap.tools.join(", "));
        return;
      }
      if (trimmed === "/new") {
        await fetch("/api/session/new", { method: "POST" });
        transcriptEl.innerHTML = "";
        const snap = await refreshSession();
        addEntry("system", "session", "Started new session " + snap.sessionId);
        return;
      }
      if (trimmed.startsWith("/compact")) {
        const instructions = trimmed.slice(8).trim() || undefined;
        const res = await fetch("/api/session/compact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instructions }),
        });
        const data = await res.json();
        addEntry("system", "compact", JSON.stringify(data, null, 2));
        await refreshSession();
        return;
      }
      if (trimmed.startsWith("/tool ")) {
        const rest = trimmed.slice(6).trim();
        const spaceIdx = rest.indexOf(" ");
        const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
        const rawArgs = spaceIdx === -1 ? "{}" : rest.slice(spaceIdx + 1).trim();
        let args = {};
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch (err) {
          addEntry("error", "tool", "Invalid JSON args: " + err.message);
          return;
        }
        addEntry("user", "tool call", name + " " + JSON.stringify(args));
        const res = await fetch("/api/tool", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, args }),
        });
        const data = await res.json();
        if (!res.ok) {
          addEntry("error", "tool error", data.error || "Tool failed");
        } else {
          const out = (data.result?.content || []).map((c) => c.text).join("\\n");
          addEntry(data.result?.isError ? "error" : "tool", "tool result (" + name + ")", out || "(empty)");
        }
        await refreshSession();
        return;
      }

      addEntry("user", "user", trimmed);
      streamingEl = null;
      const res = await fetch("/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Prompt failed" }));
        addEntry("error", "error", err.error || "Prompt failed");
      }
      await refreshSession();
    }

    promptForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = promptInput.value;
      if (!text.trim()) return;
      promptInput.value = "";
      await runCommandOrPrompt(text);
    });

    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        promptForm.requestSubmit();
      }
    });

    for (const [btnId, decision] of [
      ["btn-approve-once", "once"],
      ["btn-approve-session", "session"],
      ["btn-approve-deny", "deny"],
    ]) {
      document.getElementById(btnId).onclick = async () => {
        if (!activeApprovalId) return;
        const id = activeApprovalId;
        activeApprovalId = null;
        approvalBar.classList.remove("visible");
        await fetch("/api/approval", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
      };
    }

    document.getElementById("sel-safety").onchange = async (e) => {
      await fetch("/api/session/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ safetyMode: e.target.value }),
      });
      await refreshSession();
    };
    document.getElementById("sel-approval").onchange = async (e) => {
      await fetch("/api/session/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalMode: e.target.value }),
      });
      await refreshSession();
    };
    document.getElementById("sel-thinking").onchange = async (e) => {
      await fetch("/api/session/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: e.target.value }),
      });
      await refreshSession();
    };

    document.getElementById("btn-new-session").onclick = () => runCommandOrPrompt("/new");
    document.getElementById("btn-compact").onclick = () => runCommandOrPrompt("/compact");

    async function renderSavedAuthList() {
      const box = document.getElementById("auth-saved-box");
      const res = await fetch("/api/auth");
      const auth = await res.json();
      box.innerHTML = "";
      const list = auth.loggedInProviders || [];
      if (list.length === 0) return;
      const title = document.createElement("div");
      title.style.cssText = "font-family: var(--mono); font-size: 11px; color: var(--muted); margin-bottom: 6px;";
      title.textContent = "LOGGED-IN PROVIDERS (~/.kern/auth.json)";
      box.appendChild(title);
      for (const item of list) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 8px; margin-bottom:4px; background:var(--bg); border:1px solid var(--border); border-radius:6px; font-family:var(--mono); font-size:12px;";
        const label = document.createElement("span");
        label.textContent = item.provider + " (" + item.maskedKey + ")";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "danger";
        btn.style.cssText = "font-size:11px; padding:2px 6px;";
        btn.textContent = "Logout";
        btn.onclick = async () => {
          await performLogout({ provider: item.provider });
          await renderSavedAuthList();
        };
        row.appendChild(label);
        row.appendChild(btn);
        box.appendChild(row);
      }
    }

    async function performLogout(opts) {
      let body = opts;
      if (!body) {
        const authRes = await fetch("/api/auth");
        const auth = await authRes.json();
        const list = auth.loggedInProviders || [];
        if (list.length === 0) {
          addEntry("system", "auth", "No saved provider credentials in ~/.kern/auth.json.");
          return;
        }
        const active = auth.activeProvider;
        const target = list.find((i) => i.provider === active)?.provider || list[0].provider;
        body = { provider: target };
      }
      const res = await fetch("/api/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        addEntry("error", "logout", data.error || "Logout failed");
      } else if (data.loggedOut?.length) {
        addEntry("system", "auth", "Logged out of " + data.loggedOut.join(", ") + " (removed from ~/.kern/auth.json).");
      } else {
        addEntry("system", "auth", "No saved credentials removed.");
      }
      await refreshSession();
    }

    async function openLoginDialog() {
      const [modelsRes] = await Promise.all([fetch("/api/models"), renderSavedAuthList()]);
      const data = await modelsRes.json();
      const presetSel = document.getElementById("cfg-preset");
      presetSel.innerHTML = "<option value=''>custom</option>";
      for (const p of data.presets || []) {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = p.name + " (" + p.hint + ")";
        opt.dataset.baseUrl = p.baseUrl;
        presetSel.appendChild(opt);
      }
      presetSel.onchange = () => {
        const sel = presetSel.selectedOptions[0];
        if (sel && sel.value) {
          document.getElementById("cfg-provider").value = sel.value;
          document.getElementById("cfg-baseurl").value = sel.dataset.baseUrl || "";
        }
      };
      loginDialog.showModal();
    }

    document.getElementById("btn-login").onclick = openLoginDialog;
    document.getElementById("btn-logout").onclick = () => performLogout();
    document.getElementById("btn-login-cancel").onclick = () => loginDialog.close();
    document.getElementById("login-form").onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        provider: document.getElementById("cfg-provider").value.trim(),
        baseUrl: document.getElementById("cfg-baseurl").value.trim(),
        modelId: document.getElementById("cfg-model").value.trim(),
        apiKey: document.getElementById("cfg-apikey").value.trim() || undefined,
        save: true,
      };
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        addEntry("error", "login", data.error || "Failed to log in");
      } else {
        addEntry("system", "auth", "Logged in: " + data.model.provider + "/" + data.model.modelId);
      }
      loginDialog.close();
      await refreshSession();
    };

    const mcpDialog = document.getElementById("mcp-dialog");
    const syncMcpTransportFields = () => {
      const tr = document.getElementById("mcp-transport").value;
      document.getElementById("mcp-remote-fields").style.display = tr === "stdio" ? "none" : "block";
      document.getElementById("mcp-stdio-fields").style.display = tr === "stdio" ? "block" : "none";
    };
    document.getElementById("mcp-transport").onchange = syncMcpTransportFields;

    async function openMcpDialog() {
      const res = await fetch("/api/connects");
      const data = await res.json();
      const presetSel = document.getElementById("mcp-preset");
      presetSel.innerHTML = "<option value=''>custom</option>";
      for (const p of data.presets || []) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + " (" + p.transport + ")";
        opt.dataset.preset = JSON.stringify(p);
        presetSel.appendChild(opt);
      }
      presetSel.onchange = () => {
        const sel = presetSel.selectedOptions[0];
        const hintEl = document.getElementById("mcp-preset-hint");
        if (!sel || !sel.dataset.preset) {
          hintEl.style.display = "none";
          hintEl.textContent = "";
          return;
        }
        const p = JSON.parse(sel.dataset.preset);
        document.getElementById("mcp-name").value = p.id;
        document.getElementById("mcp-transport").value = p.transport;
        syncMcpTransportFields();
        document.getElementById("mcp-url").value = p.entry.url || "";
        const presetAuth = p.entry.headers?.Authorization || "";
        const authEl = document.getElementById("mcp-auth");
        if (presetAuth.includes("$" + "{")) {
          authEl.value = "";
          authEl.placeholder = presetAuth + " (enter token or leave empty to use env)";
        } else {
          authEl.value = presetAuth;
          authEl.placeholder = "Bearer ... or raw token";
        }
        document.getElementById("mcp-command").value = p.entry.command || "";
        document.getElementById("mcp-args").value = (p.entry.args || []).join(" ");
        document.getElementById("mcp-env").value = Object.entries(p.entry.env || {}).map(([k, v]) => k + "=" + v).join("\\n");
        document.getElementById("mcp-deferred").checked = Boolean(p.entry.deferred);
        if (p.variables && p.variables.length > 0) {
          hintEl.style.display = "block";
          hintEl.textContent = "Variables: " + p.variables.map((v) => v.key + (v.required ? " (required)" : " (optional)")).join(", ");
        } else {
          hintEl.style.display = "none";
          hintEl.textContent = "";
        }
      };
      syncMcpTransportFields();
      mcpDialog.showModal();
    }

    document.getElementById("btn-mcp").onclick = openMcpDialog;
    document.getElementById("btn-mcp-side").onclick = openMcpDialog;
    document.getElementById("btn-mcp-cancel").onclick = () => mcpDialog.close();
    document.getElementById("mcp-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = document.getElementById("mcp-name").value.trim();
      const transport = document.getElementById("mcp-transport").value;
      const scope = document.getElementById("mcp-scope").value;
      const deferred = document.getElementById("mcp-deferred").checked;
      const body = { name, transport, scope, ...(deferred ? { deferred: true } : {}) };
      if (transport === "stdio") {
        body.command = document.getElementById("mcp-command").value.trim();
        const argsRaw = document.getElementById("mcp-args").value.trim();
        body.args = argsRaw ? argsRaw.split(/\\s+/).filter(Boolean) : [];
        const envLines = document.getElementById("mcp-env").value.split("\\n").map((s) => s.trim()).filter(Boolean);
        const env = {};
        for (const line of envLines) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        if (Object.keys(env).length > 0) body.env = env;
      } else {
        body.url = document.getElementById("mcp-url").value.trim();
        const auth = document.getElementById("mcp-auth").value.trim();
        if (auth) {
          body.headers = { Authorization: /^bearer\\s+/i.test(auth) || auth.startsWith("$") ? auth : "Bearer " + auth };
        }
      }
      const res = await fetch("/api/connects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        addEntry("error", "mcp", data.error || "Failed to connect MCP server");
      } else {
        const s = data.server;
        addEntry(s.state === "error" ? "error" : "system", "mcp",
          s.name + ": " + s.state + (s.error ? " — " + s.error : " (" + (s.tools?.length || 0) + " tool(s))"));
      }
      mcpDialog.close();
      await refreshSession();
    };

    const agentDialog = document.getElementById("agent-dialog");
    let cachedAgentTemplates = {};
    let lastAgentTemplateText = "";
    const syncAgentTypeFields = () => {
      const t = document.getElementById("agent-type").value;
      document.getElementById("agent-local-fields").style.display = t === "a2a" ? "none" : "block";
      document.getElementById("agent-a2a-fields").style.display = t === "a2a" ? "block" : "none";
    };
    const syncAgentInputMode = () => {
      const mode = document.getElementById("agent-input-mode").value;
      const isFile = mode === "file";
      document.getElementById("agent-form-fields").style.display = isFile ? "none" : "block";
      document.getElementById("agent-file-fields").style.display = isFile ? "block" : "none";
      document.getElementById("agent-name").required = !isFile;
      document.getElementById("agent-description").required = !isFile;
    };
    const applyStarterTemplateIfUntouched = () => {
      const rawEl = document.getElementById("agent-raw-content");
      const fmt = document.getElementById("agent-file-format").value;
      const cur = rawEl.value.trim();
      if (cachedAgentTemplates[fmt] && (!cur || cur === lastAgentTemplateText.trim())) {
        rawEl.value = cachedAgentTemplates[fmt];
        lastAgentTemplateText = cachedAgentTemplates[fmt];
      }
    };
    document.getElementById("agent-type").onchange = syncAgentTypeFields;
    document.getElementById("agent-input-mode").onchange = () => {
      syncAgentInputMode();
      if (document.getElementById("agent-input-mode").value === "file") {
        applyStarterTemplateIfUntouched();
      }
    };
    document.getElementById("agent-file-format").onchange = () => {
      if (document.getElementById("agent-input-mode").value === "file") {
        applyStarterTemplateIfUntouched();
      }
    };
    document.getElementById("btn-agent-template").onclick = () => {
      const fmt = document.getElementById("agent-file-format").value;
      if (cachedAgentTemplates[fmt]) {
        document.getElementById("agent-raw-content").value = cachedAgentTemplates[fmt];
        lastAgentTemplateText = cachedAgentTemplates[fmt];
      }
    };

    async function openAgentDialog() {
      const res = await fetch("/api/agents");
      const data = await res.json();
      cachedAgentTemplates = data.templates || {};
      lastAgentTemplateText = "";
      document.getElementById("agent-format-hint").textContent = data.formatGuide || "";
      const presetSel = document.getElementById("agent-preset");
      presetSel.innerHTML = "<option value=''>custom</option>";
      for (const p of data.presets || []) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + " (" + (p.entry?.mode || "readonly") + ")";
        opt.dataset.preset = JSON.stringify(p);
        presetSel.appendChild(opt);
      }
      presetSel.onchange = () => {
        const sel = presetSel.selectedOptions[0];
        if (!sel || !sel.dataset.preset) return;
        const p = JSON.parse(sel.dataset.preset);
        document.getElementById("agent-name").value = p.entry.name || p.id;
        document.getElementById("agent-type").value = p.entry.type || "local";
        syncAgentTypeFields();
        document.getElementById("agent-description").value = p.entry.description || "";
        document.getElementById("agent-mode").value = p.entry.mode || "readonly";
        document.getElementById("agent-isolation").value = p.entry.isolation || "readonly";
        document.getElementById("agent-model").value = p.entry.model || "";
        document.getElementById("agent-tools").value = (p.entry.tools || []).join(", ");
        document.getElementById("agent-mcp").value = (p.entry.mcpServers || []).join(", ");
        document.getElementById("agent-instruction").value = p.entry.instruction || "";
      };
      syncAgentTypeFields();
      syncAgentInputMode();
      if (document.getElementById("agent-input-mode").value === "file") {
        applyStarterTemplateIfUntouched();
      }
      agentDialog.showModal();
    }

    document.getElementById("btn-agents").onclick = openAgentDialog;
    document.getElementById("btn-agents-side").onclick = openAgentDialog;
    document.getElementById("btn-agent-cancel").onclick = () => agentDialog.close();
    document.getElementById("agent-form").onsubmit = async (e) => {
      e.preventDefault();
      const inputMode = document.getElementById("agent-input-mode").value;
      const format = document.getElementById("agent-file-format").value;
      const scope = document.getElementById("agent-scope").value;
      let payload;
      if (inputMode === "file") {
        const rawContent = document.getElementById("agent-raw-content").value.trim();
        if (!rawContent) {
          addEntry("error", "agents", "Paste or load a subagent definition before saving.");
          return;
        }
        payload = { rawContent, format, scope };
      } else {
        const type = document.getElementById("agent-type").value;
        const entry = {
          name: document.getElementById("agent-name").value.trim(),
          type,
          description: document.getElementById("agent-description").value.trim(),
        };
        if (type === "a2a") {
          entry.url = document.getElementById("agent-url").value.trim();
          const auth = document.getElementById("agent-auth").value.trim();
          if (auth) {
            entry.headers = { Authorization: /^bearer\\s+/i.test(auth) || auth.startsWith("$") ? auth : "Bearer " + auth };
          }
        } else {
          entry.mode = document.getElementById("agent-mode").value;
          entry.isolation = document.getElementById("agent-isolation").value;
          const model = document.getElementById("agent-model").value.trim();
          if (model) entry.model = model;
          const toolsRaw = document.getElementById("agent-tools").value.trim();
          if (toolsRaw) entry.tools = toolsRaw.split(",").map((s) => s.trim()).filter(Boolean);
          const mcpRaw = document.getElementById("agent-mcp").value.trim();
          if (mcpRaw) entry.mcpServers = mcpRaw.split(",").map((s) => s.trim()).filter(Boolean);
          const instruction = document.getElementById("agent-instruction").value.trim();
          if (instruction) entry.instruction = instruction;
        }
        payload = { entry, scope, format };
      }
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        addEntry("error", "agents", data.error || "Failed saving agent");
      } else {
        addEntry("system", "agents", "Saved " + data.agent.type + " agent " + data.agent.name + ": " + data.agent.state);
      }
      agentDialog.close();
      await refreshSession();
    };

    const evtSource = new EventSource("/api/events");
    evtSource.addEventListener("agent_event", (e) => {
      const ev = JSON.parse(e.data);
      switch (ev.type) {
        case "text_delta":
          ensureStreamingEntry();
          streamingTextEl.textContent += ev.delta;
          transcriptEl.scrollTop = transcriptEl.scrollHeight;
          break;
        case "reasoning_delta":
          ensureStreamingEntry();
          streamingReasonEl.style.display = "block";
          streamingReasonEl.textContent += ev.delta;
          transcriptEl.scrollTop = transcriptEl.scrollHeight;
          break;
        case "message_end":
          if (ev.message?.role === "assistant") {
            if (!streamingEl) {
              const txt = (ev.message.content || [])
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\\n");
              if (txt) addEntry("assistant", "assistant", txt);
            }
            streamingEl = null;
          }
          break;
        case "tool_execution_start":
          addEntry("tool", "tool start: " + ev.toolName, JSON.stringify(ev.arguments ?? {}, null, 2));
          break;
        case "tool_execution_update":
          if (typeof ev.delta === "string" && ev.delta.trim()) {
            const entries = transcriptEl.querySelectorAll(".entry.tool");
            const lastTool = entries[entries.length - 1];
            const lastTitle = lastTool?.querySelector(".role")?.textContent || "";
            if (lastTool && lastTitle.includes("tool output: " + ev.toolName)) {
              const bodyEl = lastTool.querySelector(".body");
              if (bodyEl) {
                bodyEl.textContent += ev.delta;
                transcriptEl.scrollTop = transcriptEl.scrollHeight;
                break;
              }
            }
            addEntry("tool", "tool output: " + ev.toolName, ev.delta);
          }
          break;
        case "tool_input_repaired":
          addEntry("system", "arg repair (" + ev.toolName + ")", ev.repairs.join(", "));
          break;
        case "tool_execution_end": {
          const out = (ev.result?.content || []).map((c) => c.text).join("\\n");
          addEntry(ev.isError ? "error" : "tool", "tool end: " + ev.toolName, out || "(done)");
          break;
        }
        case "model_fallback":
          addEntry("system", "model fallback", ev.fromProvider + "/" + ev.fromModel + " -> " + ev.toProvider + "/" + ev.toModel + ": " + ev.reason);
          refreshSession();
          break;
        case "budget_warning":
          addEntry("system", "budget warning (" + ev.kind + ")", ev.message);
          break;
        case "budget_exceeded":
          addEntry("error", "budget exceeded (" + ev.kind + ")", ev.message);
          break;
        case "agent_error":
          addEntry("error", "agent_error (" + ev.error.code + ")", ev.error.message);
          streamingEl = null;
          break;
        case "agent_settled":
          streamingEl = null;
          refreshSession();
          break;
      }
    });
    evtSource.addEventListener("approval_request", (e) => {
      const req = JSON.parse(e.data);
      activeApprovalId = req.id;
      approvalText.textContent = "[" + req.toolName + "] " + req.prompt;
      approvalBar.classList.add("visible");
    });
    evtSource.addEventListener("approval_resolved", () => {
      activeApprovalId = null;
      approvalBar.classList.remove("visible");
    });

    (async () => {
      const snap = await refreshSession();
      addEntry(
        "system",
        "kern",
        "Kern runtime ready (" + snap.sessionId + ").\\n" +
        "Active model: " + snap.model.provider + "/" + snap.model.modelId + ".\\n" +
        "Type /help for commands, click any tool on the right, or connect an OpenAI-compatible model."
      );
      for (const m of snap.messages || []) {
        const text = (m.content || [])
          .filter((b) => b.type === "text" || b.type === "tool_result")
          .map((b) => (b.type === "text" ? b.text : (b.content || []).map((c) => c.text).join("\\n")))
          .join("\\n");
        if (text) addEntry(m.role, m.role, text);
      }
    })();
  </script>
</body>
</html>
`;

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }

  if (method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      sessionId: activeManager.sessionId,
      model: activeSession.modelInfo(),
      cwd: WORKSPACE_CWD,
    });
  }

  if (method === "GET" && url.pathname === "/api/session") {
    return sendJson(res, 200, sessionSnapshot());
  }

  if (method === "GET" && url.pathname === "/api/models") {
    const models = await discoverModels(cachedModelsFile).catch(() => []);
    return sendJson(res, 200, {
      active: activeSession.modelInfo(),
      presets: PROVIDER_PRESETS,
      discovered: models,
    });
  }

  if (method === "GET" && url.pathname === "/api/connects") {
    return sendJson(res, 200, {
      servers: activeSession.connects?.listStatuses() ?? [],
      warnings: activeSession.connects?.getWarnings() ?? [],
      presets: CONNECTOR_PRESETS,
    });
  }

  if (method === "POST" && url.pathname === "/api/connects") {
    if (!activeSession.connects) {
      return sendJson(res, 501, { error: "Connects manager unavailable" });
    }
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const scope =
      body.scope === "project" || body.scope === "memory" ? body.scope : "user";
    if (!name) {
      return sendJson(res, 400, { error: "Server name is required" });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      return sendJson(res, 400, { error: "Invalid server name: start with alphanumeric and use [A-Za-z0-9_.-] (1-64 chars)" });
    }
    const transport =
      body.transport === "stdio" || body.transport === "http" || body.transport === "sse"
        ? body.transport
        : body.type === "sse"
          ? "sse"
          : body.command
            ? "stdio"
            : "http";

    const entry: McpServerConfigEntry = {
      transport,
      ...(body.deferred === true ? { deferred: true } : {}),
    };
    if (transport === "stdio") {
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command) {
        return sendJson(res, 400, { error: "command is required for stdio MCP servers" });
      }
      entry.command = command;
      if (Array.isArray(body.args)) {
        entry.args = body.args.map((a) => String(a));
      }
      if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
        entry.env = Object.fromEntries(
          Object.entries(body.env as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string]),
        );
      }
    } else {
      const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return sendJson(res, 400, { error: "Valid http(s) url is required for HTTP/SSE MCP servers" });
      }
      entry.url = targetUrl;
      if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
        entry.headers = Object.fromEntries(
          Object.entries(body.headers as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string]),
        );
      }
    }

    try {
      const server = await activeSession.connects.addServer(name, entry, { scope });
      return sendJson(res, 200, { ok: true, server, snapshot: sessionSnapshot() });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (method === "POST" && url.pathname === "/api/connects/reconnect") {
    if (!activeSession.connects) {
      return sendJson(res, 501, { error: "Connects manager unavailable" });
    }
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const server = await activeSession.connects.reconnectServer(name);
    return sendJson(res, 200, { ok: true, server, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/connects/toggle") {
    if (!activeSession.connects) {
      return sendJson(res, 501, { error: "Connects manager unavailable" });
    }
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const server = await activeSession.connects.toggleServer(name, Boolean(body.disabled));
    return sendJson(res, 200, { ok: true, server, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/connects/trust") {
    if (!activeSession.connects) {
      return sendJson(res, 501, { error: "Connects manager unavailable" });
    }
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const server = await activeSession.connects.trustServer(name);
    return sendJson(res, 200, { ok: true, server, snapshot: sessionSnapshot() });
  }

  if (method === "DELETE" && url.pathname === "/api/connects") {
    if (!activeSession.connects) {
      return sendJson(res, 501, { error: "Connects manager unavailable" });
    }
    const name = url.searchParams.get("name")?.trim() ?? "";
    if (!name) return sendJson(res, 400, { error: "name query parameter is required" });
    const removed = await activeSession.connects.removeServer(name);
    return sendJson(res, 200, { ok: true, removed, snapshot: sessionSnapshot() });
  }

  if (method === "GET" && url.pathname === "/api/agents") {
    const sample: SubagentConfigEntry = {
      name: "specialist",
      type: "local",
      description: "Focused specialist agent for inspecting code or tests",
      mode: "readonly",
      isolation: "readonly",
      tools: ["read", "grep", "find", "git-status", "git-diff"],
      maxTurns: 12,
      instruction: "Investigate carefully and report exact file paths, line numbers, and concrete findings.",
    };
    return sendJson(res, 200, {
      agents: activeSession.subagents?.listStatuses() ?? [],
      backgroundJobs: activeSession.subagents?.listBackgroundJobs() ?? [],
      warnings: activeSession.subagents?.getWarnings() ?? [],
      presets: SUBAGENT_PRESETS,
      formatGuide: SUBAGENT_FORMAT_GUIDE,
      templates: {
        md: renderSubagentTemplate(sample, "md"),
        yaml: renderSubagentTemplate(sample, "yaml"),
        json: renderSubagentTemplate(sample, "json"),
      },
    });
  }

  if (method === "POST" && url.pathname === "/api/agents") {
    if (!activeSession.subagents) {
      return sendJson(res, 501, { error: "Subagent manager unavailable" });
    }
    const body = await readJsonBody(req);
    const scope = body.scope === "project" || body.scope === "memory" ? body.scope : "user";
    const format: SubagentFileFormat | undefined =
      body.format === "yaml" || body.format === "json" || body.format === "md" ? body.format : undefined;

    if (typeof body.rawContent === "string" && body.rawContent.trim()) {
      const parsed = parseSubagentFile(
        body.rawContent,
        format ? `.${format}` : "",
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : "custom-agent",
      );
      if (!parsed) {
        return sendJson(res, 400, {
          error: "Could not parse subagent definition (ensure valid name & description in .md, .yaml, or .json format)",
        });
      }
      try {
        const agent = await activeSession.subagents.addSubagent(parsed, { scope, ...(format ? { format } : {}) });
        return sendJson(res, 200, { ok: true, agent, snapshot: sessionSnapshot() });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const rawEntry = (body.entry && typeof body.entry === "object" ? body.entry : body) as Record<string, unknown>;
    const name = typeof rawEntry.name === "string" ? rawEntry.name.trim() : "";
    const description = typeof rawEntry.description === "string" ? rawEntry.description.trim() : "";
    if (!name || !description) {
      return sendJson(res, 400, { error: "Agent name and description are required" });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      return sendJson(res, 400, { error: "Invalid agent name: start with alphanumeric and use [A-Za-z0-9_.-] (1-64 chars)" });
    }
    const type = rawEntry.type === "a2a" || rawEntry.url ? "a2a" : "local";
    const entry: SubagentConfigEntry = {
      name,
      description,
      type,
      ...(typeof rawEntry.instruction === "string" && rawEntry.instruction.trim() ? { instruction: rawEntry.instruction.trim() } : {}),
      ...(rawEntry.mode === "write" || rawEntry.mode === "readonly" ? { mode: rawEntry.mode } : {}),
      ...(rawEntry.isolation === "readonly" || rawEntry.isolation === "exclusive" || rawEntry.isolation === "worktree"
        ? { isolation: rawEntry.isolation }
        : {}),
      ...(Array.isArray(rawEntry.tools) ? { tools: rawEntry.tools.map((t) => String(t).trim()).filter(Boolean) } : {}),
      ...(Array.isArray(rawEntry.mcpServers)
        ? { mcpServers: rawEntry.mcpServers.map((s) => String(s).trim()).filter(Boolean) }
        : {}),
      ...(typeof rawEntry.model === "string" && rawEntry.model.trim() ? { model: rawEntry.model.trim() } : {}),
      ...(typeof rawEntry.url === "string" && rawEntry.url.trim() ? { url: rawEntry.url.trim() } : {}),
      ...(rawEntry.headers && typeof rawEntry.headers === "object" && !Array.isArray(rawEntry.headers)
        ? {
            headers: Object.fromEntries(
              Object.entries(rawEntry.headers as Record<string, unknown>)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string]),
            ),
          }
        : {}),
    };
    if (type === "a2a" && (!entry.url || !/^https?:\/\//i.test(entry.url))) {
      return sendJson(res, 400, { error: "Valid http(s) url is required for remote A2A agents" });
    }
    try {
      const agent = await activeSession.subagents.addSubagent(entry, { scope, ...(format ? { format } : {}) });
      return sendJson(res, 200, { ok: true, agent, snapshot: sessionSnapshot() });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (method === "POST" && url.pathname === "/api/agents/reload") {
    if (!activeSession.subagents) return sendJson(res, 501, { error: "Subagent manager unavailable" });
    const resDiscover = await activeSession.subagents.discover();
    return sendJson(res, 200, { ok: true, ...resDiscover, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/agents/toggle") {
    if (!activeSession.subagents) return sendJson(res, 501, { error: "Subagent manager unavailable" });
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const agent = await activeSession.subagents.toggleSubagent(name, Boolean(body.disabled));
    return sendJson(res, 200, { ok: true, agent, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/agents/trust") {
    if (!activeSession.subagents) return sendJson(res, 501, { error: "Subagent manager unavailable" });
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const agent = await activeSession.subagents.trustSubagent(name);
    return sendJson(res, 200, { ok: true, agent, snapshot: sessionSnapshot() });
  }

  if (method === "DELETE" && url.pathname === "/api/agents") {
    if (!activeSession.subagents) return sendJson(res, 501, { error: "Subagent manager unavailable" });
    const name = url.searchParams.get("name")?.trim() ?? "";
    if (!name) return sendJson(res, 400, { error: "name query parameter is required" });
    const removed = await activeSession.subagents.removeSubagent(name);
    return sendJson(res, 200, { ok: true, removed, snapshot: sessionSnapshot() });
  }

  if (method === "GET" && url.pathname === "/api/auth") {
    const auth = await loadAuth();
    return sendJson(res, 200, {
      activeProvider: activeSession.modelInfo().provider,
      loggedInProviders: Object.entries(auth).map(([provider, entry]) => ({
        provider,
        maskedKey: maskKey(entry.apiKey ?? ""),
      })),
    });
  }

  if (method === "POST" && (url.pathname === "/api/login" || url.pathname === "/api/connect")) {
    const body = await readJsonBody(req);
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    if (!provider || !baseUrl || !modelId) {
      return sendJson(res, 400, { error: "provider, baseUrl, and modelId are required" });
    }
    if (body.save !== false) {
      if (apiKey && !apiKey.startsWith("$") && !apiKey.startsWith("!")) {
        await saveAuthKey(provider, apiKey);
      }
      const preset = PROVIDER_PRESETS.find((p) => p.name === provider);
      const envMatch = apiKey?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
      const apiKeyEnvOut = envMatch?.[1] ?? preset?.apiKeyEnv;
      const cfg: ProviderConfig = {
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(apiKeyEnvOut ? { apiKeyEnv: apiKeyEnvOut } : {}),
        models: [{ id: modelId }],
      };
      await saveProviderToUserFile(provider, cfg, { makeDefault: Boolean(body.makeDefault) });
      cachedModelsFile = await loadModelsFile(WORKSPACE_CWD).catch(() => cachedModelsFile);
    }
    const adapter = cachedModelsFile.providers?.[provider]
      ? await createAdapterFor(cachedModelsFile, provider, modelId, { baseUrl, apiKey }, logger)
      : createOpenAIAdapter({
          provider,
          modelId,
          baseUrl,
          apiKey,
          contextWindow: 128_000,
          maxOutputTokens: 4_000,
          logger,
        });
    await activeSession.setModel(adapter);
    const auth = await loadAuth();
    return sendJson(res, 200, {
      ok: true,
      model: activeSession.modelInfo(),
      loggedInProviders: Object.keys(auth),
    });
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    const body = await readJsonBody(req);
    const auth = await loadAuth();
    const all = Boolean(body.all);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!all && !provider) {
      return sendJson(res, 400, { error: "provider or all=true is required" });
    }
    const targets = all ? Object.keys(auth) : [provider];
    const loggedOut: string[] = [];
    for (const p of targets) {
      if (auth[p]) {
        await clearAuthKey(p);
        loggedOut.push(p);
      }
    }
    const remaining = await loadAuth();
    return sendJson(res, 200, {
      ok: true,
      loggedOut,
      loggedInProviders: Object.keys(remaining),
    });
  }

  if (method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return sendJson(res, 400, { error: "Prompt text is required" });
    }
    if (activeSession.isBusy()) {
      return sendJson(res, 409, { error: "Session is busy" });
    }
    await activeSession.prompt(text);
    return sendJson(res, 200, { ok: true, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/tool") {
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return sendJson(res, 400, { error: "Tool name is required" });
    const result = await activeSession.callToolAsUser(name, body.args ?? {});
    return sendJson(res, 200, { ok: true, result });
  }

  if (method === "POST" && url.pathname === "/api/approval") {
    const body = await readJsonBody(req);
    const id = typeof body.id === "string" ? body.id : "";
    const decision = body.decision;
    const pending = pendingApprovals.get(id);
    if (!pending) return sendJson(res, 404, { error: "Approval request not found or expired" });
    clearTimeout(pending.timer);
    pendingApprovals.delete(id);
    const resolved: boolean | "session" =
      decision === "session" ? "session" : decision === "once" || decision === true ? true : false;
    pending.resolve(resolved);
    broadcast("approval_resolved", { id, decision: resolved });
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/session/new") {
    if (!activeSession.newSession) {
      return sendJson(res, 501, { error: "newSession unavailable" });
    }
    const created = await activeSession.newSession();
    await activeSession.subagents?.dispose().catch(() => {});
    await activeSession.connects?.dispose().catch(() => {});
    activeSession.dispose();
    activeSession = created.session;
    activeManager = created.manager;
    attachSessionEvents(activeSession);
    return sendJson(res, 200, { ok: true, snapshot: sessionSnapshot() });
  }

  if (method === "POST" && url.pathname === "/api/session/compact") {
    const body = await readJsonBody(req);
    const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
    const result = await activeSession.compact(instructions);
    return sendJson(res, 200, { ok: true, result });
  }

  if (method === "POST" && url.pathname === "/api/session/mode") {
    const body = await readJsonBody(req);
    if (
      body.safetyMode === "strict" ||
      body.safetyMode === "balanced" ||
      body.safetyMode === "restricted" ||
      body.safetyMode === "autonomous"
    ) {
      activeSession.setSafetyMode(body.safetyMode);
    }
    if (
      body.approvalMode === "ask" ||
      body.approvalMode === "never" ||
      body.approvalMode === "auto-allowlist"
    ) {
      activeSession.setApprovalMode(body.approvalMode);
    }
    if (
      body.thinkingLevel === "off" ||
      body.thinkingLevel === "low" ||
      body.thinkingLevel === "medium" ||
      body.thinkingLevel === "high"
    ) {
      await activeSession.setThinkingLevel(body.thinkingLevel as ThinkingLevel);
    }
    return sendJson(res, 200, { ok: true, snapshot: sessionSnapshot() });
  }

  sendJson(res, 404, { error: "Not found" });
}

await initSession();

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    logger.error("http_request_error", {
      message: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } else {
      res.end();
    }
  });
});

server.on("error", (err) => {
  logger.error("http_server_error", {
    port: PORT,
    message: err instanceof Error ? err.message : String(err),
  });
  process.stderr.write(`Kern web server failed on ${HOST}:${PORT}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Kern web workbench listening on http://${HOST}:${PORT}\n`);
});

let shuttingDown = false;
async function shutdownServer() {
  if (shuttingDown) return;
  shuttingDown = true;
  await activeSession?.subagents?.dispose().catch(() => {});
  await activeSession?.connects?.dispose().catch(() => {});
  activeSession?.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once("SIGINT", () => { void shutdownServer(); });
process.once("SIGTERM", () => { void shutdownServer(); });
