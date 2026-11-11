import type {
  JsonSchema,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ModelToolSchema,
  SideEffect,
  PolicyDecision,
  PolicyInput,
  ToolPolicyEngine,
} from "@kern/protocol";
import { boundText, defaultModelSchema, textResult } from "@kern/protocol";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DefaultPolicy } from "./policy.js";
import { safeResolveSync } from "./path-safety.js";
import { validateArgs } from "./validate-args.js";
import { spawnSandboxed, type SandboxOptions, DEFAULT_SANDBOX_OPTIONS, NO_SANDBOX_OPTIONS } from "./bash-sandbox.js";
import { createAuditLogger, type AuditLogger, type ToolAuditEntry } from "./audit-logger.js";
import { HookExecutor } from "./hooks/executor.js";
import type { HookContext, ToolInputTransformParams, ToolResponseTransformParams, PostToolUseParams, PreToolUseParams, ToolGuardParams } from "./hooks/events/contracts.js";

export { AllowAllPolicy } from "./policy.js";

/** Hard cap on single write payload. */
const MAX_WRITE_BYTES = 500_000;
/** Stop accumulating subprocess output past this; result is marked truncated. */
const MAX_CAPTURE_BYTES = 1_000_000;

export interface ToolRegistryOptions {
  policy?: ToolPolicyEngine;
  workspaceRoot: string;
  /** Registry-level timeout per tool call. Aborts the tool's signal. */
  maxToolMs?: number;
  /** Fallback approval handler when policy demands approval. */
  requestApproval?: (prompt: string, meta?: ApprovalMeta) => Promise<boolean | "session">;
  /** Optional audit logger for tool execution tracking. */
  auditLogger?: AuditLogger;
  /** Session ID for audit context. */
  sessionId?: string;
  /** User ID for audit context. */
  userId?: string;
  /** Optional hook executor for lifecycle interception. */
  hookExecutor?: HookExecutor;
}

export interface ApprovalMeta {
  toolName: string;
  origin: string;
}

export interface ExecuteOptions {
  origin?: PolicyInput["origin"];
  requestApproval?: (prompt: string, meta?: ApprovalMeta) => Promise<boolean | "session">;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private policy: ToolPolicyEngine;
  private workspaceRoot: string;
  private maxToolMs: number;
  private requestApproval?: (prompt: string, meta?: ApprovalMeta) => Promise<boolean | "session">;
  private auditLogger?: AuditLogger;
  private sessionId?: string;
  private userId?: string;
  private hookExecutor?: HookExecutor;

  constructor(options: ToolRegistryOptions) {
    this.policy = options.policy ?? new DefaultPolicy();
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxToolMs = options.maxToolMs ?? 120_000;
    if (options.requestApproval !== undefined) this.requestApproval = options.requestApproval;
    if (options.auditLogger !== undefined) this.auditLogger = options.auditLogger;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.hookExecutor !== undefined) this.hookExecutor = options.hookExecutor;
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Direct tool invocation for TUI shell mode etc. Same pipeline as model calls. */
  async callTool(
    name: string,
    args: unknown,
    opts: ExecuteOptions & { signal?: AbortSignal; origin?: PolicyInput["origin"] } = {},
  ): Promise<ToolResult> {
    return this.execute(name, args, opts.signal ?? new AbortController().signal, opts);
  }

  /** Mutate the policy when it is a DefaultPolicy (no-op otherwise). */
  configurePolicy(mutator: (policy: DefaultPolicy) => void): boolean {
    if (this.policy instanceof DefaultPolicy) {
      mutator(this.policy);
      return true;
    }
    return false;
  }

  listModelSchemas(): ModelToolSchema[] {
    return Array.from(this.tools.values()).map((t) => (t.toModelSchema ? t.toModelSchema() : defaultModelSchema(t)));
  }

  async execute(name: string, args: unknown, signal: AbortSignal, opts: ExecuteOptions = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return textResult(`Unknown tool: ${name}`, true, { code: "E_TOOL_UNKNOWN" });
    }

    const startedAt = Date.now();
    const origin = opts.origin ?? "model";

    // Hook context for this execution
    const hookCtx: HookContext = {
      sessionId: this.sessionId,
      toolName: name,
      origin,
      timestamp: new Date().toISOString(),
    };

