import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { expandEnvString } from "@kern/connects";
import type { ThinkingLevel } from "@kern/protocol";
import type {
  ResolvedSubagentDef,
  SubagentConfigEntry,
  SubagentFileFormat,
  SubagentIsolation,
  SubagentKind,
  SubagentMode,
  SubagentOrigin,
} from "./types.js";

const VALID_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOOL_CALLS = 30;
const DEFAULT_WALL_TIME_MS = 120_000;
const DEFAULT_A2A_TIMEOUT_MS = 60_000;

const PURE_READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "git-status",
  "git-diff",
  "git-log",
  "bash-status",
]);

const TOOL_GROUP_SHORTHANDS: Record<string, string[]> = {
  readonly: ["read", "grep", "find", "git-status", "git-diff", "git-log"],
  "read-only": ["read", "grep", "find", "git-status", "git-diff", "git-log"],
  coding: ["read", "write", "edit", "bash", "grep", "find", "git-status", "git-diff"],
  research: ["web-fetch", "read", "grep", "find"],
};

export const SUBAGENT_FORMAT_GUIDE = [
  "Subagent files can live in ~/.kern/agents/ (global) or .kern/agents/ (workspace),",
  "as .md, .yaml/.yml, or single-file .json, or grouped inside ~/.kern/agents.json / .kern/agents.json.",
  "",
  "1) Markdown with frontmatter (.kern/agents/security.md):",
  "   ---",
  "   name: security",
  "   description: Audits auth and input validation before merging",
  "   mode: readonly          # readonly | write",
  "   isolation: readonly     # readonly | exclusive | worktree",
  "   tools: [read, grep, find, git-diff]   # or shorthand: readonly | coding | research",
  "   mcpServers: [github]    # optional live parent MCP servers to share",
  "   model: openai/gpt-4o-mini",
  "   maxTurns: 10",
  "   ---",
  "   Inspect authentication and SQL queries carefully and cite file paths.",
  "",
  "2) Plain Markdown without frontmatter (.kern/agents/reviewer.md):",
  "   # Security Reviewer",
  "   Audits auth and API handlers for regressions.",
  "   Mode: readonly",
  "   Tools: readonly",
  "   ## Instructions",
  "   Read changed files and report severity + line numbers.",
  "",
  "3) Single-agent YAML (.kern/agents/coder.yaml) or JSON (.kern/agents/coder.json):",
  "   name: coder",
  "   description: Focused write specialist for scoped bug fixes",
  "   mode: write",
  "   isolation: worktree",
  "   tools: coding",
  "   instruction: |",
  "     Make minimal surgical edits and run vitest.",
].join("\n");

export function defaultUserAgentsDir(home = homedir()): string {
  return join(home, ".kern", "agents");
}

export function defaultUserAgentsJsonPath(home = homedir()): string {
  return join(home, ".kern", "agents.json");
}

export function defaultAgentTrustPath(home = homedir()): string {
  return join(home, ".kern", "agent-trust.json");
}

export function defaultProjectAgentsDir(cwd: string): string {
  return join(resolve(cwd), ".kern", "agents");
}

export function defaultProjectAgentsJsonPath(cwd: string): string {
  return join(resolve(cwd), ".kern", "agents.json");
}

function subagentFingerprint(cwd: string, name: string, entry: SubagentConfigEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cwd: resolve(cwd),
        name,
        type: entry.type ?? (entry.url ? "a2a" : "local"),
        mode: entry.mode ?? "readonly",
        isolation: entry.isolation ?? null,
        tools: entry.tools ?? null,
        mcpServers: entry.mcpServers ?? null,
        url: entry.url ?? null,
        allowDelegation: entry.allowDelegation === true,
        instruction: entry.instruction ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

interface TrustStore {
  trusted?: Record<string, string>;
}

async function readTrustStore(filePath: string): Promise<TrustStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TrustStore;
    }
  } catch {
    /* missing/invalid */
  }
  return {};
}

export async function trustProjectSubagent(
  cwd: string,
  name: string,
  entry: SubagentConfigEntry,
  trustFilePath = defaultAgentTrustPath(),
): Promise<void> {
  const store = await readTrustStore(trustFilePath);
  const trusted = { ...(store.trusted ?? {}) };
  trusted[`${resolve(cwd)}::${name}`] = subagentFingerprint(cwd, name, entry);
  await mkdir(dirname(trustFilePath), { recursive: true });
  await writeFile(trustFilePath, JSON.stringify({ trusted }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function stripInlineComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if ((ch === '"' || ch === "'") && raw[i - 1] !== "\\") {
      quote = quote === ch ? null : quote === null ? ch : quote;
    } else if (ch === "#" && quote === null && (i === 0 || /\s/.test(raw[i - 1]!))) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t) as string;
      } catch {
        /* fallback strip */
      }
    }
    return t.slice(1, -1);
  }
  return t;
}

function parseListValue(raw: string): string[] {
  const trimmed = stripInlineComment(raw);
  const bracket = trimmed.match(/^\[(.*)\]$/);
  const inner = bracket ? (bracket[1] ?? "") : trimmed;
  return inner
    .split(/[\s,]+/)
    .map((s) => unquote(s.trim()))
    .filter(Boolean);
}

