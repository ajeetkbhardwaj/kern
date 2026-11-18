import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authFilePath,
  clearAuthKey,
  discoverModels,
  loadAuth,
  maskKey,
  readLastUsed,
  recordLastUsed,
  resolveApiKey,
  saveAuthKey,
  saveProviderToUserFile,
  testProvider,
  userModelsFile,
  resolveFallbackAdapters,
  createFallbackModelAdapter,
} from "../src/discovery.js";
import { createOpenAIAdapter } from "../src/openai.js";

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "kern-test-"));
  process.env.HOME = home;
  vi.unstubAllEnvs();
});

afterEach(() => {
  process.env.HOME = savedHome;
});

describe("maskKey", () => {
  it("keeps ! and $ references as-is", () => {
    expect(maskKey("!pass show key")).toBe("!pass show key");
    expect(maskKey("$OPENAI_API_KEY")).toBe("$OPENAI_API_KEY");
  });
  it("masks short literals", () => {
    expect(maskKey("short")).toBe("••••");
    expect(maskKey("12345678")).toBe("••••");
  });
  it("masks long literals sk-…abcd style", () => {
    expect(maskKey("sk-1234abcd")).toBe("sk-…abcd");
  });
});

describe("auth file", () => {
  it("authFilePath lives under ~/.kern", () => {
    expect(authFilePath()).toBe(join(home, ".kern", "auth.json"));
  });
  it("loadAuth returns {} when missing", async () => {
    await expect(loadAuth()).resolves.toEqual({});
  });
  it("save/load/clear roundtrip", async () => {
    await saveAuthKey("openai", "sk-test-key");
    await expect(loadAuth()).resolves.toEqual({ openai: { apiKey: "sk-test-key" } });
    await saveAuthKey("other", "k2");
    const both = await loadAuth();
    expect(Object.keys(both).sort()).toEqual(["openai", "other"]);
    await clearAuthKey("openai");
    await expect(loadAuth()).resolves.toEqual({ other: { apiKey: "k2" } });
    await clearAuthKey("missing");
    await expect(loadAuth()).resolves.toEqual({ other: { apiKey: "k2" } });
  });
});

describe("resolveApiKey precedence", () => {
  it("explicit > auth.json > config literal > env", async () => {
    process.env.PREC_TEST_ENV = "env-key";
    await saveAuthKey("prec-p", "auth-key");
    const cfg = { baseUrl: "https://example.com/v1", apiKey: "literal-key", apiKeyEnv: "PREC_TEST_ENV" } as const;
    expect(await resolveApiKey("prec-p", { ...cfg }, "explicit-key")).toBe("explicit-key");
    expect(await resolveApiKey("prec-p", { ...cfg })).toBe("auth-key");
    expect(await resolveApiKey("prec-other", { ...cfg })).toBe("literal-key");
    expect(await resolveApiKey("prec-env", { baseUrl: "https://example.com/v1", apiKeyEnv: "PREC_TEST_ENV" })).toBe(
      "env-key",
    );
    expect(await resolveApiKey("prec-loop", { baseUrl: "http://localhost:11434/v1" })).toBeUndefined();
  });
});

describe("saveProviderToUserFile", () => {
  it("rejects bad names and urls", async () => {
    await expect(saveProviderToUserFile("Bad Name!", { baseUrl: "http://localhost:11434/v1" })).rejects.toThrow();
    await expect(saveProviderToUserFile("ok.name-1", { baseUrl: "ftp://x" })).rejects.toThrow();
  });
  it("accepts dots in names", async () => {
    const { path } = await saveProviderToUserFile("my.provider-1", { baseUrl: "http://localhost:11434/v1" });
    expect(path).toBe(userModelsFile());
  });
  it("never stores literal secrets in models.json", async () => {
    const { summary } = await saveProviderToUserFile(
      "cloud",
      { baseUrl: "https://example.com/v1", apiKey: "sk-secret-key-1234" },
      { makeDefault: true },
    );
    expect(summary).not.toContain("sk-secret-key-1234");
    const modelsRaw = await readFile(userModelsFile(), "utf8");
    expect(modelsRaw).not.toContain("sk-secret-key-1234");
    expect(JSON.parse(modelsRaw).defaultProvider).toBe("cloud");
    const auth = await loadAuth();
    expect(auth.cloud?.apiKey).toBe("sk-secret-key-1234");
  });
  it("keeps $VAR references in models.json", async () => {
    await saveProviderToUserFile("ref", { baseUrl: "https://example.com/v1", apiKey: "$REF_KEY" });
    const modelsRaw = await readFile(userModelsFile(), "utf8");
    expect(JSON.parse(modelsRaw).providers.ref.apiKey).toBe("$REF_KEY");
  });
});

