import { spawn, type ChildProcess } from "node:child_process";
import type { ToolDefinition, ToolResult } from "@kern/protocol";
import { boundText, textResult } from "@kern/protocol";
import { spawnSandboxed, sanitizeEnv, type SandboxOptions } from "../../bash-sandbox.js";

const MAX_JOB_BUFFER_CHARS = 256_000;

interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  proc: ChildProcess;
  cleanup: () => Promise<void>;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  readOffsetOut: number;
  readOffsetErr: number;
}

function killJobTree(proc: ChildProcess, sig: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && proc.pid !== undefined) {
      process.kill(-proc.pid, sig);
    } else {
      proc.kill(sig);
    }
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* already exited */
    }
  }
}

function tailText(text: string, maxLines = 100): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `[... ${lines.length - maxLines} earlier lines omitted ...]\n` + lines.slice(-maxLines).join("\n");
}

export class BackgroundJobManager {
  private seq = 0;
  private readonly jobs = new Map<string, BackgroundJob>();

  async start(
    command: string,
    cwd: string,
    sandbox: SandboxOptions | false = false,
  ): Promise<ToolResult> {
    let proc: ChildProcess;
    let cleanup: () => Promise<void> = async () => {};

    if (sandbox !== false) {
      try {
        const res = await spawnSandboxed("bash", ["-c", command], {
          ...sandbox,
          cwd,
          stdio: "pipe",
        });
        proc = res.process;
        cleanup = res.cleanup;
      } catch {
        proc = spawn("bash", ["-c", command], {
          cwd,
          env: sanitizeEnv(process.env),
          stdio: "pipe",
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      }
    } else {
      proc = spawn("bash", ["-c", command], {
        cwd,
        env: sanitizeEnv(process.env),
        stdio: "pipe",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    }

    if (typeof proc.unref === "function") {
      try {
        proc.unref();
      } catch {
        /* ignore */
      }
    }

    const id = `bg_${++this.seq}`;
    const job: BackgroundJob = {
      id,
      command,
      cwd,
      pid: proc.pid,
      proc,
      cleanup,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      readOffsetOut: 0,
      readOffsetErr: 0,
    };
    this.jobs.set(id, job);

    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const str = chunk.toString("utf8");
      if (kind === "stdout") {
        if (job.stdout.length < MAX_JOB_BUFFER_CHARS) {
          job.stdout += str.slice(0, MAX_JOB_BUFFER_CHARS - job.stdout.length);
        }
        if (job.stdout.length >= MAX_JOB_BUFFER_CHARS) job.stdoutTruncated = true;
      } else {
        if (job.stderr.length < MAX_JOB_BUFFER_CHARS) {
          job.stderr += str.slice(0, MAX_JOB_BUFFER_CHARS - job.stderr.length);
        }
        if (job.stderr.length >= MAX_JOB_BUFFER_CHARS) job.stderrTruncated = true;
      }
    };

    proc.stdout?.on("data", (d: Buffer) => append("stdout", d));
    proc.stderr?.on("data", (d: Buffer) => append("stderr", d));
    proc.on("close", (code, sig) => {
      job.exitCode = code ?? -1;
      job.signal = sig;
      job.endedAt = Date.now();
    });
    proc.on("error", (err) => {
      job.stderr += `\n${err.message}`;
      if (job.exitCode === null) {
        job.exitCode = -1;
        job.endedAt = Date.now();
      }
    });

    // Brief grace window so fast startup failures or banners appear right away.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const running = job.endedAt === undefined;
    const outSnippet = boundText(job.stdout).text;
    const errSnippet = boundText(job.stderr).text;
    const lines = [
      `Background job ${id} (${running ? "running" : `exited with code ${job.exitCode}`})${job.pid ? ` · pid ${job.pid}` : ""}`,
      `Command: ${command}`,
    ];
    if (outSnippet) lines.push(`\nstdout:\n${outSnippet}`);
    if (errSnippet) lines.push(`\nstderr:\n${errSnippet}`);
    if (running) {
      lines.push(`\nUse bash-status(jobId="${id}") to inspect output or bash-stop(jobId="${id}") to terminate.`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: !running && job.exitCode !== 0,
      details: { jobId: id, pid: job.pid, running, exitCode: job.exitCode },
    };
  }

  status(jobId?: string, opts: { tailLines?: number; incremental?: boolean } = {}): ToolResult {
    if (!jobId) {
      if (this.jobs.size === 0) {
        return { content: [{ type: "text", text: "(no background jobs)" }], isError: false, details: { jobs: [] } };
      }
      const list = [...this.jobs.values()].map((j) => {
        const running = j.endedAt === undefined;
        const elapsed = (((j.endedAt ?? Date.now()) - j.startedAt) / 1000).toFixed(1);
        const state = running ? "running" : `exited(${j.exitCode ?? -1})`;
        return `${j.id} [${state}] ${elapsed}s pid=${j.pid ?? "?"} — ${j.command}`;
      });
      return {
        content: [{ type: "text", text: list.join("\n") }],
        isError: false,
        details: {
          jobs: [...this.jobs.values()].map((j) => ({
            id: j.id,
            command: j.command,
            running: j.endedAt === undefined,
            exitCode: j.exitCode,
            pid: j.pid,
          })),
        },
      };
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return textResult(`Unknown background job: ${jobId}`, true, { code: "E_TOOL_FAILED" });
    }

    const running = job.endedAt === undefined;
    const durationMs = (job.endedAt ?? Date.now()) - job.startedAt;
    const incremental = opts.incremental ?? false;
    const rawOut = incremental ? job.stdout.slice(job.readOffsetOut) : job.stdout;
    const rawErr = incremental ? job.stderr.slice(job.readOffsetErr) : job.stderr;
    if (incremental) {
      job.readOffsetOut = job.stdout.length;
      job.readOffsetErr = job.stderr.length;
    }

    const maxLines = Math.max(10, Math.min(500, opts.tailLines ?? 120));
    const outBounded = boundText(tailText(rawOut, maxLines));
    const errBounded = boundText(tailText(rawErr, maxLines));

    const lines = [
      `Job ${job.id}: ${running ? "running" : `exited (code ${job.exitCode ?? -1}${job.signal ? `, signal ${job.signal}` : ""})`}`,
      `Duration: ${(durationMs / 1000).toFixed(1)}s · pid=${job.pid ?? "?"}`,
    ];
    if (outBounded.text) lines.push(`\nstdout:\n${outBounded.text}`);
    if (errBounded.text) lines.push(`\nstderr:\n${errBounded.text}`);
    if (!outBounded.text && !errBounded.text) {
      lines.push(incremental ? "\n(no new output)" : "\n(no output yet)");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: false,
      details: { jobId: job.id, running, exitCode: job.exitCode, pid: job.pid, durationMs },
    };
  }

  async stop(jobId: string): Promise<ToolResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return textResult(`Unknown background job: ${jobId}`, true, { code: "E_TOOL_FAILED" });
    }
    if (job.endedAt !== undefined) {
      return {
        content: [{ type: "text", text: `Job ${jobId} already exited with code ${job.exitCode ?? -1}.` }],
        isError: false,
        details: { jobId, running: false, exitCode: job.exitCode },
      };
    }

    killJobTree(job.proc, "SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => job.proc.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (job.endedAt === undefined) {
      killJobTree(job.proc, "SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => job.proc.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    await job.cleanup().catch(() => {});

    const out = boundText(tailText(job.stdout, 80)).text;
    const err = boundText(tailText(job.stderr, 80)).text;
    const lines = [`Stopped job ${jobId} (exit code: ${job.exitCode ?? -1})`];
    if (out) lines.push(`\nstdout:\n${out}`);
    if (err) lines.push(`\nstderr:\n${err}`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: false,
      details: { jobId, running: false, exitCode: job.exitCode },
    };
  }

  async dispose(): Promise<void> {
    const active = [...this.jobs.values()].filter((j) => j.endedAt === undefined);
    for (const job of active) {
      killJobTree(job.proc, "SIGTERM");
    }
    if (active.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      for (const job of active) {
        if (job.endedAt === undefined) killJobTree(job.proc, "SIGKILL");
        await job.cleanup().catch(() => {});
      }
    }
  }
}

export function createBashStatusTool(
  manager: BackgroundJobManager,
): ToolDefinition<{ jobId?: string; tailLines?: number; incremental?: boolean }> {
  return {
    name: "bash-status",
    description: "List background shell jobs or inspect output/status of a specific job started with bash(background=true)",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Background job ID (omit to list all jobs)" },
        tailLines: { type: "integer", minimum: 10, maximum: 500, default: 120 },
        incremental: { type: "boolean", default: false, description: "Only return output emitted since the last bash-status call" },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    allowRepeatedCalls: true,
    async execute(args): Promise<ToolResult> {
      return manager.status(args.jobId, { tailLines: args.tailLines, incremental: args.incremental });
    },
  };
}

export function createBashStopTool(
  manager: BackgroundJobManager,
): ToolDefinition<{ jobId: string }> {
  return {
    name: "bash-stop",
    description: "Terminate a running background shell job started with bash(background=true)",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Background job ID to stop" },
      },
      required: ["jobId"],
    },
    sideEffect: "execute",
    annotations: { destructiveHint: false },
    async execute(args): Promise<ToolResult> {
      return manager.stop(args.jobId);
    },
  };
}
