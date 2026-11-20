import type { Logger, ToolDefinition, ToolResult } from "@kern/protocol";
import { nullLogger, textResult } from "@kern/protocol";
import {
  loadMcpConfigs,
  removeMcpServerConfig,
  saveMcpServerConfig,
  setMcpServerDisabledInFile,
  trustProjectServer,
  type LoadMcpConfigsOptions,
} from "./config.js";
import {
  formatMcpCallResult,
  formatMcpPromptResult,
  formatMcpResourceResult,
  makeMcpToolName,
  mcpToolToToolDefinition,
  normalizeMcpInputSchema,
} from "./adapter.js";
import { createMcpClient, type McpTransportClient, type RawMcpTool } from "./transports.js";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfigEntry,
  McpServerStatus,
  McpToolInfo,
  ResolvedMcpServerDef,
  ToolRegistryLike,
} from "./types.js";

interface ManagedServer {
  def: ResolvedMcpServerDef;
  client: McpTransportClient | null;
  status: McpServerStatus;
  registeredToolNames: string[];
  rawTools: RawMcpTool[];
}

export interface ConnectManagerOptions extends LoadMcpConfigsOptions {
  cwd: string;
  logger?: Logger;
}

export class ConnectManager {
  private readonly cwd: string;
  private readonly logger: Logger;
  private readonly configOpts: LoadMcpConfigsOptions;
  private readonly servers = new Map<string, ManagedServer>();
  private registry: ToolRegistryLike | null = null;
  private auxiliaryToolNames: string[] = [];
  private warnings: string[] = [];

