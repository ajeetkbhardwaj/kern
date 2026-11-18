import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

  it("validates custom models.json files including fallbackModels with --validate-config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kern-cli-cfg-"));
    try {
      const validCfg = join(dir, "valid.json");
      writeFileSync(
        validCfg,
        JSON.stringify({
          defaultProvider: "local",
          defaultModel: "m1",
          fallbackModels: ["backup/m2"],
          providers: {
            local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "m1" }] },
            backup: { baseUrl: "http://localhost:1234/v1", models: [{ id: "m2" }] },
          },
        }),
      );
      const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--validate-config", "--config", validCfg]);
      expect(stdout).toContain("Configuration valid:");
      expect(stdout).toContain("local, backup");

      const badCfg = join(dir, "bad.json");
      writeFileSync(
        badCfg,
        JSON.stringify({
          defaultProvider: "local",
          defaultModel: "m1",
          fallbackModels: ["missing/m2"],
          providers: {
            local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "m1" }] },
          },
        }),
      );
      await expect(execFileAsync(TSX_BIN, [CLI_ENTRY, "--validate-config", "--config", badCfg])).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
