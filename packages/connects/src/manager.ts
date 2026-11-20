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
import { createMcpClient, type McpListChangedKind, type McpTransportClient, type RawMcpTool } from "./transports.js";
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
    const connectedStatuses = this.listStatuses().filter((s) => s.state === "connected");
    const hasAnyResources = connectedStatuses.some((s) => s.resources.length > 0);
    const hasAnyPrompts = connectedStatuses.some((s) => s.prompts.length > 0);
    const hasDeferredTools = connectedStatuses.some((s) => s.deferred === true && s.tools.length > 0);

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

    if (hasDeferredTools && !reg.has("mcp_tool_search")) {
      reg.register(this.createToolSearchTool());
      this.auxiliaryToolNames.push("mcp_tool_search");
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

  private createToolSearchTool(): ToolDefinition<{ query?: string; server?: string; activate?: boolean }> {
    return {
      name: "mcp_tool_search",
      description:
        "Search deferred MCP tools by keyword or server and activate matching tool schemas so they can be called directly.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword filter matching tool name or description (optional)" },
          server: { type: "string", description: "Filter to a specific deferred MCP server name (optional)" },
          activate: { type: "boolean", description: "Activate matched tools in the registry (default true)" },
        },
      },
      sideEffect: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      allowRepeatedCalls: true,
      execute: async (args): Promise<ToolResult> => {
        const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const serverFilter = typeof args.server === "string" ? args.server.trim() : "";
        const shouldActivate = args.activate !== false;

        const matches: Array<{ server: string; tool: McpToolInfo }> = [];
        for (const managed of this.servers.values()) {
          if (managed.status.state !== "connected" || !managed.def.deferred) continue;
          if (serverFilter && managed.def.name !== serverFilter) continue;
          for (const t of managed.status.tools) {
            if (query) {
              const haystack = `${managed.def.name} ${t.name} ${t.registeredName} ${t.description ?? ""}`.toLowerCase();
              if (!haystack.includes(query)) continue;
            }
            matches.push({ server: managed.def.name, tool: t });
          }
        }

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: "No matching deferred MCP tools found." }],
            isError: false,
          };
        }

        const slice = matches.slice(0, 15);
        let activatedCount = 0;
        const lines: string[] = [];
        for (const { server, tool } of slice) {
          const ok = shouldActivate ? (this.registry?.activateTool?.(tool.registeredName) ?? false) : false;
          if (ok) activatedCount += 1;
          const active = this.registry?.isToolActive?.(tool.registeredName) ?? ok;
          const paramKeys = Object.keys(tool.inputSchema?.properties ?? {});
          const paramsHint = paramKeys.length > 0 ? ` args=[${paramKeys.join(", ")}]` : "";
          lines.push(
            `- ${tool.registeredName} (${server}, ${active ? "active" : "deferred"})${paramsHint}${tool.description ? `: ${tool.description}` : ""}`,
          );
        }
        if (matches.length > slice.length) {
          lines.push(`... and ${matches.length - slice.length} more match(es). Refine query to activate specific tools.`);
        }
        if (shouldActivate && activatedCount > 0) {
          lines.push(`\nActivated ${activatedCount} tool(s); schemas are now available.`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
      },
    };
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
      ...(def.deferred ? { deferred: true } : {}),
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

    const client = createMcpClient(def, {
      onListChanged: (kind) => {
        void this.refreshServerCapabilities(def.name, kind);
      },
    });
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
      const [rawTools, resources, prompts] = await this.fetchServerCapabilities(client, def);
      const tools = this.buildToolInfos(def.name, rawTools);

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

  private async fetchServerCapabilities(
    client: McpTransportClient,
    def: ResolvedMcpServerDef,
  ): Promise<[RawMcpTool[], McpResourceInfo[], McpPromptInfo[]]> {
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
    return [rawTools, resources, prompts];
  }

  private buildToolInfos(serverName: string, rawTools: RawMcpTool[]): McpToolInfo[] {
    return rawTools.map((t) => ({
      name: t.name,
      registeredName: makeMcpToolName(serverName, t.name),
      ...(t.description ? { description: t.description } : {}),
      inputSchema: normalizeMcpInputSchema(t.inputSchema),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  }

  private async refreshServerCapabilities(serverName: string, kind: McpListChangedKind): Promise<void> {
    const managed = this.servers.get(serverName);
    if (!managed || !managed.client || managed.status.state !== "connected") return;
    const client = managed.client;
    try {
      if (kind === "tools") {
        let rawTools = await client.listTools();
        if (managed.def.includeTools && managed.def.includeTools.length > 0) {
          const allow = new Set(managed.def.includeTools);
          rawTools = rawTools.filter((t) => allow.has(t.name));
        }
        if (managed.def.excludeTools && managed.def.excludeTools.length > 0) {
          const deny = new Set(managed.def.excludeTools);
          rawTools = rawTools.filter((t) => !deny.has(t.name));
        }
        if (this.servers.get(serverName)?.client !== client) return;
        managed.rawTools = rawTools;
        managed.status = {
          ...managed.status,
          tools: this.buildToolInfos(serverName, rawTools),
        };
        this.syncRegistry();
      } else if (kind === "resources") {
        const resources = await client.listResources().catch((): McpResourceInfo[] => []);
        if (this.servers.get(serverName)?.client !== client) return;
        managed.status = { ...managed.status, resources };
        this.syncRegistry();
      } else if (kind === "prompts") {
        const prompts = await client.listPrompts().catch((): McpPromptInfo[] => []);
        if (this.servers.get(serverName)?.client !== client) return;
        managed.status = { ...managed.status, prompts };
        this.syncRegistry();
      }
    } catch (err) {
      this.logger.warn("mcp_list_changed_refresh_failed", {
        server: serverName,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  /**
   * Build ToolDefinitions backed by existing live MCP transports without
   * spawning duplicate servers. Used by subagents when `mcpServers` are allowlisted.
   */
  getToolDefinitions(opts: { serverNames?: string[]; readOnlyOnly?: boolean } = {}): ToolDefinition[] {
    const allowServers = opts.serverNames ? new Set(opts.serverNames) : null;
    const includeAll = allowServers?.has("*") ?? false;
    const out: ToolDefinition[] = [];
    for (const managed of this.servers.values()) {
      if (managed.status.state !== "connected" || !managed.client) continue;
      if (allowServers && !includeAll && !allowServers.has(managed.def.name)) continue;
      const client = managed.client;
      for (const t of managed.rawTools) {
        const meta = managed.status.tools.find((mt) => mt.name === t.name);
        const toolName = meta?.registeredName ?? makeMcpToolName(managed.def.name, t.name);
        const def = mcpToolToToolDefinition({
          serverName: managed.def.name,
          transport: managed.def.transport,
          tool: t,
          registeredName: toolName,
          deferred: false,
          invoke: (args, signal) => client.callTool(t.name, args, signal),
        });
        if (opts.readOnlyOnly && def.sideEffect !== "read") continue;
        out.push(def);
      }
    }
    return out;
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
