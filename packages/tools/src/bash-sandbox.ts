/**
 * Bash sandboxing utilities for secure command execution.
 * Provides resource limits and optional namespace isolation.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { platform } from "node:os";

/** Environment variables stripped before spawning sandboxed/child processes. */
const SANDBOX_ENV_DENYLIST = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_DEBUG",
  "PYTHONPATH",
  "PERL5LIB",
  "RUBYLIB",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "HISTFILE",
  "HISTFILESIZE",
  "KERN_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
];

/** Remove dangerous and credential environment variables from the environment. */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SANDBOX_ENV_DENYLIST.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

type SpawnOptionsWithEnv = SpawnOptions & { env?: Record<string, string> };

export interface SandboxOptions {
  /** Enable user namespace isolation (requires kernel support, no root needed on modern Linux) */
  userNamespace?: boolean;
  /** Enable PID namespace isolation */
  pidNamespace?: boolean;
  /** Enable network namespace isolation (requires root or CAP_SYS_ADMIN) */
  networkNamespace?: boolean;
  /** Enable mount namespace isolation */
  mountNamespace?: boolean;
  /** Maximum CPU time in milliseconds */
  maxCpuTimeMs?: number;
  /** Maximum memory in bytes */
  maxMemoryBytes?: number;
  /** Maximum number of processes */
  maxProcesses?: number;
  /** Maximum file size in bytes */
  maxFileSizeBytes?: number;
  /** Maximum open file descriptors */
  maxOpenFiles?: number;
  /** Working directory for the sandbox (will be chrooted if mountNamespace) */
  workdir?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

export interface SandboxResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Cleanup function to ensure proper teardown */
  cleanup: () => Promise<void>;
  /** Whether sandboxing is active */
  active: boolean;
}

/**
 * Check if user namespaces are available (Linux kernel 3.8+)
 */
export async function isUserNamespaceAvailable(): Promise<boolean> {
  if (platform() !== "linux") return false;
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("unshare", ["--user", "--map-root-user", "true"], { timeout: 1000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Build the unshare command prefix for namespace isolation
 */
function buildUnsharePrefix(options: SandboxOptions): string[] {
  const args: string[] = [];
  if (options.userNamespace) args.push("--user", "--map-root-user");
  if (options.pidNamespace) args.push("--pid");
  if (options.networkNamespace) args.push("--net");
  if (options.mountNamespace) args.push("--mount", "--mount-proc");
  if (options.workdir && options.mountNamespace) {
    args.push("--root", options.workdir);
  }
  return args.length > 0 ? ["unshare", ...args] : [];
}

/**
 * Build resource limit commands using prlimit (Linux) or ulimit (fallback)
 */
function buildResourceLimits(options: SandboxOptions): string[] {
  const limits: string[] = [];
  if (platform() === "linux") {
    if (options.maxCpuTimeMs !== undefined) {
      const cpuSeconds = Math.ceil(options.maxCpuTimeMs / 1000);
      limits.push(`prlimit --cpu=${cpuSeconds}:${cpuSeconds}`);
    }
    if (options.maxMemoryBytes !== undefined) {
      limits.push(`prlimit --as=${options.maxMemoryBytes}:${options.maxMemoryBytes}`);
    }
    if (options.maxProcesses !== undefined) {
      limits.push(`prlimit --nproc=${options.maxProcesses}:${options.maxProcesses}`);
    }
    if (options.maxFileSizeBytes !== undefined) {
      limits.push(`prlimit --fsize=${options.maxFileSizeBytes}:${options.maxFileSizeBytes}`);
    }
    if (options.maxOpenFiles !== undefined) {
      limits.push(`prlimit --nofile=${options.maxOpenFiles}:${options.maxOpenFiles}`);
    }
  }
  return limits;
}

/**
 * Spawn a command with sandboxing applied.
 * Returns a ChildProcess with resource limits and optional namespace isolation.
 */
export async function spawnSandboxed(
  command: string,
  args: string[],
  options: SandboxOptions & SpawnOptionsWithEnv = {},
): Promise<SandboxResult> {
  const {
    userNamespace = false,
    pidNamespace = false,
    networkNamespace = false,
    mountNamespace = false,
    workdir,
    env,
    ...spawnOptions
  } = options;

  const sandboxOpts: SandboxOptions = {
    userNamespace,
    pidNamespace,
    networkNamespace,
    mountNamespace,
    maxCpuTimeMs: options.maxCpuTimeMs,
    maxMemoryBytes: options.maxMemoryBytes,
    maxProcesses: options.maxProcesses,
    maxFileSizeBytes: options.maxFileSizeBytes,
    maxOpenFiles: options.maxOpenFiles,
    workdir,
    env,
  };

  const unsharePrefix = buildUnsharePrefix(sandboxOpts);
  const resourceLimits = buildResourceLimits(sandboxOpts);

  // Build the full command
  const fullCommand = [...unsharePrefix, ...resourceLimits, command, ...args].join(" ");

  // Spawn through bash for proper shell expansion
  const child = spawn("bash", ["-c", fullCommand], {
    ...spawnOptions,
    cwd: workdir ?? spawnOptions.cwd ?? process.cwd(),
    env: sanitizeEnv({ ...process.env, ...env, ...(spawnOptions as SpawnOptionsWithEnv).env }),
    stdio: spawnOptions.stdio ?? "pipe",
    detached: spawnOptions.detached ?? (platform() !== "win32"),
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (platform() !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      } else {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        try { child.kill("SIGKILL"); } catch {}
      }
    } catch {
      // Process already dead
    }
  };

  return {
    process: child,
    cleanup,
    active: unsharePrefix.length > 0 || resourceLimits.length > 0,
  };
}

/**
 * Default sandbox configuration for production use.
 * Balances security with compatibility.
 */
export const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  userNamespace: true,
  pidNamespace: true,
  mountNamespace: false, // Requires careful setup
  networkNamespace: false, // Requires root
  maxCpuTimeMs: 120_000, // 2 minutes CPU time
  maxMemoryBytes: 2_000_000_000, // 2GB
  maxProcesses: 100,
  maxFileSizeBytes: 100_000_000, // 100MB
  maxOpenFiles: 1024,
};

/**
 * Minimal sandbox for untrusted code execution.
 * More restrictive than default.
 */
export const STRICT_SANDBOX_OPTIONS: SandboxOptions = {
  userNamespace: true,
  pidNamespace: true,
  mountNamespace: true,
  networkNamespace: false,
  maxCpuTimeMs: 30_000,
  maxMemoryBytes: 500_000_000,
  maxProcesses: 20,
  maxFileSizeBytes: 10_000_000,
  maxOpenFiles: 256,
};

/**
 * No sandbox - for trusted commands only.
 */
export const NO_SANDBOX_OPTIONS: SandboxOptions = {
  userNamespace: false,
  pidNamespace: false,
  networkNamespace: false,
  mountNamespace: false,
};