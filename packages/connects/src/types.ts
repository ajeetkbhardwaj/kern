import type { JsonSchema, ToolAnnotations, ToolDefinition } from "@kern/protocol";

export type McpTransportType = "stdio" | "http" | "sse";

export type McpServerOrigin = "env" | "user" | "project" | "memory";

export interface McpServerConfigEntry {
  /** Optional explicit transport. Inferred from url/command when omitted. */
  type?: "stdio" | "http" | "streamable-http" | "sse";
  transport?: McpTransportType;
  /** Remote server URL (Streamable HTTP or SSE). */
  url?: string;
  /** Extra HTTP headers (supports ${ENV_VAR} expansion). */
  headers?: Record<string, string>;
  /** Executable command for stdio transport. */
  command?: string;
  /** Arguments array for stdio command. */
  args?: string[];
  /** Extra environment variables for stdio command (supports ${ENV_VAR} expansion). */
  env?: Record<string, string>;
  /** Working directory override for stdio command. */
  cwd?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Skip connecting this server when true. */
  disabled?: boolean;
  /** Withhold tool schemas until explicitly activated via ToolRegistry. */
  deferred?: boolean;
  /** Optional allowlist/denylist of remote tool names on this server. */
  includeTools?: string[];
  excludeTools?: string[];
}

export interface ResolvedMcpServerDef {
  name: string;
  transport: McpTransportType;
  origin: McpServerOrigin;
  sourcePath?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Raw shell command string (e.g. from KERN_MCP_COMMAND). */
  shellCommand?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  disabled: boolean;
  deferred: boolean;
  trusted: boolean;
  trustReason?: string;
  missingEnvVars: string[];
  includeTools?: string[];
  excludeTools?: string[];
  rawEntry: McpServerConfigEntry;
}

export interface McpToolInfo {
  name: string;
  registeredName: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export type McpConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disabled"
  | "untrusted"
  | "error";

export interface McpServerStatus {
  name: string;
  transport: McpTransportType;
  origin: McpServerOrigin;
  sourcePath?: string;
  target: string;
  state: McpConnectionState;
  trusted: boolean;
  disabled: boolean;
  deferred?: boolean;
  error?: string;
  warning?: string;
  serverInfo?: { name?: string; version?: string };
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  lastConnectedAt?: string;
}

export interface ConnectorPresetVar {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  target: "env" | "header" | "arg" | "url";
  headerName?: string;
}

export interface ConnectorPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransportType;
  entry: McpServerConfigEntry;
  variables?: ConnectorPresetVar[];
}

export interface ToolRegistryLike {
  register(tool: ToolDefinition): void;
  unregister(name: string): void;
  has(name: string): boolean;
  toolNames(): string[];
  activateTool?(name: string): boolean;
  isToolActive?(name: string): boolean;
}