function expandToolsList(rawTools: string[] | undefined): string[] | undefined {
  if (!rawTools || rawTools.length === 0) return undefined;
  const expanded: string[] = [];
  for (const item of rawTools) {
    const key = item.trim().toLowerCase();
    if (key === "all") return undefined;
    if (TOOL_GROUP_SHORTHANDS[key]) {
      expanded.push(...TOOL_GROUP_SHORTHANDS[key]!);
    } else if (item.trim()) {
      expanded.push(item.trim());
    }
  }
  return expanded.length > 0 ? [...new Set(expanded)] : undefined;
}

function normalizeFieldKey(rawKey: string): string {
  const normalized = rawKey.trim().replace(/[-_]+([a-zA-Z])/g, (_, c: string) => c.toUpperCase());
  const k = normalized ? normalized.charAt(0).toLowerCase() + normalized.slice(1) : "";
  const lower = k.toLowerCase();
  const aliasMap: Record<string, string> = {
    name: "name",
    role: "name",
    title: "name",
    description: "description",
    summary: "description",
    purpose: "description",
    about: "description",
    type: "type",
    url: "url",
    baseurl: "url",
    endpoint: "url",
    headers: "headers",
    mode: "mode",
    isolation: "isolation",
    tools: "tools",
    allowedtools: "tools",
    mcp: "mcpServers",
    mcpservers: "mcpServers",
    model: "model",
    strictmodel: "strictModel",
    thinking: "thinkingLevel",
    thinkinglevel: "thinkingLevel",
    maxturns: "maxTurns",
    maxtotaltoolcalls: "maxTotalToolCalls",
    maxtoolcalls: "maxTotalToolCalls",
    maxwalltimems: "maxWallTimeMs",
    maxcost: "maxCost",
    timeout: "timeoutMs",
    timeoutms: "timeoutMs",
    allowdelegation: "allowDelegation",
    disabled: "disabled",
    instruction: "instruction",
    instructions: "instruction",
    prompt: "instruction",
    systemprompt: "instruction",
  };
  return aliasMap[lower] ?? k;
}

function parseKeyValueBlock(lines: string[]): {
  fields: Record<string, string>;
  listFields: Record<string, string[]>;
  mapFields: Record<string, Record<string, string>>;
} {
  const fields: Record<string, string> = {};
  const listFields: Record<string, string[]> = {};
  const mapFields: Record<string, Record<string, string>> = {};

  let activeBlockKey: string | null = null;
  let blockKind: "list_or_map" | "multiline_literal" | "multiline_folded" | null = null;
  let blockBuffer: string[] = [];
  let blockIndent = -1;

  const flushBlock = () => {
    if (!activeBlockKey) return;
    if (blockKind === "multiline_literal") {
      fields[activeBlockKey] = blockBuffer.join("\n").trimEnd();
    } else if (blockKind === "multiline_folded") {
      fields[activeBlockKey] = blockBuffer.join(" ").replace(/\s+/g, " ").trim();
    }
    activeBlockKey = null;
    blockKind = null;
    blockBuffer = [];
    blockIndent = -1;
  };

  for (const rawLine of lines) {
    if (blockKind === "multiline_literal" || blockKind === "multiline_folded") {
      const indentMatch = rawLine.match(/^(\s*)(.*)$/);
      const indent = indentMatch?.[1]?.length ?? 0;
      const bodyText = indentMatch?.[2] ?? "";
      if (!rawLine.trim()) {
        blockBuffer.push("");
        continue;
      }
      if (blockIndent === -1 && indent > 0) blockIndent = indent;
      if (indent > 0 && indent >= Math.max(1, blockIndent)) {
        blockBuffer.push(rawLine.slice(blockIndent));
        continue;
      }
      flushBlock();
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (activeBlockKey && blockKind === "list_or_map") {
      const bullet = rawLine.match(/^\s+-\s+(.*)$/);
      if (bullet) {
        const val = unquote(stripInlineComment(bullet[1] ?? ""));
        if (val) listFields[activeBlockKey] = [...(listFields[activeBlockKey] ?? []), val];
        continue;
      }
      const nestedKv = rawLine.match(/^\s+([^:\s][^:]*?)\s*:\s*(.*)$/);
      if (nestedKv) {
        const subK = nestedKv[1]!.trim();
        const subV = unquote(stripInlineComment(nestedKv[2] ?? ""));
        if (subK && subV) {
          mapFields[activeBlockKey] = { ...(mapFields[activeBlockKey] ?? {}), [subK]: subV };
        }
        continue;
      }
    }

    const kv = rawLine.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) {
      flushBlock();
      continue;
    }

    flushBlock();
    const key = normalizeFieldKey(kv[1]!);
    const valRaw = (kv[2] ?? "").trim();

    if (valRaw === "|" || valRaw === "|-" || valRaw === "|+") {
      activeBlockKey = key;
      blockKind = "multiline_literal";
      blockBuffer = [];
      blockIndent = -1;
    } else if (valRaw === ">" || valRaw === ">-" || valRaw === ">+") {
      activeBlockKey = key;
      blockKind = "multiline_folded";
      blockBuffer = [];
      blockIndent = -1;
    } else if (!valRaw || valRaw.startsWith("#")) {
      activeBlockKey = key;
      blockKind = "list_or_map";
      listFields[key] = listFields[key] ?? [];
    } else {
      fields[key] = unquote(stripInlineComment(valRaw));
    }
  }
  flushBlock();
  return { fields, listFields, mapFields };
}