    // Helper to run tool_input_transform hook
    let currentArgs = args;
    if (this.hookExecutor) {
      const transformResult = await this.hookExecutor.runTransform("tool_input_transform", [hookCtx, { toolName: name, args: currentArgs, origin }]);
      if (transformResult.transformed && transformResult.params && transformResult.params[1]) {
        currentArgs = (transformResult.params[1] as ToolInputTransformParams).args;
      }
    }

    // 1. Validate arguments before policy or execution.
    const argErrors = validateArgs(tool.inputSchema, currentArgs);
    if (argErrors.length > 0) {
      const result = textResult(`Invalid arguments for tool ${name}: ${argErrors.join("; ")}`, true, {
        code: "E_TOOL_INVALID_ARGS",
        errors: argErrors,
      });
      await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: { decision: "deny", reason: "Invalid arguments" }, result, startedAt });
      return result;
    }

    // pre_tool_use hook - can block
    if (this.hookExecutor) {
      const preResult = await this.hookExecutor.runToolEvent("pre_tool_use", name, hookCtx, { toolName: name, args: currentArgs, origin });
      if (!preResult.proceed) {
        const result = textResult(`Blocked by pre_tool_use hook for tool ${name}`, true, { code: "E_TOOL_DENIED" });
        await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: { decision: "deny", reason: "Blocked by pre_tool_use hook" }, result, startedAt });
        return result;
      }
    }

    // 2. Policy decision.
    const policyInput = {
      toolName: name,
      arguments: currentArgs,
      cwd: this.workspaceRoot,
      origin,
      sideEffect: tool.sideEffect,
    };
    let policy = await this.policy.evaluate(policyInput);

    // tool_guard hook - can modify policy decision
    if (this.hookExecutor) {
      const guardResult = await this.hookExecutor.runGuard("tool_guard", hookCtx, { toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect });
      if (guardResult.decision !== "allow") {
        policy = guardResult;
      }
    }

    if (policy.decision === "deny") {
      const result = textResult(policy.reason, true, { code: "E_TOOL_DENIED" });
      await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: policy, result, startedAt });
      return result;
    }
    if (policy.decision === "require_approval") {
      // permission_request hook - observes the approval round-trip
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("permission_request", hookCtx, { toolName: name, args: currentArgs, origin, policyDecision: policy });
      }

      const handler = opts.requestApproval ?? this.requestApproval;
      if (!handler) {
        const result = textResult(`Approval required for tool ${name}: ${policy.prompt}`, true, {
          code: "E_TOOL_DENIED",
          details: { reason: "no_approval_handler", toolName: name, origin },
        });
        await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: policy, result, startedAt });
        return result;
      }
      let approved: boolean | "session" = false;
      try {
        approved = await handler(policy.prompt, { toolName: name, origin });
      } catch (error) {
        const result = textResult(
          `Approval handler failed for tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
          true,
          { code: "E_TOOL_DENIED", details: { reason: "approval_handler_error", toolName: name, origin } },
        );
        await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: policy, result, startedAt });
        return result;
      }

      // on_tool_approval_decision hook - records user's verdict
      if (this.hookExecutor) {
        await this.hookExecutor.runNotify("on_tool_approval_decision", hookCtx, {
          toolName: name,
          args: currentArgs,
          origin,
          approved: approved !== false,
          reason: typeof approved === "string" ? approved : undefined,
        });
      }

      if (approved === "session") {
        this.configurePolicy((p) => p.allowForSession(name));
        approved = true;
      }
      if (typeof approved === "string" && approved !== "session") {
        this.configurePolicy((p) => p.allowPattern(approved as string));
        approved = true;
      }
      if (!approved) {
        const result = textResult(`Denied by approver for tool ${name}: ${policy.prompt}`, true, {
          code: "E_TOOL_DENIED",
          details: { reason: "approval_denied", toolName: name, origin },
        });
        await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: policy, result, startedAt });
        return result;
      }
    }

    // 3. Execute with registry-level timeout. Timeout aborts the tool signal.
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });

    const ctx: ToolContext = {
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      signal: ctrl.signal,
      emitProgress: () => {},
    };
    if (opts.requestApproval ?? this.requestApproval) {
      ctx.requestApproval = opts.requestApproval ?? this.requestApproval;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ToolResult>((resolveTimeout) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolveTimeout(
          textResult(`Tool ${name} timed out after ${this.maxToolMs}ms`, true, {
            code: "E_TOOL_TIMEOUT",
            timeoutMs: this.maxToolMs,
          }),
        );
      }, this.maxToolMs);
      if (typeof timer.unref === "function") timer.unref();
    });

    const runPromise = (async (): Promise<ToolResult> => {
      try {
        return await tool.execute(currentArgs as never, ctx);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    })();
    // Avoid unhandled rejection when the timeout wins the race.
    runPromise.catch(() => {}).finally(() => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    });

    let result = await Promise.race([runPromise, timeoutPromise]);

    // post_tool_use hook - after execution
    if (this.hookExecutor) {
      const postResult = await this.hookExecutor.runToolEvent("post_tool_use", name, hookCtx, {
        toolName: name,
        args: currentArgs,
        origin,
        result,
        durationMs: Date.now() - startedAt,
      });
      if (!postResult.proceed) {
        result = textResult(`Blocked by post_tool_use hook for tool ${name}`, true, { code: "E_TOOL_DENIED" });
      }
    }

    // tool_response_transform hook - transform result before returning
    if (this.hookExecutor) {
      const transformResult = await this.hookExecutor.runTransform("tool_response_transform", [hookCtx, { toolName: name, args: currentArgs, origin, result }]);
      if (transformResult.transformed && transformResult.params && transformResult.params[1]) {
        result = (transformResult.params[1] as ToolResponseTransformParams).result;
      }
    }

    await this.logAudit({ toolName: name, args: currentArgs, origin, sideEffect: tool.sideEffect, policyDecision: policy, result, startedAt });
    return result;
  }

  private async logAudit(params: {
    toolName: string;
    args: unknown;
    origin: PolicyInput["origin"];
    sideEffect?: SideEffect;
    policyDecision: PolicyDecision;
    result: ToolResult;
    startedAt: number;
  }): Promise<void> {
    if (!this.auditLogger) return;
    const durationMs = Date.now() - params.startedAt;
    await this.auditLogger.log({
      toolName: params.toolName,
      arguments: params.args,
      origin: params.origin,
      sideEffect: params.sideEffect,
      policyDecision: params.policyDecision,
      result: params.result,
      durationMs,
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      userId: this.userId,
    });
  }
}

/**
 * Resolve `p` inside `root`, following symlinks. Throws on escape.
 * Fail closed: callers convert this into a tool error, never a silent redirect.
 */
function safePath(root: string, p: string): string {
  return safeResolveSync(root, p);
}

export function createReadTool(root: string): ToolDefinition<{ path: string; offset?: number; limit?: number }> {
  return {
    name: "read",
    description: "Read file contents or directory listing",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
    sideEffect: "read",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      try {
        const st = await stat(target);
        if (st.isDirectory()) {
          const entries = await readdir(target);
          const text = entries.sort().slice(0, 500).map((e) => `- ${e}`).join("\n");
          return { content: [{ type: "text", text }], isError: false };
        }
        if (st.size > 2_000_000) {
          return textResult(`File too large (${st.size} bytes, cap 2 MB). Refusing to inject into context.`, true, { code: "E_TOOL_FAILED" });
        }
        const text = await readFile(target, "utf8");
        if (text.includes("\0")) {
          return {
            content: [{ type: "text", text: `Binary file (${st.size} bytes). Refusing to inject into context.` }],
            isError: false,
            details: { binary: true, size: st.size },
          };
        }
        const rawOffset = args.offset ?? 1;
        const rawLimit = args.limit ?? 400;
        if (!Number.isInteger(rawOffset) || rawOffset < 1 || !Number.isInteger(rawLimit) || rawLimit < 1) {
          return textResult(`Invalid offset/limit: expected positive integers, got offset=${String(args.offset)} limit=${String(args.limit)}`, true, { code: "E_TOOL_INVALID_ARGS" });
        }
        const offset = rawOffset;
        const limit = Math.min(rawLimit, 2000);
        const lines = text.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const sliced = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        const bounded = boundText(sliced.length ? sliced : "");
        return {
          content: [{ type: "text", text: bounded.text }],
          isError: false,
          details: bounded.truncated ? { truncated: true } : undefined,
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createWriteTool(root: string): ToolDefinition<{ path: string; content: string; overwrite?: boolean }> {
  return {
    name: "write",
    description: "Create or overwrite a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } },
      required: ["path", "content"],
    },
    sideEffect: "write",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      if (args.content.length > MAX_WRITE_BYTES) {
        return textResult(`Write payload too large (${args.content.length} > ${MAX_WRITE_BYTES} bytes)`, true, {
          code: "E_TOOL_INVALID_ARGS",
        });
      }
      const overwrite = args.overwrite ?? false;
      try {
        const st = await stat(target).catch(() => null);
        if (st && st.isDirectory()) return textResult(`Path is a directory: ${args.path}`, true);
        if (st && !overwrite) return textResult(`File exists: ${args.path}`, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, "utf8");
        const bytes = Buffer.byteLength(args.content, "utf8");
        const lines = args.content === "" ? 0 : args.content.split("\n").length;
        const action = st ? "Updated" : "Wrote";
        return {
          content: [{ type: "text", text: `${action} ${args.path} (${lines} lines, ${bytes} bytes)` }],
          isError: false,
          details: { changedPaths: [args.path], bytes, lines, created: !st },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createEditTool(
  root: string,
): ToolDefinition<{ path: string; oldText: string; newText: string; replaceAll?: boolean }> {
  return {
    name: "edit",
    description: "Replace exact text in a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
    sideEffect: "write",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      try {
        const text = await readFile(target, "utf8");
        if (!text.includes(args.oldText)) return textResult("oldText not found", true);
        let next: string;
        let count: number;
        if (args.replaceAll) {
          next = text.replaceAll(args.oldText, args.newText);
          const escaped = args.oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          count = (text.match(new RegExp(escaped, "g")) || []).length;
        } else {
          const idx = text.indexOf(args.oldText);
          if (idx === -1) return textResult("oldText not found", true);
          const after = text.indexOf(args.oldText, idx + 1);
          if (after !== -1) return textResult("oldText not unique; add context or set replaceAll", true);
          next = text.replace(args.oldText, args.newText);
          count = 1;
        }
        await writeFile(target, next, "utf8");
        const diff = unifiedHunk(text, next, 3, args.path);
        const beforeLines = text === "" ? 0 : text.split("\n").length;
        const afterLines = next === "" ? 0 : next.split("\n").length;
        const delta = afterLines - beforeLines;
        const deltaText = delta === 0 ? "no line-count change" : `${delta > 0 ? "+" : ""}${delta} lines`;
        const summary = `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}, ${deltaText})`;
        return {
          content: [{ type: "text", text: diff ? `${summary}\n${diff}` : summary }],
          isError: false,
          details: {
            changedPaths: [args.path],
            replacements: count,
            beforeLines,
            afterLines,
            lineDelta: delta,
          },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

/** Kill a whole process group (Unix) or the single process (Windows). */
function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && proc.pid !== undefined) {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already dead
    }
  }
}

/** Unified diff hunk around changed regions (bounded, for display). */
function unifiedHunk(before: string, after: string, context: number, path = "file"): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  // No changes (should be rare here), return empty.
  if (start > endA && start > endB) return "";

  const ctx = Math.max(0, context);
  const preStart = Math.max(0, start - ctx);
  const preEnd = Math.min(a.length - 1, Math.max(endA, endB) + ctx);
  const oldStart = a.length === 0 ? 0 : preStart + 1;
  const oldCount = (start > endA ? 0 : endA - start + 1) + (start - preStart) + Math.max(0, preEnd - endA);
  const newStart = b.length === 0 ? 0 : preStart + 1;
  const newCount = (start > endB ? 0 : endB - start + 1) + (start - preStart) + Math.max(0, preEnd - Math.max(endA, start - 1));

  const out: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${Math.max(0, oldCount)} +${newStart},${Math.max(0, newCount)} @@`,
  ];
  for (let i = preStart; i < start; i++) out.push(` ${a[i] ?? ""}`);
  for (let i = start; i <= endA; i++) out.push(`-${a[i] ?? ""}`);
  for (let i = start; i <= endB; i++) out.push(`+${b[i] ?? ""}`);
  for (let i = endA + 1; i <= preEnd; i++) {
    if (i >= 0 && i < a.length) out.push(` ${a[i] ?? ""}`);
  }
  const MAX = 80;
  return out.length > MAX ? `${out.slice(0, MAX).join("\n")}\n… ${out.length - MAX} more diff lines` : out.join("\n");
}

