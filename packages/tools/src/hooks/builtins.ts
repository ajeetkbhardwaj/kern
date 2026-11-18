/**
 * @kern/tools/hooks/builtins — Built-in hooks for kern.
 *
 * Provides working default hooks for secret scrubbing and tool output truncation.
 */

import type { ToolResult } from "@kern/protocol";
import type {
  HookRegistration,
  TransformHookHandler,
  HookContext,
  ToolInputTransformParams,
  ToolResponseTransformParams,
} from "./events/contracts.js";

const SENSITIVE_KEYS = [
  "password", "secret", "token", "apikey", "api_key", "accesstoken", "access_token",
  "auth", "credential", "private", "sessionid", "session_id",
];

const SECRET_TEXT_REGEX =
  /(password|secret|token|api[_-]?key|credential|private[_-]?key)\s*[:=]\s*[\S]+/gi;

const TOKEN_VALUE_REGEX = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g;

function scrubText(text: string): string {
  return text
    .replace(SECRET_TEXT_REGEX, "$1: [REDACTED]")
    .replace(TOKEN_VALUE_REGEX, "[REDACTED]");
}

function redactObject(obj: unknown, mode: "auto" | "always" | "never"): unknown {
  if (mode === "never" || obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    if (mode === "always") return "[REDACTED]";
    return scrubText(obj);
  }
  if (Array.isArray(obj)) return obj.map((item) => redactObject(item, mode));
  if (typeof obj !== "object") return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => lowerKey.includes(s))) {
      result[key] = typeof value === "string" ? "[REDACTED]" : value;
    } else {
      result[key] = redactObject(value, mode);
    }
  }
  return result;
}

/**
 * Redact secrets hook - tri-state: auto / always / never.
 * Follows the HookExecutor.runTransform `[ctx, params]` return contract.
 */
export const redactSecretsHook: {
  inputTransform: (mode: "auto" | "always" | "never") => TransformHookHandler;
  responseTransform: (mode: "auto" | "always" | "never") => TransformHookHandler;
} = {
  inputTransform: (mode) => {
    return async (...params: unknown[]): Promise<unknown[] | void> => {
      if (mode === "never") return params;
      const [ctx, p] = params as [HookContext, ToolInputTransformParams];
      if (!p || typeof p !== "object") return params;
      const nextArgs = redactObject(p.args, mode);
      return [ctx, { ...p, args: nextArgs }];
    };
  },

  responseTransform: (mode) => {
    return async (...params: unknown[]): Promise<unknown[] | void> => {
      if (mode === "never") return params;
      const [ctx, p] = params as [HookContext, ToolResponseTransformParams];
      if (!p || typeof p !== "object" || !p.result) return params;
      let changed = false;
      const redactedContent = p.result.content.map((block) => {
        if (block.type !== "text") return block;
        const scrubbed = scrubText(block.text);
        if (scrubbed !== block.text) changed = true;
        return scrubbed === block.text ? block : { ...block, text: scrubbed };
      });
      if (!changed) return params;
      const nextResult: ToolResult = { ...p.result, content: redactedContent };
      return [ctx, { ...p, result: nextResult }];
    };
  },
};

/**
 * Limit large tool results hook - middle-out truncates oversized outputs via `tool_response_transform`.
 */
export function createLimitLargeToolResultsHook(maxChars = 30_000): TransformHookHandler {
  const limit = Math.max(0, Math.floor(maxChars));
  return async (...params: unknown[]): Promise<unknown[] | void> => {
    const [ctx, p] = params as [HookContext, ToolResponseTransformParams];
    if (!p || typeof p !== "object" || !p.result) return params;
    let changed = false;
    const truncatedContent = p.result.content.map((block) => {
      if (block.type === "text" && block.text.length > limit) {
        changed = true;
        const headLen = Math.floor(limit * 0.6);
        const tailLen = limit - headLen;
        const head = headLen > 0 ? block.text.slice(0, headLen) : "";
        const tail = tailLen > 0 ? block.text.slice(-tailLen) : "";
        return {
          ...block,
          text: `${head}\n\n[... ${block.text.length - limit} characters truncated ...]\n\n${tail}`,
        };
      }
      return block;
    });
    if (!changed) return params;
    return [
      ctx,
      {
        ...p,
        result: {
          ...p.result,
          content: truncatedContent,
          details: { ...(p.result.details ?? {}), truncated: true },
        },
      },
    ];
  };
}

export const limitLargeToolResultsHook: TransformHookHandler = createLimitLargeToolResultsHook(30_000);

import { registerBuiltinHandler } from "./config-loader.js";

/**
 * Get all built-in hooks as registrations.
 */
export function getBuiltinHooks({
  redactMode = "auto",
  maxResultChars = 30_000,
}: { redactMode?: "auto" | "always" | "never"; maxResultChars?: number } = {}): HookRegistration[] {
  const inputTransform = redactSecretsHook.inputTransform(redactMode);
  const responseTransform = redactSecretsHook.responseTransform(redactMode);
  const limitHook = createLimitLargeToolResultsHook(maxResultChars);

  return [
    {
      event: "tool_input_transform",
      handler: inputTransform,
      priority: 100,
      canBlock: false,
    },
    {
      event: "tool_response_transform",
      handler: responseTransform,
      priority: 100,
      canBlock: false,
    },
    {
      event: "tool_response_transform",
      handler: limitHook,
      priority: 200,
      canBlock: false,
    },
  ];
}

/**
 * Safe default session hooks: scrubs secrets from tool responses and caps oversized outputs.
 * Keeps `tool_input_transform` opt-in so code writes/edits containing variable names like `token=` are untouched.
 */
export function getDefaultSessionHooks({
  redactMode = "auto",
  maxResultChars = 30_000,
}: { redactMode?: "auto" | "always" | "never"; maxResultChars?: number } = {}): HookRegistration[] {
  return [
    {
      event: "tool_response_transform",
      handler: redactSecretsHook.responseTransform(redactMode),
      priority: 100,
      canBlock: false,
    },
    {
      event: "tool_response_transform",
      handler: createLimitLargeToolResultsHook(maxResultChars),
      priority: 200,
      canBlock: false,
    },
  ];
}

/**
 * Register built-in handler names so `.kern/hooks.yaml` / `hooks.d/*.yaml` can reference them.
 */
export function registerDefaultBuiltinHandlers(): void {
  registerBuiltinHandler("redact_secrets_input", (...params) => redactSecretsHook.inputTransform("auto")(...params));
  registerBuiltinHandler("redact_secrets_response", (...params) => redactSecretsHook.responseTransform("auto")(...params));
  registerBuiltinHandler("limit_large_tool_results", (...params) => limitLargeToolResultsHook(...params));
}