function buildEntryFromParsed(
  fields: Record<string, string>,
  listFields: Record<string, string[]>,
  mapFields: Record<string, Record<string, string>>,
  bodyInstruction: string,
  fallbackName: string,
): SubagentConfigEntry | null {
  const rawName = (fields["name"] || fallbackName).trim();
  const name = VALID_NAME_RE.test(rawName) ? rawName : fallbackName.trim();
  const instruction = (bodyInstruction || fields["instruction"] || "").trim();

  let description = (fields["description"] || "").trim();
  if (!description && instruction) {
    const firstNonHeading = instruction
      .split("\n")
      .map((l) => l.trim().replace(/^#+\s*/, ""))
      .find((l) => l.length > 0 && !/^(instructions?|system prompt|prompt)$/i.test(l));
    if (firstNonHeading) {
      description = firstNonHeading.length > 160 ? `${firstNonHeading.slice(0, 157)}...` : firstNonHeading;
    }
  }

  if (!name || !VALID_NAME_RE.test(name) || !description) return null;

  const toolsRaw = listFields["tools"]?.length
    ? expandToolsList(listFields["tools"])
    : fields["tools"]
      ? expandToolsList(parseListValue(fields["tools"]))
      : undefined;

  const mcpRaw = listFields["mcpServers"]?.length
    ? listFields["mcpServers"]
    : fields["mcpServers"]
      ? parseListValue(fields["mcpServers"])
      : undefined;

  const num = (k: string): number | undefined => {
    const v = fields[k];
    if (!v) return undefined;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const bool = (k: string): boolean | undefined => {
    const v = fields[k]?.toLowerCase();
    if (v === "true" || v === "yes") return true;
    if (v === "false" || v === "no") return false;
    return undefined;
  };

  const modeRaw = fields["mode"]?.toLowerCase();
  const mode: SubagentMode | undefined =
    modeRaw === "write" || modeRaw === "read-write" || modeRaw === "readwrite"
      ? "write"
      : modeRaw === "readonly" || modeRaw === "read-only" || modeRaw === "read"
        ? "readonly"
        : undefined;
  const isoRaw = fields["isolation"]?.toLowerCase();
  const isolation: SubagentIsolation | undefined =
    isoRaw === "readonly" || isoRaw === "exclusive" || isoRaw === "worktree" ? isoRaw : undefined;
  const thinkRaw = fields["thinkingLevel"]?.toLowerCase();
  const thinkingLevel: ThinkingLevel | undefined =
    thinkRaw === "off" || thinkRaw === "low" || thinkRaw === "medium" || thinkRaw === "high" ? thinkRaw : undefined;

  const headers = mapFields["headers"] && Object.keys(mapFields["headers"]).length > 0 ? mapFields["headers"] : undefined;

  return {
    name,
    description,
    ...(instruction ? { instruction } : {}),
    ...(fields["type"] === "a2a" || fields["url"] ? { type: "a2a" as const } : { type: "local" as const }),
    ...(fields["url"] ? { url: fields["url"] } : {}),
    ...(headers ? { headers } : {}),
    ...(mode ? { mode } : {}),
    ...(isolation ? { isolation } : {}),
    ...(toolsRaw && toolsRaw.length > 0 ? { tools: toolsRaw } : {}),
    ...(mcpRaw && mcpRaw.length > 0 ? { mcpServers: mcpRaw } : {}),
    ...(fields["model"] ? { model: fields["model"] } : {}),
    ...(bool("strictModel") !== undefined ? { strictModel: bool("strictModel") } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(num("maxTurns") !== undefined ? { maxTurns: num("maxTurns") } : {}),
    ...(num("maxTotalToolCalls") !== undefined ? { maxTotalToolCalls: num("maxTotalToolCalls") } : {}),
    ...(num("maxWallTimeMs") !== undefined ? { maxWallTimeMs: num("maxWallTimeMs") } : {}),
    ...(num("maxCost") !== undefined ? { maxCost: num("maxCost") } : {}),
    ...(num("timeoutMs") !== undefined ? { timeoutMs: num("timeoutMs") } : {}),
    ...(bool("allowDelegation") !== undefined ? { allowDelegation: bool("allowDelegation") } : {}),
    ...(bool("disabled") !== undefined ? { disabled: bool("disabled") } : {}),
  };
}

/**
 * Parse YAML subagent definition (`.yaml` / `.yml`).
 */
export function parseSubagentYaml(content: string, fallbackName: string): SubagentConfigEntry | null {
  const norm = content.replace(/\r\n/g, "\n").trim();
  if (!norm) return null;
  const lines = norm.split("\n").filter((l, idx) => {
    const t = l.trim();
    if (idx === 0 && t === "---") return false;
    if (t === "...") return false;
    return true;
  });
  const { fields, listFields, mapFields } = parseKeyValueBlock(lines);
  return buildEntryFromParsed(fields, listFields, mapFields, "", fallbackName);
}

/**
 * Parse a Markdown subagent file. Supports BOTH YAML frontmatter (`--- ... ---`)
 * and user-friendly frontmatter-free plain Markdown (`# Heading`, optional `Mode: ...`, `## Instructions`).
 */
export function parseSubagentMarkdown(content: string, fallbackName: string): SubagentConfigEntry | null {
  const norm = content.replace(/\r\n/g, "\n");
  const fmMatch = norm.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const { fields, listFields, mapFields } = parseKeyValueBlock((fmMatch[1] ?? "").split("\n"));
    return buildEntryFromParsed(fields, listFields, mapFields, fmMatch[2] ?? "", fallbackName);
  }

  // Frontmatter-free plain Markdown support
  const trimmed = norm.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  const fields: Record<string, string> = {};
  const listFields: Record<string, string[]> = {};
  let cursor = 0;

  // Optional `# Title` heading
  let headingText = "";
  if (lines[0] && /^#\s+/.test(lines[0])) {
    headingText = lines[0].replace(/^#\s+/, "").trim();
    if (headingText && VALID_NAME_RE.test(headingText)) {
      fields["name"] = headingText;
    }
    cursor = 1;
  }

  while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;

  // Optional short summary paragraph directly under `# Heading` (before Key: Value metadata)
  const metaLines: string[] = [];
  const bodyLines: string[] = [];
  let inMetaPhase = true;

  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (inMetaPhase && /^##\s+(?:instructions?|system prompt|prompt)\b/i.test(t)) {
      inMetaPhase = false;
      continue;
    }
    if (inMetaPhase) {
      const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]{1,30})\s*:\s*(.+)$/);
      if (kv) {
        const canonical = normalizeFieldKey(kv[1]!);
        const knownKeys = new Set([
          "name",
          "description",
          "type",
          "url",
          "mode",
          "isolation",
          "tools",
          "mcpServers",
          "model",
          "strictModel",
          "thinkingLevel",
          "maxTurns",
          "maxTotalToolCalls",
          "maxWallTimeMs",
          "maxCost",
          "timeoutMs",
          "allowDelegation",
          "disabled",
        ]);
        if (knownKeys.has(canonical)) {
          metaLines.push(line);
          continue;
        }
      }
      if (!t && metaLines.length > 0 && bodyLines.length === 0) {
        // Blank line after metadata transitions to instruction body
        inMetaPhase = false;
        continue;
      }
      if (metaLines.length === 0 && !fields["description"] && t && !t.startsWith("#")) {
        // Treat initial plain summary line before metadata as candidate description & also preserve in body if no later body
        bodyLines.push(line);
        continue;
      }
      inMetaPhase = false;
    }
    bodyLines.push(line);
  }

  const parsedMeta = parseKeyValueBlock(metaLines);
  for (const [k, v] of Object.entries(parsedMeta.fields)) fields[k] = v;
  for (const [k, v] of Object.entries(parsedMeta.listFields)) listFields[k] = v;

  const instruction = bodyLines.join("\n").trim() || headingText;
  if (!fields["description"] && headingText && bodyLines.length === 0) {
    fields["description"] = headingText;
  }

  return buildEntryFromParsed(fields, listFields, parsedMeta.mapFields, instruction, fallbackName);
}

