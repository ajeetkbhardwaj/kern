import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/main.ts");
const TSX_BIN = resolve(process.cwd(), "node_modules/.bin/tsx");

describe("CLI v1.0 flags and modes", () => {
  it("prints version with --version", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--version"]);
    expect(stdout.trim()).toBe("kern v1.0.0");
  }, 15_000);

  it("includes new v1.0 flags in --help output", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--help"]);
    expect(stdout).toContain("--max-turns");
    expect(stdout).toContain("--max-wall-time-ms");
    expect(stdout).toContain("--max-tool-calls-per-turn");
    expect(stdout).toContain("--max-total-tool-calls");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--version");
  }, 15_000);

  it("emits NDJSON agent events with --print --json", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--print", "--json", "--no-resources", "--no-compaction", "hello"]);
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string });
    const types = lines.map((l) => l.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    expect(types).toContain("agent_settled");
  }, 15_000);
});
