import type {
  BudgetLimits,
  BudgetTracker,
  ContextBuilder,
} from "@kern/agent-core";
import type { ConnectManager } from "@kern/connects";
import type {
  AskUserRequest,
  Logger,
  ModelAdapter,
  ThinkingLevel,
  ToolDefinition,
} from "@kern/protocol";
import type { ApprovalMeta, PolicyConfig, SafetyMode } from "@kern/tools";

export type SubagentKind = "local" | "a2a";
export type SubagentMode = "readonly" | "write";
export type SubagentIsolation = "readonly" | "exclusive" | "worktree";
export type SubagentOrigin = "user" | "project" | "memory";
export type SubagentFileFormat = "md" | "yaml" | "json";

export interface SubagentConfigEntry {
  name: string;
  description: string;
  instruction?: string;
  type?: SubagentKind;
  mode?: SubagentMode;
  isolation?: SubagentIsolation;
  tools?: string[];
  mcpServers?: string[];
  model?: string;
  strictModel?: boolean;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  maxTotalToolCalls?: number;
  maxWallTimeMs?: number;
  maxCost?: number;
  allowDelegation?: boolean;
  disabled?: boolean;
  /** Remote A2A agent base URL (when type === "a2a"). */
  url?: string;
  /** Optional HTTP headers for A2A endpoints (supports ${ENV_VAR} expansion). */
  headers?: Record<string, string>;
  /** Timeout for remote A2A calls (ms). */
  timeoutMs?: number;
}

export interface ResolvedSubagentDef {
  name: string;
  description: string;
  instruction: string;
  type: SubagentKind;
  mode: SubagentMode;
  isolation: SubagentIsolation;
  origin: SubagentOrigin;
  sourcePath?: string;
  tools?: string[];
  mcpServers?: string[];
  model?: string;
  strictModel: boolean;
  thinkingLevel?: ThinkingLevel;
  maxTurns: number;
  maxTotalToolCalls: number;
  maxWallTimeMs: number;
  maxCost?: number;
  allowDelegation: boolean;
  disabled: boolean;
  trusted: boolean;
  trustReason?: string;
  missingEnvVars: string[];
  url?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  rawEntry: SubagentConfigEntry;
}

export type SubagentState = "ready" | "disabled" | "untrusted" | "error";

export interface A2ASkillInfo {
  id?: string;
  name: string;
  description?: string;
}

export interface SubagentStatus {
  name: string;
  type: SubagentKind;
  mode: SubagentMode;
  isolation: SubagentIsolation;
  origin: SubagentOrigin;
  sourcePath?: string;
  description: string;
  model?: string;
  tools?: string[];
  mcpServers?: string[];
  url?: string;
  state: SubagentState;
  trusted: boolean;
  disabled: boolean;
  warning?: string;
  error?: string;
  skills?: A2ASkillInfo[];
}

export interface SubagentPreset {
  id: string;
  name: string;
  description: string;
  entry: SubagentConfigEntry;
}

export interface BackgroundDelegationStatus {
  jobId: string;
  agent: string;
  task: string;
  running: boolean;
  exitReason?: "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  turns: number;
  lastProgress?: string;
  output?: string;
  error?: string;
}

export interface SubagentToolRegistryLike {
  register(tool: ToolDefinition): void;
  unregister(name: string): void;
  has(name: string): boolean;
  toolNames(): string[];
}

export interface SubagentRuntimeHost {
  cwd: string;
  logger?: Logger;
  getModel: () => ModelAdapter;
  getThinkingLevel: () => ThinkingLevel;
  getParentBudget: () => BudgetTracker;
  getBudgetLimits: () => BudgetLimits;
  getPolicyConfig: () => PolicyConfig;
  getSafetyMode: () => SafetyMode;
  getPermissionRules?: () => { denyRules?: string[]; allowRules?: string[]; askRules?: string[] } | undefined;
  requestApproval?: (prompt: string, meta?: ApprovalMeta) => Promise<boolean | "session">;
  askUser?: (request: AskUserRequest) => Promise<string | null>;
  connects?: ConnectManager;
  contextBuilder?: ContextBuilder;
  storageRoot?: string;
  parentSessionId?: string | null;
}

export interface DelegateExecutionContext {
  depth: number;
  ancestors: ReadonlySet<string>;
}
