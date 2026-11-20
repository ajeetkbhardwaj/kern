import { boundText, redact, textResult, type ToolResult } from "@kern/protocol";
import type { A2ASkillInfo } from "./types.js";

export interface A2AAgentCard {
  name?: string;
  description?: string;
  url?: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  skills?: Array<{
    id?: string;
    name?: string;
    description?: string;
  }>;
}

export interface A2ATaskPart {
  kind?: string;
  type?: string;
  text?: string;
  data?: unknown;
  file?: { name?: string; mimeType?: string; uri?: string };
}

export interface A2ATaskResponse {
  id?: string;
  contextId?: string;
  status?: {
    state?: string;
    message?: { parts?: A2ATaskPart[] };
  };
  artifacts?: Array<{
    name?: string;
    parts?: A2ATaskPart[];
  }>;
  parts?: A2ATaskPart[];
  kind?: string;
}

/** Discover an A2A server's Agent Card (`/.well-known/agent-card.json` then `/.well-known/agent.json`). */
export async function discoverA2ACard(
  baseUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<{ card: A2AAgentCard; skills: A2ASkillInfo[] }> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const candidates = [`${cleanBase}/.well-known/agent-card.json`, `${cleanBase}/.well-known/agent.json`];
  let lastStatus = 0;

  for (const cardUrl of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetch(cardUrl, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        lastStatus = res.status;
        if (res.status === 401 || res.status === 403) {
          throw new Error(`A2A card auth failed (HTTP ${res.status}) at ${cardUrl}`);
        }
        continue;
      }
      const card = (await res.json()) as A2AAgentCard;
      const skills: A2ASkillInfo[] = (card.skills ?? [])
        .filter((s) => typeof s?.name === "string" || typeof s?.id === "string")
        .map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          name: s.name || s.id || "skill",
          ...(s.description ? { description: s.description } : {}),
        }));
      return { card, skills };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Unable to fetch A2A agent card from ${cleanBase} (HTTP ${lastStatus || "unreachable"})`);
}

function extractPartsText(parts: A2ATaskPart[] | undefined): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string" && p.text.trim()) {
      out.push(p.text.trim());
    } else if (p.data !== undefined) {
      out.push(JSON.stringify(p.data, null, 2));
    } else if (p.file?.uri) {
      out.push(`[file: ${p.file.name ?? p.file.uri}]`);
    }
  }
  return out;
}

function formatA2ATaskResult(task: A2ATaskResponse): { text: string; isError: boolean; terminalState: string } {
  const state = task.status?.state ?? (task.kind === "message" ? "completed" : "completed");
  const chunks: string[] = [];
  chunks.push(...extractPartsText(task.status?.message?.parts));
  chunks.push(...extractPartsText(task.parts));
  for (const art of task.artifacts ?? []) {
    const artParts = extractPartsText(art.parts);
    if (artParts.length > 0) {
      chunks.push(art.name ? `[artifact: ${art.name}]\n${artParts.join("\n")}` : artParts.join("\n"));
    }
  }
  const body = chunks.join("\n\n").trim();
  if (state === "input-required") {
    return {
      text: `[A2A agent requested additional input${task.id ? ` (taskId=${task.id})` : ""}]:\n${body || "(no question text provided)"}`,
      isError: false,
      terminalState: state,
    };
  }
  const failed = state === "failed" || state === "canceled" || state === "rejected";
  return {
    text: body || `(A2A task finished with state=${state})`,
    isError: failed,
    terminalState: state,
  };
}

async function postA2ARpc(
  rpcUrl: string,
  method: string,
  params: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (signal?.aborted) throw new Error(`A2A ${method} aborted`);
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `kern-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        method,
        params,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`A2A HTTP ${res.status} on ${method}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
    }
    const payload = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (payload.error) {
      throw new Error(payload.error.message ?? `A2A RPC error (${payload.error.code ?? "unknown"})`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Invoke a remote A2A agent via JSON-RPC `message/send`, polling `tasks/get` while
 * submitted/working and emitting `tasks/cancel` on abort/timeout.
 */
export async function invokeA2AAgent(opts: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  prompt: string;
  taskId?: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}): Promise<ToolResult> {
  const headers = opts.headers ?? {};
  let rpcUrl = opts.url.replace(/\/+$/, "");

  // Resolve RPC endpoint from agent card if present, best-effort
  try {
    const { card } = await discoverA2ACard(rpcUrl, headers, Math.min(opts.timeoutMs, 8_000));
    if (card.url && /^https?:\/\//i.test(card.url)) {
      rpcUrl = card.url.replace(/\/+$/, "");
    }
  } catch {
    /* Fall back directly to configured URL */
  }

  const deadline = Date.now() + opts.timeoutMs;
  const messageId = `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const sendParams = {
    message: {
      role: "user",
      messageId,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      parts: [{ kind: "text", text: opts.prompt }],
    },
  };

  opts.onProgress?.(`dispatching A2A task to ${rpcUrl}`);
  let task = (await postA2ARpc(rpcUrl, "message/send", sendParams, headers, opts.timeoutMs, opts.signal)) as A2ATaskResponse;

  // Poll `tasks/get` if remote agent executes asynchronously
  while (
    task?.id &&
    (task.status?.state === "submitted" || task.status?.state === "working")
  ) {
    if (opts.signal?.aborted) {
      await postA2ARpc(rpcUrl, "tasks/cancel", { id: task.id }, headers, 3_000).catch(() => {});
      return textResult("A2A task aborted", true, { code: "E_CANCELLED" });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await postA2ARpc(rpcUrl, "tasks/cancel", { id: task.id }, headers, 3_000).catch(() => {});
      return textResult(`A2A task timed out after ${opts.timeoutMs}ms`, true, { code: "E_TIMEOUT" });
    }
    opts.onProgress?.(`A2A task ${task.id}: ${task.status.state}`);
    await new Promise<void>((r) => {
      const waitMs = Math.min(400, remaining);
      const onAbort = () => {
        clearTimeout(timer);
        r();
      };
      const timer = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        r();
      }, waitMs);
      if (typeof timer.unref === "function") timer.unref();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (opts.signal?.aborted) {
      await postA2ARpc(rpcUrl, "tasks/cancel", { id: task.id }, headers, 3_000).catch(() => {});
      return textResult("A2A task aborted", true, { code: "E_CANCELLED" });
    }
    try {
      task = (await postA2ARpc(
        rpcUrl,
        "tasks/get",
        { id: task.id },
        headers,
        Math.max(1_000, deadline - Date.now()),
        opts.signal,
      )) as A2ATaskResponse;
    } catch (err) {
      if (opts.signal?.aborted) {
        await postA2ARpc(rpcUrl, "tasks/cancel", { id: task.id }, headers, 3_000).catch(() => {});
        return textResult("A2A task aborted", true, { code: "E_CANCELLED" });
      }
      throw err;
    }
  }

  const formatted = formatA2ATaskResult(task);
  const bounded = boundText(redact(formatted.text));
  return {
    content: [{ type: "text", text: bounded.text }],
    isError: formatted.isError,
    details: {
      ...(task.id ? { taskId: task.id } : {}),
      state: formatted.terminalState,
      ...(bounded.truncated ? { truncated: true } : {}),
    },
  };
}
