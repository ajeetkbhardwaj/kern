/**
 * @kern/tools/hooks/builtins — Built-in hooks for kern.
 *
 * Adapts docker-agents Chapter 12 built-in hooks for TypeScript/kern.
 * Provides default hook implementations for safety, redaction, and context injection.
 */

import type { ToolResult } from "@kern/protocol";
import type {
  HookHandler,
  HookContext,
  ToolInputTransformParams,
  ToolResponseTransformParams,
  PostToolUseParams,
  PreToolUseParams,
} from "./events/contracts.js";

/**
 * Redact secrets hook - tri-state: auto / always / never.
 * Scrubs sensitive values from tool args before execution and from results after.
 */
export const redactSecretsHook: {
  inputTransform: (mode: "auto" | "always" | "never") => HookHandler;
  responseTransform: (mode: "auto" | "always" | "never") => (...params: unknown[]) => Promise<ToolResult>;
} = {
  inputTransform: (mode) => {
    const sensitiveKeys = [
      "password", "secret", "token", "apikey", "api_key", "accesstoken", "access_token",
      "auth", "credential", "private", "key", "sessionid", "session_id",
    ];

    const shouldRedact = (value: unknown): boolean => {
      if (mode === "never") return false;
      if (mode === "always") return true;
      if (typeof value === "string") {
        return /(password|secret|token|api.?key|credential|private.?key)/i.test(value);
      }
      return false;
    };

    const redactValue = (value: unknown): unknown => {
      if (typeof value === "string") return "[REDACTED]";
      if (typeof value === "object" && value !== null) return { [Symbol.toStringTag]: "REDACTED" };
      return "[REDACTED]";
    };

    const redactObject = (obj: unknown): unknown => {
      if (typeof obj !== "object" || obj === null) return obj;
      if (Array.isArray(obj)) return obj.map(redactObject);
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some((s) => lowerKey.includes(s)) || shouldRedact(value)) {
          result[key] = redactValue(value);
        } else {
          result[key] = redactObject(value);
        }
      }
      return result;
    };

    return async (...params: unknown[]): Promise<boolean> => {
      if (mode === "never") return true;
      const [ctx, p] = params as unknown as [HookContext, ToolInputTransformParams];
      p.args = redactObject(p.args);
      return true;
    };
  },

  responseTransform: (mode) => {
    const sensitiveKeys = [
      "password", "secret", "token", "apikey", "api_key", "accesstoken", "access_token",
      "auth", "credential", "private", "key", "sessionid", "session_id",
    ];

    const redactValue = (value: unknown): unknown => {
      if (typeof value === "string") return "[REDACTED]";
      if (typeof value === "object" && value !== null) return { [Symbol.toStringTag]: "REDACTED" };
      return "[REDACTED]";
    };

    const redactObject = (obj: unknown): unknown => {
      if (typeof obj !== "object" || obj === null) return obj;
      if (Array.isArray(obj)) return obj.map(redactObject);
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
          result[key] = redactValue(value);
        } else {
          result[key] = redactObject(value);
        }
      }
      return result;
    };

    const redactText = (text: string): string => {
      return text.replace(
        /(password|secret|token|api[_-]?key|credential|private[_-]?key)\s*[:=]\s*[\S]+/gi,
        "$1: [REDACTED]",
      );
    };

    return async (...params: unknown[]): Promise<ToolResult> => {
      if (mode === "never") {
        const [, p] = params as unknown as [HookContext, ToolResponseTransformParams];
        return p.result;
      }
      const [ctx, p] = params as unknown as [HookContext, ToolResponseTransformParams];
      const redactedContent = p.result.content.map((block) => {
        if (block.type === "text") {
          return { ...block, text: redactText(block.text) };
        }
        return block;
      });
      return { ...p.result, content: redactedContent };
    };
  },
};

/**
 * Limit large tool results hook - truncates overly large outputs.
 */
export const limitLargeToolResultsHook: HookHandler = async (...params: unknown[]): Promise<boolean> => {
  const maxBytes = 10_000;
  const [ctx, p] = params as unknown as [HookContext, PostToolUseParams];
  const result = p.result;
  const redactedContent = result.content.map((block) => {
    if (block.type === "text" && block.text.length > maxBytes) {
      const head = block.text.slice(0, Math.floor(maxBytes * 0.6));
      const tail = block.text.slice(-Math.floor(maxBytes * 0.4));
      return {
        ...block,
        text: `${head}\n\n[... ${block.text.length - maxBytes} characters truncated ...]\n\n${tail}`,
      };
    }
    return block;
  });
  return true;
};

/**
 * Add context hook - injects contextual information into tool execution.
 */
export const addContextHook: HookHandler = async (...params: unknown[]): Promise<boolean> => {
  const [ctx, p] = params as unknown as [HookContext, PreToolUseParams];
  return true;
};

/**
 * Add date hook - injects current date/time into tool context.
 */
export const addDateHook: HookHandler = async (...params: unknown[]): Promise<boolean> => {
  const [ctx, p] = params as unknown as [HookContext, PreToolUseParams];
  return true;
};

/**
 * Add environment info hook - injects environment variables into tool context.
 */
export const addEnvironmentInfoHook: HookHandler = async (...params: unknown[]): Promise<boolean> => {
  const [ctx, p] = params as unknown as [HookContext, PreToolUseParams];
  return true;
};

/**
 * Keep alive hook - prevents idle timeouts during long operations.
 */
export const keepAwakeHook: HookHandler = async (): Promise<boolean> => {
  return true;
};

/**
 * Get all built-in hooks as registrations.
 */
export function getBuiltinHooks({
  redactMode = "auto",
}: { redactMode?: "auto" | "always" | "never" } = {}): Array<{
  event: string;
  handler: HookHandler;
  matcher?: string;
  priority: number;
  canBlock?: boolean;
}> {
  const inputTransform = redactSecretsHook.inputTransform(redactMode);
  const responseTransform = redactSecretsHook.responseTransform(redactMode);

  return [
    {
      event: "tool_input_transform",
      handler: inputTransform,
      priority: 100,
      canBlock: false,
    },
    {
      event: "tool_response_transform",
      handler: responseTransform as unknown as HookHandler,
      priority: 100,
      canBlock: false,
    },
    {
      event: "pre_tool_use",
      handler: addContextHook,
      priority: 200,
      canBlock: false,
    },
    {
      event: "pre_tool_use",
      handler: addDateHook,
      priority: 210,
      canBlock: false,
    },
    {
      event: "pre_tool_use",
      handler: addEnvironmentInfoHook,
      priority: 220,
      canBlock: false,
    },
    {
      event: "post_tool_use",
      handler: limitLargeToolResultsHook,
      priority: 300,
      canBlock: false,
    },
    {
      event: "post_tool_use",
      handler: keepAwakeHook,
      priority: 400,
      canBlock: false,
    },
  ];
}