describe("last used", () => {
  it("returns null when missing, roundtrips after record", async () => {
    await expect(readLastUsed()).resolves.toBeNull();
    await recordLastUsed("ollama", "llama3");
    await expect(readLastUsed()).resolves.toEqual({ provider: "ollama", model: "llama3" });
  });
});

function stubFetch(handler: (url: string) => unknown) {
  return ((_url: unknown, _init?: unknown) => Promise.resolve(handler(String(_url)))) as unknown as typeof fetch;
}

describe("testProvider", () => {
  it("rejects non-http urls", async () => {
    const r = await testProvider("ftp://x", undefined);
    expect(r.ok).toBe(false);
  });
  it("maps connection refused to friendly message", async () => {
    const r = await testProvider(
      "http://localhost:9/v1",
      undefined,
      { fetchImpl: stubFetch(() => { throw new Error("connect ECONNREFUSED 127.0.0.1:9"); }) },
    );
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Is the server running?") });
  });
  it("maps 401 to key rejected", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "bad",
      { fetchImpl: stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Key rejected");
  });
  it("maps timeouts with proxy hint", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const r = await testProvider("https://example.com/v1", "k", { fetchImpl: stubFetch(() => { throw err; }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("proxy");
  });
  it("flags empty model lists with manual-id hint", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "k",
      { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("manually");
  });
  it("returns models on success", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "k",
      { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "a" }] }) })) },
    );
    expect(r).toEqual({ ok: true, models: ["a"] });
  });
});

describe("discoverModels filtering", () => {
  const live = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }) }));
  const file = {
    providers: {
      p: {
        baseUrl: "http://localhost:9999/v1",
        models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
    },
  };
  it("whitelist narrows then blacklist removes, for configured and live", async () => {
    const out = await discoverModels(
      { providers: { p: { ...file.providers.p, whitelist: ["m1", "m2"], blacklist: ["m2"] } } },
      { provider: "p" },
      { fetchImpl: live },
    );
    const configured = out.filter((m) => m.source === "configured").map((m) => m.id);
    expect(configured).toEqual(["m1"]);
    expect(out.filter((m) => m.source === "live").map((m) => m.id)).toEqual([]);
  });
  it("no filters returns union without dupes", async () => {
    const out = await discoverModels(file, { provider: "p" }, { fetchImpl: live });
    expect(out.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
  });
});

