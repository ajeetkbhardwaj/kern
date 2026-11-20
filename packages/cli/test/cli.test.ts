import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/main.ts");
const TSX_BIN = resolve(process.cwd(), "node_modules/.bin/tsx");

describe("CLI v1.0 flags and modes", () => {
  it("prints version with --version", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--version"]);
    expect(stdout.trim()).toBe("kern v1.0.0");
  }, 15_000);

  it("includes new v1.0 and MCP flags in --help output", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "--help"]);
    expect(stdout).toContain("--max-turns");
    expect(stdout).toContain("--max-wall-time-ms");
    expect(stdout).toContain("--max-tool-calls-per-turn");
    expect(stdout).toContain("--max-total-tool-calls");
    expect(stdout).toContain("--no-mcp");
    expect(stdout).toContain("kern login");
    expect(stdout).toContain("kern logout");
    expect(stdout).toContain("kern mcp");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--version");
  }, 15_000);

  it("supports `kern login`, `kern login --list`, and `kern logout` with isolated ~/.kern store", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kern-cli-auth-"));
    const env = { ...process.env, HOME: fakeHome };
    try {
      const loginRes = await execFileAsync(
        TSX_BIN,
        [
          CLI_ENTRY,
          "login",
          "openai",
          "--base-url",
          "http://127.0.0.1:4010/v1",
          "--model",
          "gpt-4o-mini",
          "--api-key",
          "sk-test-login-secret-1234",
          "--no-test",
          "--default",
        ],
        { env },
      );
      expect(loginRes.stdout).toContain("Logged in to openai");

      const authRaw = JSON.parse(readFileSync(join(fakeHome, ".kern", "auth.json"), "utf8")) as Record<string, { apiKey: string }>;
      expect(authRaw["openai"]?.apiKey).toBe("sk-test-login-secret-1234");
      const modelsRaw = readFileSync(join(fakeHome, ".kern", "models.json"), "utf8");
      expect(modelsRaw).not.toContain("sk-test-login-secret-1234");

      const listRes = await execFileAsync(TSX_BIN, [CLI_ENTRY, "login", "--list"], { env });
      expect(listRes.stdout).toContain("openai");
      expect(listRes.stdout).toContain("logged in");
      expect(listRes.stdout).not.toContain("sk-test-login-secret-1234");

      const logoutRes = await execFileAsync(TSX_BIN, [CLI_ENTRY, "logout", "openai"], { env });
      expect(logoutRes.stdout).toContain("Logged out of openai");

      const authAfter = JSON.parse(readFileSync(join(fakeHome, ".kern", "auth.json"), "utf8")) as Record<string, unknown>;
      expect(authAfter["openai"]).toBeUndefined();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 15_000);

  it("lists built-in connector presets via `kern mcp presets`", async () => {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, "mcp", "presets"]);
    expect(stdout).toContain("context7");
    expect(stdout).toContain("github");
    expect(stdout).toContain("playwright");
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
