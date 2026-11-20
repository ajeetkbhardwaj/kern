import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolDefinition, ToolResult } from "@kern/protocol";
import { boundText, textResult } from "@kern/protocol";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Block loopback, private, link-local, CGNAT, and unspecified IP ranges (SSRF protection). */
export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    const b0 = (n >>> 24) & 0xff;
    const b1 = (n >>> 16) & 0xff;
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 127) return true; // 127.0.0.0/8
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10
    if (b0 >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("::ffff:")) {
      return isBlockedIp(ip.slice("::ffff:".length));
    }
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA fc00::/7
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // fe80::/10
    if (ip.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${url.protocol}": only http and https are allowed`);
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Blocked host "${host}" (local/private addresses are disallowed)`);
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error(`Blocked IP address "${host}" (private/loopback/link-local addresses are disallowed)`);
    }
    return url;
  }
  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) {
    throw new Error(`Could not resolve host "${host}"`);
  }
  for (const addr of resolved) {
    if (isBlockedIp(addr.address)) {
      throw new Error(`Blocked host "${host}" (resolves to private/local address ${addr.address})`);
    }
  }
  return url;
}

export function htmlToReadableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:p|div|section|article|header|footer|main|nav|h[1-6]|li|tr|blockquote|pre|br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface WebFetchArgs {
  url: string;
  raw?: boolean;
  timeoutMs?: number;
}

export function createWebFetchTool(): ToolDefinition<WebFetchArgs> {
  return {
    name: "web-fetch",
    description: "Fetch an HTTP/HTTPS URL and return readable text (HTML converted to text, JSON formatted, SSRF-protected)",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch" },
        raw: { type: "boolean", default: false, description: "Return raw HTML/body without stripping tags" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 30000, default: DEFAULT_FETCH_TIMEOUT_MS },
      },
      required: ["url"],
    },
    sideEffect: "network",
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const timeoutMs = Math.max(1000, Math.min(30_000, args.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (ctx.signal.aborted) return textResult("web-fetch aborted", true, { code: "E_CANCELLED" });
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      try {
        let currentUrl = await assertSafeUrl(args.url);
        let response: Response | null = null;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          response = await fetch(currentUrl.toString(), {
            method: "GET",
            redirect: "manual",
            signal: ctrl.signal,
            headers: {
              "user-agent": "kern-coding-agent/1.0",
              accept: "text/markdown, text/plain, application/json, text/html;q=0.9, */*;q=0.5",
            },
          });
          if (response.status >= 300 && response.status < 400) {
            const loc = response.headers.get("location");
            if (!loc) break;
            if (hop === MAX_REDIRECTS) {
              return textResult(`Too many redirects (>${MAX_REDIRECTS}) fetching ${args.url}`, true, { code: "E_TOOL_FAILED" });
            }
            const next = new URL(loc, currentUrl).toString();
            currentUrl = await assertSafeUrl(next);
            continue;
          }
          break;
        }
        if (!response) {
          return textResult(`No response fetching ${args.url}`, true, { code: "E_TOOL_FAILED" });
        }

        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let downloadTruncated = false;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (total + value.byteLength > MAX_FETCH_BYTES) {
                const keep = MAX_FETCH_BYTES - total;
                if (keep > 0) chunks.push(value.subarray(0, keep));
                downloadTruncated = true;
                await reader.cancel().catch(() => {});
                break;
              }
              chunks.push(value);
              total += value.byteLength;
            }
          }
        }

        const rawBody = Buffer.concat(chunks).toString("utf8");
        const contentType = response.headers.get("content-type") ?? "";
        let formatted = rawBody;
        if (!args.raw) {
          if (contentType.includes("application/json")) {
            try {
              formatted = JSON.stringify(JSON.parse(rawBody), null, 2);
            } catch {
              formatted = rawBody;
            }
          } else if (contentType.includes("text/html") || /^\s*<!doctype\s+html/i.test(rawBody) || /^\s*<html\b/i.test(rawBody)) {
            formatted = htmlToReadableText(rawBody);
          }
        }

        const bounded = boundText(formatted);
        const header = `HTTP ${response.status} ${response.statusText} — ${currentUrl.toString()}${contentType ? ` (${contentType.split(";")[0]?.trim()})` : ""}`;
        const bodyText = bounded.text ? `${header}\n\n${bounded.text}` : `${header}\n\n(empty body)`;
        return {
          content: [{ type: "text", text: bodyText }],
          isError: !response.ok,
          details: {
            url: currentUrl.toString(),
            status: response.status,
            contentType,
            truncated: bounded.truncated || downloadTruncated,
          },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isPolicy = msg.startsWith("Blocked ");
        return textResult(msg, true, { code: isPolicy ? "E_TOOL_DENIED" : "E_TOOL_FAILED" });
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
