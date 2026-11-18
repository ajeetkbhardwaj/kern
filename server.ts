import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createAgentSession, type AgentSession } from "./packages/coding-agent/src/index.js";
import type { SessionManager } from "./packages/session-store/src/index.js";
import { createLogger, type AgentEvent, type ThinkingLevel } from "./packages/protocol/src/index.js";
import {
  PROVIDER_PRESETS,
  createModelRuntime,
  createOpenAIAdapter,
  discoverModels,
  loadModelsFile,
  resolveFallbackAdapters,
  type ModelsFile,
} from "./packages/model/src/index.js";

const PORT = Number(process.env["PORT"] ?? 3000);
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
  cachedModelsFile = await loadModelsFile(WORKSPACE_CWD);
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
    dialog {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      width: min(440px, 92vw);
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
      <button id="btn-connect">Connect Model</button>
      <button id="btn-compact">Compact</button>
      <button id="btn-new-session">New Session</button>
    </div>
  </header>

  <main>
    <section class="workspace">
      <div id="transcript"></div>
      <div id="approval-bar">
        <div>
          <strong style="color: var(--warn); font-family: var(--mono);">Approval Required</strong>
          <div id="approval-text" style="font-family: var(--mono); font-size: 12px; margin-top: 2px;"></div>
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
        <h3>Tools (click to insert)</h3>
        <div class="tools-grid" id="tools-list"></div>
      </div>
    </aside>
  </main>

  <dialog id="connect-dialog">
    <h3 style="margin-top:0; font-family: var(--mono);">Connect OpenAI-Compatible Provider</h3>
    <form method="dialog" id="connect-form">
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
        <label>API Key (optional for local loopback)</label>
        <input id="cfg-apikey" type="password" placeholder="sk-..." />
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
        <button type="button" id="btn-connect-cancel">Cancel</button>
        <button type="submit" class="primary">Connect</button>
      </div>
    </form>
  </dialog>

  <script>
    const transcriptEl = document.getElementById("transcript");
    const promptForm = document.getElementById("prompt-form");
    const promptInput = document.getElementById("prompt-input");
    const approvalBar = document.getElementById("approval-bar");
    const approvalText = document.getElementById("approval-text");
    const connectDialog = document.getElementById("connect-dialog");

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
          "  /tools                    List registered kernel tools\\n" +
          "  /tool <name> [json-args]  Invoke a kernel tool directly (e.g. /tool read {\\"path\\":\\"README.md\\"})\\n" +
          "  /compact [instructions]   Compact session context\\n" +
          "  /new                      Start a new session\\n" +
          "  <any text>                Send prompt to active model adapter"
        );
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

    document.getElementById("btn-connect").onclick = async () => {
      const res = await fetch("/api/models");
      const data = await res.json();
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
      connectDialog.showModal();
    };

    document.getElementById("btn-connect-cancel").onclick = () => connectDialog.close();
    document.getElementById("connect-form").onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        provider: document.getElementById("cfg-provider").value.trim(),
        baseUrl: document.getElementById("cfg-baseurl").value.trim(),
        modelId: document.getElementById("cfg-model").value.trim(),
        apiKey: document.getElementById("cfg-apikey").value.trim() || undefined,
      };
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        addEntry("error", "connect", data.error || "Failed to connect model");
      } else {
        addEntry("system", "model", "Connected " + data.model.provider + "/" + data.model.modelId);
      }
      connectDialog.close();
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

  if (method === "POST" && url.pathname === "/api/connect") {
    const body = await readJsonBody(req);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    if (!provider || !baseUrl || !modelId) {
      return sendJson(res, 400, { error: "provider, baseUrl, and modelId are required" });
    }
    const adapter = createOpenAIAdapter({
      provider,
      modelId,
      baseUrl,
      apiKey,
      contextWindow: 128_000,
      maxOutputTokens: 4_000,
      logger,
    });
    await activeSession.setModel(adapter);
    return sendJson(res, 200, { ok: true, model: activeSession.modelInfo() });
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

server.listen(PORT, HOST, () => {
  process.stdout.write(`Kern web workbench listening on http://${HOST}:${PORT}\n`);
});