  constructor(options: ConnectManagerOptions) {
    this.cwd = options.cwd;
    this.logger = options.logger ?? nullLogger;
    this.configOpts = {
      userConfigPath: options.userConfigPath,
      trustFilePath: options.trustFilePath,
      extraConfigPaths: options.extraConfigPaths,
      allowProjectStdio: options.allowProjectStdio,
      envSource: options.envSource,
    };
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Discover all configured servers (env + user + project) and connect trusted enabled ones. */
  async discoverAndConnect(): Promise<{ servers: McpServerStatus[]; warnings: string[] }> {
    const { defs, warnings } = await loadMcpConfigs(this.cwd, this.configOpts);
    this.warnings = [...warnings];

    const activeNames = new Set(defs.map((d) => d.name));
    for (const existing of [...this.servers.keys()]) {
      if (!activeNames.has(existing)) {
        await this.teardownManagedServer(existing);
      }
    }

    await Promise.all(defs.map((def) => this.upsertAndConnectDef(def)));
    this.syncRegistry();
    return { servers: this.listStatuses(), warnings: this.getWarnings() };
  }

  /** Bind a ToolRegistry so live additions, reconnects, and removals sync automatically. */
  bindRegistry(registry: ToolRegistryLike): void {
    this.registry = registry;
    this.syncRegistry();
  }

  /** Sync all currently connected MCP tools + resource/prompt tools into the bound ToolRegistry. */
  syncRegistry(): void {
    const reg = this.registry;
    if (!reg) return;

    // Remove auxiliary tools first
    for (const aux of this.auxiliaryToolNames) {
      reg.unregister(aux);
    }
    this.auxiliaryToolNames = [];

    // Register per-server tools
    const hasAnyResources = this.listStatuses().some((s) => s.resources.length > 0);
    const hasAnyPrompts = this.listStatuses().some((s) => s.prompts.length > 0);

    for (const managed of this.servers.values()) {
      for (const prevName of managed.registeredToolNames) {
        reg.unregister(prevName);
      }
      managed.registeredToolNames = [];

      if (managed.status.state !== "connected" || !managed.client) continue;

      for (const t of managed.rawTools) {
        const meta = managed.status.tools.find((mt) => mt.name === t.name);
        const toolName = meta?.registeredName ?? makeMcpToolName(managed.def.name, t.name);
        if (reg.has(toolName)) {
          this.logger.warn("mcp_tool_name_collision", { server: managed.def.name, toolName });
          continue;
        }
        const client = managed.client;
        const toolDef = mcpToolToToolDefinition({
          serverName: managed.def.name,
          transport: managed.def.transport,
          tool: t,
          registeredName: toolName,
          deferred: managed.def.deferred,
          invoke: (args, signal) => client.callTool(t.name, args, signal),
        });
        reg.register(toolDef);
        managed.registeredToolNames.push(toolName);
      }
    }

    if (hasAnyResources && !reg.has("mcp_resources")) {
      reg.register(this.createResourcesTool());
      this.auxiliaryToolNames.push("mcp_resources");
    }
    if (hasAnyPrompts && !reg.has("mcp_prompts")) {
      reg.register(this.createPromptsTool());
      this.auxiliaryToolNames.push("mcp_prompts");
    }
  }

  private createResourcesTool(): ToolDefinition<{ action: "list" | "read"; server?: string; uri?: string }> {
    return {
      name: "mcp_resources",
      description: "List or read resources exposed by connected MCP servers",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read"] },
          server: { type: "string", description: "Connected MCP server name" },
          uri: { type: "string", description: "Resource URI (required when action=read)" },
        },
        required: ["action"],
      },
      sideEffect: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      allowRepeatedCalls: true,
      execute: async (args, ctx): Promise<ToolResult> => {
        if (args.action === "list") {
          const rows: string[] = [];
          for (const s of this.listStatuses()) {
            if (args.server && s.name !== args.server) continue;
            for (const r of s.resources) {
              rows.push(`${s.name}: ${r.uri}${r.description ? ` — ${r.description}` : ""}`);
            }
          }
          return { content: [{ type: "text", text: rows.join("\n") || "(no MCP resources)" }], isError: false };
        }
        if (!args.server || !args.uri) {
          return textResult("server and uri are required for action=read", true, { code: "E_TOOL_INVALID_ARGS" });
        }
        return await this.readResource(args.server, args.uri, ctx.signal);
      },
    };
  }

  private createPromptsTool(): ToolDefinition<{
    action: "list" | "get";
    server?: string;
    name?: string;
    arguments?: Record<string, string>;
  }> {
    return {
      name: "mcp_prompts",
      description: "List or expand prompt templates exposed by connected MCP servers",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get"] },
          server: { type: "string", description: "Connected MCP server name" },
          name: { type: "string", description: "Prompt name (required when action=get)" },
          arguments: { type: "object", description: "Prompt template arguments" },
        },
        required: ["action"],
      },
      sideEffect: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      allowRepeatedCalls: true,
      execute: async (args, ctx): Promise<ToolResult> => {
        if (args.action === "list") {
          const rows: string[] = [];
          for (const s of this.listStatuses()) {
            if (args.server && s.name !== args.server) continue;
            for (const p of s.prompts) {
              rows.push(`${s.name}/${p.name}${p.description ? ` — ${p.description}` : ""}`);
            }
          }
          return { content: [{ type: "text", text: rows.join("\n") || "(no MCP prompts)" }], isError: false };
        }
        if (!args.server || !args.name) {
          return textResult("server and name are required for action=get", true, { code: "E_TOOL_INVALID_ARGS" });
        }
        return await this.getPrompt(args.server, args.name, args.arguments, ctx.signal);
      },
    };
  }

  private async upsertAndConnectDef(def: ResolvedMcpServerDef): Promise<McpServerStatus> {
    await this.teardownManagedServer(def.name);

    const target = def.url ?? [def.shellCommand ?? def.command ?? "", ...(def.args ?? [])].filter(Boolean).join(" ");
    const baseStatus: McpServerStatus = {
      name: def.name,
      transport: def.transport,
      origin: def.origin,
      sourcePath: def.sourcePath,
      target,
      state: "disconnected",
      trusted: def.trusted,
      disabled: def.disabled,
      tools: [],
      resources: [],
      prompts: [],
    };

    if (def.disabled) {
      baseStatus.state = "disabled";
      this.servers.set(def.name, { def, client: null, status: baseStatus, registeredToolNames: [], rawTools: [] });
      return baseStatus;
    }

    if (!def.trusted) {
      baseStatus.state = "untrusted";
      baseStatus.warning = def.trustReason;
      this.servers.set(def.name, { def, client: null, status: baseStatus, registeredToolNames: [], rawTools: [] });
      return baseStatus;
    }

    const client = createMcpClient(def);
    const managed: ManagedServer = {
      def,
      client,
      status: { ...baseStatus, state: "connecting" },
      registeredToolNames: [],
      rawTools: [],
    };
    this.servers.set(def.name, managed);

    try {
      const meta = await client.connect();
      let rawTools = await client.listTools();

      if (def.includeTools && def.includeTools.length > 0) {
        const allow = new Set(def.includeTools);
        rawTools = rawTools.filter((t) => allow.has(t.name));
      }
      if (def.excludeTools && def.excludeTools.length > 0) {
        const deny = new Set(def.excludeTools);
        rawTools = rawTools.filter((t) => !deny.has(t.name));
      }

      const [resources, prompts] = await Promise.all([
        client.listResources().catch((): McpResourceInfo[] => []),
        client.listPrompts().catch((): McpPromptInfo[] => []),
      ]);

      const tools: McpToolInfo[] = rawTools.map((t) => ({
        name: t.name,
        registeredName: makeMcpToolName(def.name, t.name),
        ...(t.description ? { description: t.description } : {}),
        inputSchema: normalizeMcpInputSchema(t.inputSchema),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));

      managed.rawTools = rawTools;
      managed.status = {
        ...baseStatus,
        state: "connected",
        serverInfo: meta.serverInfo,
        tools,
        resources,
        prompts,
        lastConnectedAt: new Date().toISOString(),
        ...(def.missingEnvVars.length > 0
          ? { warning: `Missing env var(s): ${def.missingEnvVars.join(", ")}` }
          : {}),
      };
    } catch (err) {
      await client.dispose().catch(() => {});
      managed.client = null;
      managed.status = {
        ...baseStatus,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      this.logger.warn("mcp_connect_failed", {
        server: def.name,
        error: managed.status.error,
      });
    }

    return managed.status;
  }

  /** Add/update a server (optionally persisting to ~/.kern/mcp.json or .mcp.json) and connect immediately. */
  async addServer(
    name: string,
    entry: McpServerConfigEntry,
    opts: { scope?: "user" | "project" | "memory" } = {},
  ): Promise<McpServerStatus> {
    const scope = opts.scope ?? "user";
    if (scope === "user" || scope === "project") {
      await saveMcpServerConfig(scope, this.cwd, name, entry, {
        userConfigPath: this.configOpts.userConfigPath,
      });
      if (scope === "project" && entry.command) {
        await trustProjectServer(this.cwd, name, entry, this.configOpts.trustFilePath);
      }
      await this.discoverAndConnect();
      return this.getServerStatus(name)!;
    }

    // In-memory registration (no config file write)
    const { expandEnvString } = await import("./config.js");
    const envSource = this.configOpts.envSource ?? process.env;
    const isRemote = Boolean(entry.url);
    const expandedHeaders = entry.headers
      ? Object.fromEntries(Object.entries(entry.headers).map(([k, v]) => [k, expandEnvString(v, envSource).value]))
      : undefined;
    const expandedEnv = entry.env
      ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, expandEnvString(v, envSource).value]))
      : undefined;

    const def: ResolvedMcpServerDef = {
      name,
      transport: entry.transport ?? (entry.type === "sse" ? "sse" : isRemote ? "http" : "stdio"),
      origin: "memory",
      url: entry.url ? expandEnvString(entry.url, envSource).value : undefined,
      headers: expandedHeaders,
      command: entry.command,
      args: entry.args ?? [],
      env: expandedEnv,
      cwd: entry.cwd ?? this.cwd,
      timeoutMs: entry.timeoutMs ?? 30_000,
      disabled: entry.disabled === true,
      deferred: entry.deferred === true,
      trusted: true,
      missingEnvVars: [],
      includeTools: entry.includeTools,
      excludeTools: entry.excludeTools,
      rawEntry: entry,
    };
    const status = await this.upsertAndConnectDef(def);
    this.syncRegistry();
    return status;
  }

  async removeServer(name: string, opts: { scope?: "user" | "project" | "both" } = {}): Promise<boolean> {
    const hadMemory = this.servers.has(name);
    await this.teardownManagedServer(name);
    this.syncRegistry();

    const scope = opts.scope ?? "both";
    let removedFile = false;
    if (scope === "user" || scope === "both") {
      if (await removeMcpServerConfig("user", this.cwd, name, { userConfigPath: this.configOpts.userConfigPath })) {
        removedFile = true;
      }
    }
    if (scope === "project" || scope === "both") {
      if (await removeMcpServerConfig("project", this.cwd, name)) {
        removedFile = true;
      }
    }
    return hadMemory || removedFile;
  }

  async reconnectServer(name: string): Promise<McpServerStatus> {
    const existing = this.servers.get(name);
    if (!existing) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    const status = await this.upsertAndConnectDef(existing.def);
    this.syncRegistry();
    return status;
  }

  async toggleServer(name: string, disabled: boolean): Promise<McpServerStatus> {
    const existing = this.servers.get(name);
    if (!existing) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    if (existing.def.sourcePath) {
      await setMcpServerDisabledInFile(existing.def.sourcePath, name, disabled);
    }
    const nextDef: ResolvedMcpServerDef = { ...existing.def, disabled };
    const status = await this.upsertAndConnectDef(nextDef);
    this.syncRegistry();
    return status;
  }

  async trustServer(name: string): Promise<McpServerStatus> {
    const existing = this.servers.get(name);
    if (!existing) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    await trustProjectServer(this.cwd, name, existing.def.rawEntry, this.configOpts.trustFilePath);
    const nextDef: ResolvedMcpServerDef = { ...existing.def, trusted: true, trustReason: undefined };
    const status = await this.upsertAndConnectDef(nextDef);
    this.syncRegistry();
    return status;
  }

  listStatuses(): McpServerStatus[] {
    return [...this.servers.values()].map((m) => m.status);
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const managed = this.servers.get(serverName);
    if (!managed || !managed.client || managed.status.state !== "connected") {
      return textResult(`MCP server "${serverName}" is not connected`, true, { code: "E_TOOL_FAILED" });
    }
    try {
      const res = await managed.client.callTool(toolName, args ?? {}, signal);
      return formatMcpCallResult(res);
    } catch (err) {
      return textResult(
        `MCP call ${serverName}/${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        { code: "E_TOOL_FAILED" },
      );
    }
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<ToolResult> {
    const managed = this.servers.get(serverName);
    if (!managed || !managed.client || managed.status.state !== "connected") {
      return textResult(`MCP server "${serverName}" is not connected`, true, { code: "E_TOOL_FAILED" });
    }
    try {
      const res = await managed.client.readResource(uri, signal);
      return formatMcpResourceResult(res);
    } catch (err) {
      return textResult(
        `MCP resource read ${serverName}/${uri} failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        { code: "E_TOOL_FAILED" },
      );
    }
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const managed = this.servers.get(serverName);
    if (!managed || !managed.client || managed.status.state !== "connected") {
      return textResult(`MCP server "${serverName}" is not connected`, true, { code: "E_TOOL_FAILED" });
    }
    try {
      const res = await managed.client.getPrompt(promptName, args, signal);
      return formatMcpPromptResult(res);
    } catch (err) {
      return textResult(
        `MCP prompt ${serverName}/${promptName} failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        { code: "E_TOOL_FAILED" },
      );
    }
  }

  private async teardownManagedServer(name: string): Promise<void> {
    const existing = this.servers.get(name);
    if (!existing) return;
    if (this.registry) {
      for (const t of existing.registeredToolNames) {
        this.registry.unregister(t);
      }
    }
    if (existing.client) {
      await existing.client.dispose().catch(() => {});
    }
    this.servers.delete(name);
  }

  async dispose(): Promise<void> {
    for (const aux of this.auxiliaryToolNames) {
      this.registry?.unregister(aux);
    }
    this.auxiliaryToolNames = [];
    for (const name of [...this.servers.keys()]) {
      await this.teardownManagedServer(name);
    }
  }
}
