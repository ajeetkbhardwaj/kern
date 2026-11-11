import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function spawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; maxBytes?: number } = { cwd: process.cwd() }
): Promise<SpawnResult> {
  const { cwd, maxBytes = 1_000_000 } = options;
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    
    proc.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < maxBytes) stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < maxBytes) stderr += d.toString();
    });
    
    proc.on("error", (error) => {
      resolve({ stdout, stderr: error.message, code: -1 });
    });
    
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}