export interface CreateBashToolOptions {
  root: string;
  timeoutMs?: number;
  sandbox?: SandboxOptions | false;
}

export function createBashTool(
  options: CreateBashToolOptions | string,
  timeoutMs?: number,
): ToolDefinition<{ command: string; timeoutMs?: number }> {
  const normalized: CreateBashToolOptions =
    typeof options === "string"
      ? { root: options, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
      : options;
  const { timeoutMs: defaultTimeoutMs = 120000, sandbox = false } = normalized;
  return {
    name: "bash",
    description: "Execute a shell command in the workspace",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "integer" } },
      required: ["command"],
    },
    sideEffect: "execute",
    async execute(args, ctx) {
      const cmd = args.command;
      const t = Math.min(args.timeoutMs ?? defaultTimeoutMs, 600_000);
      const useSandbox = sandbox !== false;
      const sandboxOpts = useSandbox ? { ...sandbox, maxCpuTimeMs: t } : false;

      return await new Promise<ToolResult>((resolvePromise) => {
        let settled = false;
        let sandboxResult: Awaited<ReturnType<typeof spawnSandboxed>> | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;

        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
          if (sandboxResult) sandboxResult.cleanup();
          resolvePromise(result);
        };

        const startedAt = Date.now();
        let stdout = "";
        let stdoutCapped = false;
        let stderr = "";
        let stderrCapped = false;

        const run = async () => {
          if (sandboxOpts) {
            try {
              sandboxResult = await spawnSandboxed("bash", ["-c", cmd], {
                ...sandboxOpts,
                cwd: ctx.workspaceRoot,
                stdio: "pipe",
              });
            } catch {
              // Namespace isolation unavailable (e.g. no unshare support);
              // fall back to plain spawn without sandboxing.
              sandboxResult = {
                process: spawn("bash", ["-c", cmd], {
                  cwd: ctx.workspaceRoot,
                  stdio: "pipe",
                  detached: process.platform !== "win32",
                  windowsHide: true,
                }),
                cleanup: async () => {},
                active: false,
              };
            }
          } else {
              sandboxResult = {
                process: spawn("bash", ["-c", cmd], {
                  cwd: ctx.workspaceRoot,
                  stdio: "pipe",
                  detached: process.platform !== "win32",
                  windowsHide: true,
                }),
                cleanup: async () => {},
                active: false,
              };
            }

            const proc = sandboxResult.process;

            timer = setTimeout(() => {
              if (sandboxResult) sandboxResult.cleanup();
              killTimer = setTimeout(() => {
                if (sandboxResult) sandboxResult.cleanup();
              }, 2000);
              const durationMs = Date.now() - startedAt;
              const out = boundText(stdout);
              const err = boundText(stderr);
              let text = `Exit code: 124 (timeout after ${t}ms)\nDuration: ${(durationMs / 1000).toFixed(1)}s\n`;
              if (out.text) text += `\nstdout:\n${out.text}`;
              if (err.text) text += `\nstderr:\n${err.text}`;
              finish({
                content: [{ type: "text", text }],
                isError: true,
                details: { code: "E_TOOL_TIMEOUT", exitCode: 124, durationMs, timeoutMs: t, sandboxed: sandboxResult?.active ?? false },
              });
            }, t);

            onAbort = () => {
              if (sandboxResult) sandboxResult.cleanup();
              killTimer = setTimeout(() => {
                if (sandboxResult) sandboxResult.cleanup();
              }, 2000);
            };
            if (ctx.signal.aborted) onAbort();
            else ctx.signal.addEventListener("abort", onAbort, { once: true });

            if (proc.stdout) {
              proc.stdout.on("data", (d: Buffer) => {
                if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString();
                else stdoutCapped = true;
              });
            }
            if (proc.stderr) {
              proc.stderr.on("data", (d: Buffer) => {
                if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString();
                else stderrCapped = true;
              });
            }
            proc.on("close", (code, signal) => {
              const durationMs = Date.now() - startedAt;
              const out = boundText(stdout);
              const err = boundText(stderr);
              let text = `Exit code: ${code ?? -1}${signal ? ` (signal ${signal})` : ""}\nDuration: ${(durationMs / 1000).toFixed(1)}s\n`;
              if (out.text) text += `\nstdout:\n${out.text}`;
              if (err.text) text += `\nstderr:\n${err.text}`;
              finish({
                content: [{ type: "text", text }],
                isError: code !== 0,
                details: {
                  exitCode: code ?? -1,
                  durationMs,
                  stdoutTruncated: out.truncated || stdoutCapped,
                  stderrTruncated: err.truncated || stderrCapped,
                  timeoutMs: t,
sandboxed: sandboxResult?.active ?? false,
            },
          });
        });
        proc.on("error", (e) => {
          finish(textResult(String(e), true, { code: "E_TOOL_FAILED" }));
        });
    };

        run();
      });
    },
  };
}
