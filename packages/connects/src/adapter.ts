import { createHash } from "node:crypto";
import type { JsonSchema, ToolAnnotations, ToolDefinition, ToolResult } from "@kern/protocol";
import { boundText, redact, textResult } from "@kern/protocol";
import type { McpCallResult, McpContentItem, McpPromptGetResult, McpResourceReadResult, RawMcpTool } from "./transports.js";
import type { McpTransportType } from "./types.js";

function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "item";
}

/**
 * Build a deterministic, LLM-safe tool name (`mcp__<server>__<tool>`),
 * guaranteed <= 64 chars and strictly matching `[a-zA-Z0-9_-]`.
 */
export function makeMcpToolName(serverName: string, toolName: string): string {
  const base = `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
  if (base.length <= 64) return base;
  const suffix = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 6);
  return `${base.slice(0, 57)}_${suffix}`;
}

export function normalizeMcpInputSchema(raw?: JsonSchema): JsonSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  const copy = { ...raw } as JsonSchema;
  if (!copy.type) copy.type = "object";
  if (copy.type === "object" && !copy.properties) copy.properties = {};
  return copy;
}

function formatContentItem(item: McpContentItem): string | null {
  if (!item || typeof item !== "object") return null;
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (item.resource && typeof item.resource === "object") {
    const uri = item.resource.uri ?? "resource";
    if (typeof item.resource.text === "string") {
      return `[${uri}]\n${item.resource.text}`;
    }
    if (typeof item.resource.blob === "string") {
      return `[${uri}: binary ${item.resource.mimeType ?? "application/octet-stream"}, ${item.resource.blob.length} base64 chars]`;
    }
  }
  if (item.type === "resource_link" && item.uri) {
    return `[resource_link: ${item.name ? `${item.name} ` : ""}${item.uri}]`;
  }
  if (item.type === "image" || item.type === "audio") {
    return `[${item.type} content${item.mimeType ? ` (${item.mimeType})` : ""} omitted — binary]`;
  }
  return null;
}

export function formatMcpCallResult(res: McpCallResult): ToolResult {
  const parts: string[] = [];
  if (Array.isArray(res?.content)) {
    for (const item of res.content) {
      const formatted = formatContentItem(item);
      if (formatted) parts.push(formatted);
    }
  }
  if (parts.length === 0 && res?.structuredContent !== undefined) {
    parts.push(JSON.stringify(res.structuredContent, null, 2));
  }
  const raw = parts.join("\n\n") || "(empty MCP tool result)";
  const redacted = redact(raw);
  const bounded = boundText(redacted);
  return {
    content: [{ type: "text", text: bounded.text }],
    isError: res?.isError === true,
    details: bounded.truncated ? { truncated: true } : undefined,
  };
}

export function mcpToolToToolDefinition(params: {
  serverName: string;
  transport: McpTransportType;
  tool: RawMcpTool;
  registeredName: string;
  deferred?: boolean;
  invoke: (args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallResult>;
}): ToolDefinition<Record<string, unknown>> {
  const { serverName, transport, tool, registeredName, deferred, invoke } = params;
  const annotations: ToolAnnotations = {
    openWorldHint: true,
    ...(tool.annotations ?? {}),
  };
  const isReadOnly = annotations.readOnlyHint === true && annotations.destructiveHint !== true;

  return {
    name: registeredName,
    description: `[MCP ${serverName}] ${tool.description?.trim() || tool.name}`,
    inputSchema: normalizeMcpInputSchema(tool.inputSchema),
    sideEffect: isReadOnly ? "read" : transport === "stdio" ? "execute" : "network",
    annotations,
    allowRepeatedCalls: isReadOnly,
    ...(deferred ? { deferred: true } : {}),
    async execute(args, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) {
        return textResult(`${registeredName} aborted`, true, { code: "E_CANCELLED" });
      }
      try {
        const res = await invoke(args ?? {}, ctx.signal);
        return formatMcpCallResult(res);
      } catch (err) {
        return textResult(
          `MCP tool ${serverName}/${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
          { code: "E_TOOL_FAILED", server: serverName, remoteTool: tool.name },
        );
      }
    },
  };
}

export function formatMcpResourceResult(res: McpResourceReadResult): ToolResult {
  const contents = Array.isArray(res?.contents) ? res.contents : [];
  if (contents.length === 0) {
    return { content: [{ type: "text", text: "(empty resource)" }], isError: false };
  }
  const chunks = contents.map((c) => {
    const head = c.uri ? `[${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}]` : "[resource]";
    if (typeof c.text === "string") return `${head}\n${c.text}`;
    if (typeof c.blob === "string") return `${head}\n(binary blob: ${c.blob.length} base64 chars)`;
    return head;
  });
  const bounded = boundText(redact(chunks.join("\n\n")));
  return {
    content: [{ type: "text", text: bounded.text }],
    isError: false,
    details: bounded.truncated ? { truncated: true } : undefined,
  };
}

export function formatMcpPromptResult(res: McpPromptGetResult): ToolResult {
  const msgs = Array.isArray(res?.messages) ? res.messages : [];
  const lines: string[] = [];
  if (res?.description) lines.push(res.description, "");
  for (const m of msgs) {
    const role = m.role ?? "user";
    const items = Array.isArray(m.content) ? m.content : m.content ? [m.content] : [];
    const text = items.map(formatContentItem).filter(Boolean).join("\n") || "(empty)";
    lines.push(`[${role}]\n${text}`);
  }
  const bounded = boundText(redact(lines.join("\n\n") || "(empty prompt)"));
  return {
    content: [{ type: "text", text: bounded.text }],
    isError: false,
    details: bounded.truncated ? { truncated: true } : undefined,
  };
}