/**
 * Unified parser for `.md`, `.yaml`/`.yml`, `.json`, or pasted raw text.
 */
export function parseSubagentFile(
  content: string,
  fileNameOrExt = "",
  fallbackName = "custom-agent",
): SubagentConfigEntry | null {
  const ext = fileNameOrExt.startsWith(".") ? fileNameOrExt.toLowerCase() : extname(fileNameOrExt).toLowerCase();
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (ext === ".json" || (!ext && trimmed.startsWith("{"))) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Support either direct SubagentConfigEntry object or { agents: { name: ... } }
        if (parsed["agents"] && typeof parsed["agents"] === "object" && !Array.isArray(parsed["agents"])) {
          const entries = Object.entries(parsed["agents"] as Record<string, SubagentConfigEntry>);
          if (entries.length > 0) {
            const [k, item] = entries[0]!;
            return { ...item, name: item.name?.trim() || k };
          }
        }
        const raw = parsed as Partial<SubagentConfigEntry>;
        const name = (raw.name || fallbackName).trim();
        const description = (raw.description || "").trim() || (raw.instruction ? String(raw.instruction).slice(0, 140) : "");
        if (!name || !VALID_NAME_RE.test(name) || !description) return null;
        return {
          ...(raw as SubagentConfigEntry),
          name,
          description,
          ...(raw.tools ? { tools: expandToolsList(raw.tools) } : {}),
        };
      }
    } catch {
      return null;
    }
  }

  if (ext === ".yaml" || ext === ".yml") {
    return parseSubagentYaml(content, fallbackName);
  }

  if (ext === ".md" || ext === ".markdown") {
    return parseSubagentMarkdown(content, fallbackName);
  }

  // Auto-detect raw pasted text
  if (trimmed.startsWith("---\n") || trimmed.startsWith("#")) {
    return parseSubagentMarkdown(content, fallbackName);
  }
  return parseSubagentYaml(content, fallbackName) ?? parseSubagentMarkdown(content, fallbackName);
}