describe("openai adapter", () => {
  it("normalizes streaming text and tool calls", async () => {
    const calls: Array<{ body: string; headers?: Record<string, string> }> = [];
    const adapter = createOpenAIAdapter({
      provider: "test",
      modelId: "gpt-4o-mini",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      contextWindow: 128000,
      maxOutputTokens: 4000,
      fetchImpl: (async (url, init) => {
        calls.push({
          body: String((init as any)?.body ?? ""),
          headers: (init as any)?.headers as Record<string, string> | undefined,
        });
        const payload = `data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]},"finish_reason":null}] }\n\n` +
          `data: [DONE]\n\n`;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload));
              controller.close();
            },
          }),
        } as any;
      }) as typeof fetch,
    });

    const events: any[] = [];
    for await (const event of adapter.stream({
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date().toISOString() }],
      tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
      thinkingLevel: "medium",
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "text_delta" && e.delta === "hello")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_complete")).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0]!.body);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.max_tokens).toBe(4000);
    expect(body.tools?.length).toBe(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("classifies context-length HTTP errors correctly", async () => {
    const adapter = createOpenAIAdapter({
      provider: "test",
      modelId: "gpt-4o-mini",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      contextWindow: 128000,
      maxOutputTokens: 4000,
      fetchImpl: (async () =>
        new Response("maximum context length exceeded", {
          status: 400,
          statusText: "Bad Request",
        })),
    });

    await expect(
      (async () => {
        for await (const _ of adapter.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date().toISOString() }],
          tools: [],
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ kind: "context_length", retryable: false });
  });

  it("omits tools/tool_choice when no tools are provided", async () => {
    const calls: Array<{ body: string }> = [];
    const adapter = createOpenAIAdapter({
      provider: "test",
      modelId: "gpt-4o-mini",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      contextWindow: 128000,
      maxOutputTokens: 4000,
      fetchImpl: (async (_url, init) => {
        calls.push({ body: String((init as any)?.body ?? "") });
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              controller.close();
            },
          }),
        } as any;
      }) as typeof fetch,
    });

    for await (const _ of adapter.stream({
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date().toISOString() }],
      tools: [],
    })) {
      // drain
    }

    const body = JSON.parse(calls[0]!.body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("normalizes CRLF SSE streams, delta.reasoning, missing tool index, cached_tokens, and SSE error frames", async () => {
    const adapter = createOpenAIAdapter({
      provider: "test",
      modelId: "openrouter-compat",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      contextWindow: 128000,
      maxOutputTokens: 4000,
      fetchImpl: (async (_url, init) => {
        const sent = JSON.parse(String((init as any)?.body ?? "{}"));
        // Verify assistant history with tool_calls sets content: null when text is empty
        const assistantHist = sent.messages.find((m: any) => m.role === "assistant");
        expect(assistantHist.content).toBeNull();

        const payload =
          `data: {"choices":[{"delta":{"reasoning":"thinking step"},"finish_reason":null}]}\r\n\r\n` +
          `data: {"choices":[{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":null}]}\r\n\r\n` +
          `data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}\r\n\r\n` +
          `data: [DONE]\r\n\r\n`;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(payload));
              c.close();
            },
          }),
        } as any;
      }) as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.stream({
      systemPrompt: "sys",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }], timestamp: new Date().toISOString() },
        { role: "assistant", content: [{ type: "tool_call", id: "c0", name: "read", arguments: { path: "x" } }], timestamp: new Date().toISOString() },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "c0", content: [{ type: "text", text: "ok" }], isError: false }], timestamp: new Date().toISOString() },
      ],
      tools: [],
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual({ type: "reasoning_delta", delta: "thinking step" });
    expect(events).toContainEqual({
      type: "tool_call_complete",
      call: { type: "tool_call", id: "call_x", name: "read", arguments: { path: "a.ts" } },
    });
    expect(events).toContainEqual({ type: "usage", usage: { input: 100, output: 20, cacheRead: 60 } });

    const errorStreamAdapter = createOpenAIAdapter({
      provider: "test",
      modelId: "err-model",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      contextWindow: 128000,
      maxOutputTokens: 4000,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"error":{"message":"rate limit exceeded","code":429}}\n\n`));
            c.close();
          },
        }),
      })) as unknown as typeof fetch,
    });

    await expect(
      (async () => {
        for await (const _ of errorStreamAdapter.stream({ systemPrompt: "s", messages: [], tools: [] })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });
});

describe("fallback models", () => {
  it("resolves configured fallbackModels excluding primary and fails over cleanly", async () => {
    const file = {
      defaultProvider: "p1",
      defaultModel: "m1",
      fallbackModels: ["p1/m1", "p2/m2", "missing/nope"],
      providers: {
        p1: { baseUrl: "http://localhost:11434/v1", models: [{ id: "m1" }] },
        p2: { baseUrl: "http://localhost:1234/v1", models: [{ id: "m2" }] },
      },
    };
    const fallbacks = await resolveFallbackAdapters(file, { provider: "p1", model: "m1" });
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.info).toMatchObject({ provider: "p2", modelId: "m2" });

    const notices: string[] = [];
    const primary = {
      info: { provider: "p1", modelId: "m1", contextWindow: 8000, maxOutputTokens: 1000 },
      async *stream() {
        throw new Error("503 overloaded");
      },
    };
    const backup = {
      info: { provider: "p2", modelId: "m2", contextWindow: 8000, maxOutputTokens: 1000 },
      async *stream() {
        yield { type: "text_delta" as const, delta: "backup-ok" };
        yield { type: "finished" as const, reason: "stop" as const };
      },
    };
    const wrapped = createFallbackModelAdapter([primary, backup], (info) => {
      notices.push(`${info.fromProvider}/${info.fromModel}->${info.toProvider}/${info.toModel}`);
    });
    const out: any[] = [];
    for await (const ev of wrapped.stream({ systemPrompt: "s", messages: [], tools: [] })) {
      out.push(ev);
    }
    expect(notices).toEqual(["p1/m1->p2/m2"]);
    expect(out.some((e) => e.type === "text_delta" && e.delta === "backup-ok")).toBe(true);
  });
});
