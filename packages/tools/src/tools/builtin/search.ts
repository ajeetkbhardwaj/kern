import { ToolDefinition, ToolResult, boundText, textResult } from "@kern/protocol";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadAgentIgnore, isPathIgnored } from "../../agentignore.js";
import { safeResolveSync } from "../../path-safety.js";

const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.trim();
  let regex = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          regex += "(?:.*/)?";
          i++;
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex, "i");
}

async function walkWorkspaceFiles(
  workspaceRoot: string,
  startDir: string,
  opts: { includeDirs?: boolean; signal?: AbortSignal; maxEntries?: number } = {},
): Promise<Array<{ abs: string; rel: string; kind: "file" | "dir" }>> {
  const ignoreConfig = await loadAgentIgnore(workspaceRoot).catch(() => null);
  const results: Array<{ abs: string; rel: string; kind: "file" | "dir" }> = [];
  const cap = opts.maxEntries ?? 10_000;

  async function walk(dir: string): Promise<void> {
    if (opts.signal?.aborted || results.length >= cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (opts.signal?.aborted || results.length >= cap) break;
      const abs = join(dir, entry.name);
      const rel = relative(workspaceRoot, abs).split("\\").join("/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (ignoreConfig && isPathIgnored(ignoreConfig, abs)) continue;
        if (opts.includeDirs) results.push({ abs, rel, kind: "dir" });
        await walk(abs);
      } else if (entry.isFile()) {
        if (ignoreConfig && isPathIgnored(ignoreConfig, abs)) continue;
        results.push({ abs, rel, kind: "file" });
      }
    }
  }

  await walk(startDir);
  return results;
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  glob?: string;
  maxResults?: number;
}

export function createGrepTool(_root: string): ToolDefinition<GrepArgs> {
  return {
    name: "grep",
    description: "Search file contents across workspace files (respects .agentignore and skips binary files)",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex pattern to search for" },
        path: { type: "string", description: "Subdirectory or file to search (default: workspace root)" },
        regex: { type: "boolean", default: false, description: "Treat pattern as JavaScript RegExp" },
        caseInsensitive: { type: "boolean", default: false, description: "Case-insensitive search" },
        glob: { type: "string", description: "Optional filename/path glob filter (e.g. '*.ts' or 'src/**')" },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["pattern"],
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      if (!args.pattern) return textResult("pattern must be non-empty", true, { code: "E_TOOL_INVALID_ARGS" });
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }

      let matcher: RegExp;
      try {
        const flags = args.caseInsensitive ? "i" : "";
        matcher = args.regex
          ? new RegExp(args.pattern, flags)
          : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      } catch (error) {
        return textResult(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`, true, {
          code: "E_TOOL_INVALID_ARGS",
        });
      }

      const globMatcher = args.glob ? globToRegex(args.glob.includes("/") ? args.glob : `**/${args.glob}`) : null;
      const maxResults = Math.max(1, Math.min(500, args.maxResults ?? 100));

      try {
        const st = await stat(target);
        const candidates = st.isFile()
          ? [{ abs: target, rel: relative(ctx.workspaceRoot, target).split("\\").join("/"), kind: "file" as const }]
          : await walkWorkspaceFiles(ctx.workspaceRoot, target, { signal: ctx.signal });

        const matches: string[] = [];
        for (const file of candidates) {
          if (ctx.signal.aborted || matches.length >= maxResults) break;
          if (globMatcher && !globMatcher.test(file.rel)) continue;
          const fileStat = await stat(file.abs).catch(() => null);
          if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
          const content = await readFile(file.abs, "utf8").catch(() => null);
          if (content === null || content.includes("\0")) continue;

          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            matcher.lastIndex = 0;
            if (matcher.test(line)) {
              matches.push(`${file.rel}:${i + 1}: ${line.slice(0, 300)}`);
              if (matches.length >= maxResults) break;
            }
          }
        }

        const out = boundText(matches.join("\n"));
        return {
          content: [{ type: "text", text: out.text || "(no matches)" }],
          isError: false,
          details: { matchCount: matches.length, truncated: out.truncated || matches.length >= maxResults },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export interface FindArgs {
  pattern?: string;
  path?: string;
  type?: "file" | "dir" | "all";
  maxResults?: number;
}

export function createFindTool(_root: string): ToolDefinition<FindArgs> {
  return {
    name: "find",
    description: "Find files or directories in the workspace by name or glob pattern (respects .agentignore)",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob or substring pattern to match relative path (default: '*')" },
        path: { type: "string", description: "Subdirectory to search (default: workspace root)" },
        type: { type: "string", enum: ["file", "dir", "all"], default: "file" },
        maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      },
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      let target: string;
      try {
        target = args.path ? safeResolveSync(ctx.workspaceRoot, args.path) : ctx.workspaceRoot;
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }

      const maxResults = Math.max(1, Math.min(1000, args.maxResults ?? 200));
      const filterType = args.type ?? "file";
      const pattern = args.pattern?.trim();
      const globRe = pattern
        ? globToRegex(pattern.includes("*") || pattern.includes("?") ? (pattern.includes("/") ? pattern : `**/${pattern}`) : `*${pattern}*`)
        : null;

      try {
        const entries = await walkWorkspaceFiles(ctx.workspaceRoot, target, {
          includeDirs: filterType !== "file",
          signal: ctx.signal,
          maxEntries: 20_000,
        });

        const matched: string[] = [];
        for (const entry of entries) {
          if (filterType !== "all" && entry.kind !== filterType) continue;
          if (globRe && !globRe.test(entry.rel)) continue;
          matched.push(entry.kind === "dir" ? `${entry.rel}/` : entry.rel);
          if (matched.length >= maxResults) break;
        }

        const out = boundText(matched.join("\n"));
        return {
          content: [{ type: "text", text: out.text || "(no matching entries)" }],
          isError: false,
          details: { count: matched.length, truncated: out.truncated || matched.length >= maxResults },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}
