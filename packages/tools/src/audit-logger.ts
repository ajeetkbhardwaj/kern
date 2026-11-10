/**
 * Audit logging for tool execution.
 * Provides structured logging of tool invocations, policy decisions, and results.
 */

import type { ToolResult, PolicyDecision, PolicyInput, SideEffect } from "@kern/protocol";
import { createLogger } from "@kern/protocol";

export interface ToolAuditEntry {
  timestamp: string;
  toolName: string;
  arguments: unknown;
  origin: PolicyInput["origin"];
  sideEffect?: SideEffect;
  policyDecision: PolicyDecision;
  result: ToolResult;
  durationMs: number;
  workspaceRoot: string;
  sessionId?: string;
  userId?: string;
}

export interface AuditLoggerOptions {
  /** Minimum level to log */
  level?: "all" | "write" | "execute" | "denied" | "errors";
  /** Custom logger instance */
  logger?: ReturnType<typeof createLogger>;
  /** Redact sensitive data from arguments */
  redactSensitive?: boolean;
  /** Maximum argument size to log (bytes) */
  maxArgSize?: number;
  /** Callback for each audit entry (for external sinks) */
  onEntry?: (entry: ToolAuditEntry) => void | Promise<void>;
}

const DEFAULT_OPTIONS: Required<AuditLoggerOptions> = {
  level: "all",
  logger: createLogger("warn"),
  redactSensitive: true,
  maxArgSize: 10_000,
  onEntry: (_entry: ToolAuditEntry) => undefined,
};

const SENSITIVE_KEYS = [
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "auth",
  "credential",
  "private",
  "key",
];

function redactArgs(args: unknown, maxSize: number): unknown {
  if (args === null || args === undefined) return args;

  const str = JSON.stringify(args);
  if (str.length > maxSize) {
    return `[REDACTED: ${str.length} bytes, exceeds max ${maxSize}]`;
  }

  try {
    const parsed = JSON.parse(str);
    return redactObject(parsed);
  } catch {
    return `[REDACTED: invalid JSON]`;
  }
}

function redactObject(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => lowerKey.includes(s))) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactObject(value);
    }
  }
  return result;
}

function shouldLog(level: string, sideEffect?: SideEffect, policyDecision?: PolicyDecision, result?: ToolResult): boolean {
  switch (level) {
    case "all":
      return true;
    case "write":
      return sideEffect === "write" || sideEffect === "execute" || sideEffect === "network";
    case "execute":
      return sideEffect === "execute" || sideEffect === "network";
    case "denied":
      return policyDecision?.decision === "deny" || policyDecision?.decision === "require_approval" || result?.isError === true;
    case "errors":
      return result?.isError === true;
    default:
      return true;
  }
}

/**
 * Creates an audit logger for tool execution.
 * Logs tool invocations, policy decisions, and results in a structured format.
 */
export function createAuditLogger(options: AuditLoggerOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = opts.logger;

  return {
    /**
     * Log a tool execution audit entry.
     */
    async log(entry: Omit<ToolAuditEntry, "timestamp">): Promise<void> {
      const fullEntry: ToolAuditEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
      };

      // Redact sensitive data if enabled
      if (opts.redactSensitive) {
        fullEntry.arguments = redactArgs(fullEntry.arguments, opts.maxArgSize);
      }

      // Check if we should log based on level
      if (!shouldLog(opts.level, fullEntry.sideEffect, fullEntry.policyDecision, fullEntry.result)) {
        return;
      }

      // Log using the structured logger
      const logLevel = fullEntry.result.isError ? "error" : fullEntry.policyDecision.decision === "deny" ? "warn" : "info";
      (logger as any)[logLevel]?.("tool_audit", {
        tool: fullEntry.toolName,
        origin: fullEntry.origin,
        sideEffect: fullEntry.sideEffect,
        policy: fullEntry.policyDecision.decision,
        policyReason: fullEntry.policyDecision.decision !== "allow" ? (fullEntry.policyDecision as any).reason ?? (fullEntry.policyDecision as any).prompt : undefined,
        durationMs: fullEntry.durationMs,
        error: fullEntry.result.isError,
        workspaceRoot: fullEntry.workspaceRoot,
        sessionId: fullEntry.sessionId,
        userId: fullEntry.userId,
        // Arguments are logged at debug level to avoid leaking sensitive data
        arguments: fullEntry.arguments,
      });

      // Call external callback if provided
      if (opts.onEntry) {
        try {
          await opts.onEntry(fullEntry);
        } catch (error) {
          logger.error("audit_callback_error", { error: String(error) });
        }
      }
    },

    /**
     * Log a policy decision without full execution context.
     */
    async logPolicy(input: PolicyInput, decision: PolicyDecision): Promise<void> {
      await this.log({
        toolName: input.toolName,
        arguments: input.arguments,
        origin: input.origin,
        sideEffect: input.sideEffect,
        policyDecision: decision,
        result: { content: [], isError: decision.decision !== "allow", details: {} },
        durationMs: 0,
        workspaceRoot: input.cwd,
      });
    },

    /**
     * Get the underlying logger for custom use.
     */
    getLogger() {
      return logger;
    },
  };
}

export type AuditLogger = ReturnType<typeof createAuditLogger>;