export function renderSubagentMarkdown(entry: SubagentConfigEntry): string {
  const lines: string[] = ["---", `name: ${entry.name}`, `description: ${JSON.stringify(entry.description)}`];
  if (entry.type) lines.push(`type: ${entry.type}`);
  if (entry.url) lines.push(`url: ${entry.url}`);
  if (entry.headers && Object.keys(entry.headers).length > 0) {
    lines.push("headers:");
    for (const [k, v] of Object.entries(entry.headers)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (entry.mode) lines.push(`mode: ${entry.mode}`);
  if (entry.isolation) lines.push(`isolation: ${entry.isolation}`);
  if (entry.model) lines.push(`model: ${entry.model}`);
  if (entry.strictModel) lines.push("strictModel: true");
  if (entry.thinkingLevel) lines.push(`thinkingLevel: ${entry.thinkingLevel}`);
  if (entry.tools && entry.tools.length > 0) lines.push(`tools: [${entry.tools.join(", ")}]`);
  if (entry.mcpServers && entry.mcpServers.length > 0) lines.push(`mcpServers: [${entry.mcpServers.join(", ")}]`);
  if (entry.maxTurns !== undefined) lines.push(`maxTurns: ${entry.maxTurns}`);
  if (entry.maxTotalToolCalls !== undefined) lines.push(`maxTotalToolCalls: ${entry.maxTotalToolCalls}`);
  if (entry.maxWallTimeMs !== undefined) lines.push(`maxWallTimeMs: ${entry.maxWallTimeMs}`);
  if (entry.maxCost !== undefined) lines.push(`maxCost: ${entry.maxCost}`);
  if (entry.allowDelegation) lines.push("allowDelegation: true");
  if (entry.disabled) lines.push("disabled: true");
  lines.push("---", "");
  if (entry.instruction) lines.push(entry.instruction.trim(), "");
  return lines.join("\n");
}

export function renderSubagentYaml(entry: SubagentConfigEntry): string {
  const lines: string[] = [
    `name: ${entry.name}`,
    `description: ${JSON.stringify(entry.description)}`,
    `type: ${entry.type ?? (entry.url ? "a2a" : "local")}`,
  ];
  if (entry.url) lines.push(`url: ${entry.url}`);
  if (entry.mode) lines.push(`mode: ${entry.mode}`);
  if (entry.isolation) lines.push(`isolation: ${entry.isolation}`);
  if (entry.model) lines.push(`model: ${entry.model}`);
  if (entry.strictModel) lines.push("strictModel: true");
  if (entry.thinkingLevel) lines.push(`thinkingLevel: ${entry.thinkingLevel}`);
  if (entry.tools && entry.tools.length > 0) lines.push(`tools: [${entry.tools.join(", ")}]`);
  if (entry.mcpServers && entry.mcpServers.length > 0) lines.push(`mcpServers: [${entry.mcpServers.join(", ")}]`);
  if (entry.maxTurns !== undefined) lines.push(`maxTurns: ${entry.maxTurns}`);
  if (entry.maxTotalToolCalls !== undefined) lines.push(`maxTotalToolCalls: ${entry.maxTotalToolCalls}`);
  if (entry.maxWallTimeMs !== undefined) lines.push(`maxWallTimeMs: ${entry.maxWallTimeMs}`);
  if (entry.maxCost !== undefined) lines.push(`maxCost: ${entry.maxCost}`);
  if (entry.allowDelegation) lines.push("allowDelegation: true");
  if (entry.disabled) lines.push("disabled: true");
  if (entry.instruction) {
    lines.push("instruction: |");
    for (const ln of entry.instruction.trim().split("\n")) {
      lines.push(`  ${ln}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderSubagentTemplate(entry: SubagentConfigEntry, format: SubagentFileFormat = "md"): string {
  if (format === "json") {
    return JSON.stringify(entry, null, 2) + "\n";
  }
  if (format === "yaml") {
    return [
      "# Kern Subagent Configuration (YAML)",
      "# mode: readonly | write  ·  isolation: readonly | exclusive | worktree",
      "# tools shorthands: readonly | coding | research  (or list: read, grep, find, write, edit, bash, git-diff, web-fetch)",
      renderSubagentYaml(entry).trimEnd(),
      "",
    ].join("\n");
  }
  return [
    "---",
    `name: ${entry.name}`,
    `description: ${JSON.stringify(entry.description)}`,
    `# mode: readonly | write`,
    `mode: ${entry.mode ?? "readonly"}`,
    `# isolation: readonly | exclusive | worktree`,
    `isolation: ${entry.isolation ?? (entry.mode === "write" ? "exclusive" : "readonly")}`,
    `# tools: [read, grep, find, git-status, git-diff, git-log] or shorthand: readonly | coding | research`,
    `tools: [${(entry.tools ?? ["read", "grep", "find"]).join(", ")}]`,
    entry.mcpServers?.length ? `mcpServers: [${entry.mcpServers.join(", ")}]` : `# mcpServers: [github]`,
    entry.model ? `model: ${entry.model}` : `# model: provider/modelId`,
    `maxTurns: ${entry.maxTurns ?? 12}`,
    "---",
    "",
    entry.instruction?.trim() ||
      `You are the "${entry.name}" specialist.\nExplain findings concisely with exact file paths, line numbers, and actionable recommendations.`,
    "",
  ].join("\n");
}

function requiresProjectTrust(entry: SubagentConfigEntry, mode: SubagentMode, kind: SubagentKind): boolean {
  if (kind === "a2a") return true;
  if (mode === "write") return true;
  if (entry.allowDelegation === true) return true;
  if (entry.mcpServers && entry.mcpServers.length > 0) return true;
  if (entry.tools && entry.tools.some((t) => !PURE_READ_TOOLS.has(t))) {
    return true;
  }
  return false;
}

function resolveEntry(
  rawEntry: SubagentConfigEntry,
  origin: SubagentOrigin,
  cwd: string,
  opts: {
    sourcePath?: string;
    allowProjectUntrusted?: boolean;
    trustMap?: Record<string, string>;
    envSource?: Record<string, string | undefined>;
  },
): ResolvedSubagentDef | null {
  const name = rawEntry.name?.trim();
  const description = rawEntry.description?.trim();
  if (!name || !VALID_NAME_RE.test(name) || !description) return null;

  const kind: SubagentKind = rawEntry.type === "a2a" || (!!rawEntry.url && !rawEntry.instruction) ? "a2a" : "local";
  const mode: SubagentMode = rawEntry.mode === "write" ? "write" : "readonly";
  const isolation: SubagentIsolation =
    kind === "a2a"
      ? "readonly"
      : rawEntry.isolation === "worktree" || rawEntry.isolation === "exclusive" || rawEntry.isolation === "readonly"
        ? mode === "readonly" && rawEntry.isolation !== "readonly"
          ? "readonly"
          : rawEntry.isolation
        : mode === "write"
          ? "exclusive"
          : "readonly";

  const envSource = opts.envSource ?? process.env;
  const missing = new Set<string>();

  let resolvedUrl: string | undefined;
  let resolvedHeaders: Record<string, string> | undefined;
  if (kind === "a2a") {
    const rawUrl = typeof rawEntry.url === "string" ? rawEntry.url.trim() : "";
    const expUrl = expandEnvString(rawUrl, envSource);
    for (const m of expUrl.missing) missing.add(m);
    if (!/^https?:\/\//i.test(expUrl.value)) return null;
    resolvedUrl = expUrl.value;

    if (rawEntry.headers && typeof rawEntry.headers === "object" && !Array.isArray(rawEntry.headers)) {
      resolvedHeaders = {};
      for (const [k, v] of Object.entries(rawEntry.headers)) {
        if (typeof v !== "string") continue;
        const expH = expandEnvString(v, envSource);
        for (const m of expH.missing) missing.add(m);
        if (expH.value.length > 0 && expH.value.length <= 4096) {
          resolvedHeaders[k.slice(0, 128)] = expH.value;
        }
      }
      if (Object.keys(resolvedHeaders).length === 0) resolvedHeaders = undefined;
    }
  }

  let trusted = true;
  let trustReason: string | undefined;
  if (origin === "project" && !opts.allowProjectUntrusted && requiresProjectTrust(rawEntry, mode, kind)) {
    const fp = subagentFingerprint(cwd, name, rawEntry);
    const saved = opts.trustMap?.[`${resolve(cwd)}::${name}`];
    if (saved !== fp) {
      trusted = false;
      trustReason = `Project subagent "${name}" (${kind === "a2a" ? "remote A2A" : mode}) requires trust approval (run /agents trust ${name} or kern agents trust ${name}).`;
    }
  }

  const clampInt = (val: unknown, fallback: number, min: number, max: number): number =>
    typeof val === "number" && Number.isFinite(val) ? Math.max(min, Math.min(max, Math.round(val))) : fallback;

  return {
    name,
    description,
    instruction: rawEntry.instruction?.trim() || description,
    type: kind,
    mode,
    isolation,
    origin,
    sourcePath: opts.sourcePath,
    ...(rawEntry.tools ? { tools: [...new Set(rawEntry.tools)] } : {}),
    ...(rawEntry.mcpServers ? { mcpServers: [...new Set(rawEntry.mcpServers)] } : {}),
    ...(rawEntry.model ? { model: rawEntry.model.trim() } : {}),
    strictModel: rawEntry.strictModel === true,
    ...(rawEntry.thinkingLevel ? { thinkingLevel: rawEntry.thinkingLevel } : {}),
    maxTurns: clampInt(rawEntry.maxTurns, DEFAULT_MAX_TURNS, 1, 50),
    maxTotalToolCalls: clampInt(rawEntry.maxTotalToolCalls, DEFAULT_MAX_TOOL_CALLS, 1, 200),
    maxWallTimeMs: clampInt(rawEntry.maxWallTimeMs, DEFAULT_WALL_TIME_MS, 5_000, 600_000),
    ...(typeof rawEntry.maxCost === "number" && Number.isFinite(rawEntry.maxCost) && rawEntry.maxCost > 0
      ? { maxCost: rawEntry.maxCost }
      : {}),
    allowDelegation: rawEntry.allowDelegation === true,
    disabled: rawEntry.disabled === true,
    trusted,
    trustReason,
    missingEnvVars: [...missing],
    ...(resolvedUrl ? { url: resolvedUrl } : {}),
    ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
    timeoutMs: clampInt(rawEntry.timeoutMs, DEFAULT_A2A_TIMEOUT_MS, 1_000, 300_000),
    rawEntry,
  };
}

interface RawAgentsJson {
  agents?: Record<string, Omit<SubagentConfigEntry, "name"> & { name?: string }>;
}

async function readAgentsDir(
  dirPath: string,
  origin: SubagentOrigin,
  warnings: string[],
): Promise<Array<{ entry: SubagentConfigEntry; origin: SubagentOrigin; sourcePath: string }>> {
  const out: Array<{ entry: SubagentConfigEntry; origin: SubagentOrigin; sourcePath: string }> = [];
  let names: string[];
  try {
    names = (await readdir(dirPath)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(`Failed reading subagent directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }
  for (const file of names) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".md" && ext !== ".markdown" && ext !== ".yaml" && ext !== ".yml" && ext !== ".json") continue;
    const stem = file.slice(0, file.length - ext.length);
    const abs = join(dirPath, file);
    try {
      const content = await readFile(abs, "utf8");
      if (ext === ".json") {
        const rawJson = JSON.parse(content) as unknown;
        if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
          const rec = rawJson as Record<string, unknown>;
          if (rec["agents"] && typeof rec["agents"] === "object" && !Array.isArray(rec["agents"])) {
            for (const [k, item] of Object.entries(rec["agents"] as Record<string, SubagentConfigEntry>)) {
              if (!item || typeof item !== "object") continue;
              out.push({ entry: { ...item, name: item.name?.trim() || k }, origin, sourcePath: abs });
            }
            continue;
          }
        }
      }
      const parsed = parseSubagentFile(content, ext, stem);
      if (!parsed) {
        warnings.push(`Ignored invalid subagent file ${abs} (requires valid name and description/instructions)`);
        continue;
      }
      out.push({ entry: parsed, origin, sourcePath: abs });
    } catch (err) {
      warnings.push(`Failed reading subagent ${abs}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

async function readAgentsJson(
  filePath: string,
  origin: SubagentOrigin,
  warnings: string[],
): Promise<Array<{ entry: SubagentConfigEntry; origin: SubagentOrigin; sourcePath: string }>> {
  const out: Array<{ entry: SubagentConfigEntry; origin: SubagentOrigin; sourcePath: string }> = [];
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RawAgentsJson;
    if (!parsed || typeof parsed !== "object" || !parsed.agents || typeof parsed.agents !== "object") return out;
    for (const [key, item] of Object.entries(parsed.agents)) {
      if (!item || typeof item !== "object") continue;
      out.push({
        entry: { ...item, name: item.name?.trim() || key },
        origin,
        sourcePath: filePath,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(`Invalid subagent JSON config ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export interface LoadSubagentsOptions {
  userAgentsDir?: string;
  userAgentsJsonPath?: string;
  trustFilePath?: string;
  allowProjectUntrusted?: boolean;
  envSource?: Record<string, string | undefined>;
}

export async function loadSubagentConfigs(
  cwd: string,
  opts: LoadSubagentsOptions = {},
): Promise<{ defs: ResolvedSubagentDef[]; warnings: string[] }> {
  const root = resolve(cwd);
  const envSource = opts.envSource ?? process.env;
  const userDir = opts.userAgentsDir ?? defaultUserAgentsDir();
  const userJson = opts.userAgentsJsonPath ?? defaultUserAgentsJsonPath();
  const trustPath = opts.trustFilePath ?? defaultAgentTrustPath();
  const trustStore = await readTrustStore(trustPath);
  const trustMap = trustStore.trusted ?? {};

  const warnings: string[] = [];
  const rawItems = [
    ...(await readAgentsDir(userDir, "user", warnings)),
    ...(await readAgentsJson(userJson, "user", warnings)),
    ...(await readAgentsDir(defaultProjectAgentsDir(root), "project", warnings)),
    ...(await readAgentsJson(defaultProjectAgentsJsonPath(root), "project", warnings)),
  ];

  const defs: ResolvedSubagentDef[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    if (seen.has(item.entry.name)) continue;
    const resolved = resolveEntry(item.entry, item.origin, root, {
      sourcePath: item.sourcePath,
      allowProjectUntrusted: opts.allowProjectUntrusted,
      trustMap,
      envSource,
    });
    if (!resolved) {
      warnings.push(`Ignored invalid subagent entry "${item.entry.name}" (${item.sourcePath})`);
      continue;
    }
    seen.add(resolved.name);
    if (!resolved.trusted && resolved.trustReason) warnings.push(resolved.trustReason);
    if (resolved.missingEnvVars.length > 0) {
      warnings.push(`Subagent "${resolved.name}" references unset env var(s): ${resolved.missingEnvVars.join(", ")}`);
    }
    defs.push(resolved);
  }

  return { defs, warnings };
}

export async function saveSubagentConfig(
  scope: "user" | "project",
  cwd: string,
  entry: SubagentConfigEntry,
  opts: { userAgentsDir?: string; userAgentsJsonPath?: string; format?: SubagentFileFormat; templateComments?: boolean } = {},
): Promise<string> {
  if (!VALID_NAME_RE.test(entry.name)) {
    throw new Error(`Invalid subagent name "${entry.name}": use [A-Za-z0-9_.-] (1-64 chars)`);
  }
  if (!entry.description.trim()) {
    throw new Error("Subagent description is required.");
  }

  // Remote A2A agents without explicit md/yaml format default cleanly to agents.json
  if ((entry.type === "a2a" || entry.url) && !opts.format) {
    const filePath =
      scope === "user"
        ? (opts.userAgentsJsonPath ?? defaultUserAgentsJsonPath())
        : defaultProjectAgentsJsonPath(cwd);
    let doc: RawAgentsJson = {};
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as RawAgentsJson;
    } catch {
      doc = {};
    }
    const nextDoc: RawAgentsJson = {
      ...doc,
      agents: {
        ...(doc.agents ?? {}),
        [entry.name]: { ...entry, type: "a2a" },
      },
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(nextDoc, null, 2) + "\n", {
      encoding: "utf8",
      mode: scope === "user" ? 0o600 : 0o644,
    });
    return filePath;
  }

  const format: SubagentFileFormat = opts.format ?? "md";
  const dir = scope === "user" ? (opts.userAgentsDir ?? defaultUserAgentsDir()) : defaultProjectAgentsDir(cwd);
  const filePath = join(dir, `${entry.name}.${format}`);
  const body = opts.templateComments
    ? renderSubagentTemplate(entry, format)
    : format === "json"
      ? JSON.stringify(entry, null, 2) + "\n"
      : format === "yaml"
        ? renderSubagentYaml(entry)
        : renderSubagentMarkdown(entry);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, body, {
    encoding: "utf8",
    mode: scope === "user" ? 0o600 : 0o644,
  });
  return filePath;
}

export async function removeSubagentConfig(
  scope: "user" | "project",
  cwd: string,
  name: string,
  opts: { userAgentsDir?: string; userAgentsJsonPath?: string } = {},
): Promise<boolean> {
  let removed = false;
  const dir = scope === "user" ? (opts.userAgentsDir ?? defaultUserAgentsDir()) : defaultProjectAgentsDir(cwd);
  for (const ext of ["md", "markdown", "yaml", "yml", "json"]) {
    try {
      await unlink(join(dir, `${name}.${ext}`));
      removed = true;
    } catch {
      /* ignore */
    }
  }
  const jsonPath =
    scope === "user" ? (opts.userAgentsJsonPath ?? defaultUserAgentsJsonPath()) : defaultProjectAgentsJsonPath(cwd);
  try {
    const doc = JSON.parse(await readFile(jsonPath, "utf8")) as RawAgentsJson;
    if (doc?.agents && name in doc.agents) {
      delete doc.agents[name];
      await writeFile(jsonPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
      removed = true;
    }
  } catch {
    /* ignore */
  }
  return removed;
}

export async function setSubagentDisabledInFile(
  def: ResolvedSubagentDef,
  disabled: boolean,
): Promise<boolean> {
  if (!def.sourcePath) return false;
  try {
    if (def.sourcePath.endsWith(".json")) {
      const parsed = JSON.parse(await readFile(def.sourcePath, "utf8")) as Record<string, unknown>;
      if (parsed && parsed["agents"] && typeof parsed["agents"] === "object") {
        const doc = parsed as RawAgentsJson;
        const entry = doc?.agents?.[def.name];
        if (!entry) return false;
        if (disabled) entry.disabled = true;
        else delete entry.disabled;
        await writeFile(def.sourcePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
        return true;
      }
      const nextObj: SubagentConfigEntry = { ...def.rawEntry, disabled };
      await writeFile(def.sourcePath, JSON.stringify(nextObj, null, 2) + "\n", "utf8");
      return true;
    }
    const nextEntry: SubagentConfigEntry = {
      ...def.rawEntry,
      disabled,
    };
    if (def.sourcePath.endsWith(".yaml") || def.sourcePath.endsWith(".yml")) {
      await writeFile(def.sourcePath, renderSubagentYaml(nextEntry), "utf8");
      return true;
    }
    await writeFile(def.sourcePath, renderSubagentMarkdown(nextEntry), "utf8");
    return true;
  } catch {
    return false;
  }
}
