import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BudgetLimits } from "@kern/coding-agent";
import type { SessionEntry } from "@kern/protocol";
import { isBranchSummaryEntry } from "@kern/protocol";

export interface SlashCommandDef {
	name: string;
	description: string;
	shortcut?: string;
}

export const TUI_COMMANDS: SlashCommandDef[] = [
	{ name: "help", description: "show commands and keybindings" },
	{ name: "palette", description: "open command palette", shortcut: "Ctrl+P" },
	{ name: "search", description: "live search in transcript", shortcut: "Ctrl+F" },
	{ name: "find", description: "alias for /search", shortcut: "Ctrl+F" },
	{ name: "model", description: "pick provider/model" },
	{ name: "thinking", description: "set reasoning effort (off/low/medium/high)" },
	{ name: "safety", description: "pick safety mode (strict/balanced/restricted/autonomous)" },
	{ name: "budget", description: "view or set live session budget limits" },
	{ name: "session", description: "manage sessions (list/switch/fork/rename/new/info/export)" },
	{ name: "fork", description: "fork active conversation into a new session" },
	{ name: "login", description: "log in to an LLM provider (or add a custom endpoint)" },
	{ name: "logout", description: "log out / clear saved credentials for a provider" },
	{ name: "mcp", description: "manage MCP servers & external tool connectors" },
	{ name: "connects", description: "alias for /mcp" },
	{ name: "keys", description: "re-auth the current provider" },
	{ name: "compact", description: "summarize history into a checkpoint" },
	{ name: "diff", description: "show working-tree changes" },
	{ name: "branch", description: "record a branch summary" },
	{ name: "undo", description: "undo file changes from the last turn" },
	{ name: "redo", description: "redo previously undone file changes" },
	{ name: "expand", description: "expand all tool/thinking cards", shortcut: "Ctrl+O" },
	{ name: "collapse", description: "collapse all tool/thinking cards", shortcut: "Ctrl+O" },
	{ name: "new", description: "start a fresh session" },
	{ name: "export", description: "export the transcript to Markdown" },
	{ name: "clear", description: "clear the transcript view" },
	{ name: "quit", description: "exit the session" },
];

export const TUI_HINTS =
	"Enter send · Shift+Enter newline · Ctrl+P palette · Ctrl+F search · Ctrl+O details · PgUp/PgDn scroll · Tab complete · @ files · ! shell · Ctrl+C abort";

export const QUICK_HELP =
	"Quick actions: /login · /logout · /model · /mcp · /thinking · /safety · /budget · /session · /search · /help";

// Zero-width / bidi / tag invisibles (keeps ZWNJ U+200C for Persian/Indic).
export const INVISIBLE_RE = /[​‎‏‪-‮⁠-⁤﻿]/gu;

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\s+.*-[a-z]*r[a-z]*f\b/i,
	/\brm\s+-rf?\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-z]*f\b/,
	/:\(\)\s*\{[^}]*\}\s*;/,
	/\bmkfs\b/,
	/\bdd\b.*\bof=\/dev\//,
	/>\s*\/dev\/[a-z]/,
	/\b(shutdown|reboot|halt|poweroff)\b/i,
	/\bDROP\s+(TABLE|DATABASE)\b/i,
];

export function isDestructiveApproval(prompt: string, argsText?: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((re) => re.test(prompt) || (argsText ? re.test(argsText) : false));
}

export interface TuiPersistedState {
	draftText: string;
	recentPrompts: string[];
	stash: string;
	queue: string[];
	lastUserPrompt: string;
}

export function resolveTuiStateFile(homeDir = homedir()): string {
	return join(homeDir, ".kern", "tui-state.json");
}

export async function loadTuiState(filePath = resolveTuiStateFile()): Promise<Partial<TuiPersistedState>> {
	try {
		const raw = await readFile(filePath, "utf8");
		const data = JSON.parse(raw) as unknown;
		if (!data || typeof data !== "object") return {};
		const rec = data as Record<string, unknown>;
		return {
			...(typeof rec["draftText"] === "string" ? { draftText: rec["draftText"] } : {}),
			...(Array.isArray(rec["recentPrompts"])
				? { recentPrompts: rec["recentPrompts"].filter((x): x is string => typeof x === "string") }
				: {}),
			...(typeof rec["stash"] === "string" ? { stash: rec["stash"] } : {}),
			...(Array.isArray(rec["queue"])
				? { queue: rec["queue"].filter((x): x is string => typeof x === "string") }
				: {}),
			...(typeof rec["lastUserPrompt"] === "string" ? { lastUserPrompt: rec["lastUserPrompt"] } : {}),
		};
	} catch {
		return {};
	}
}

export async function saveTuiState(state: TuiPersistedState, filePath = resolveTuiStateFile()): Promise<void> {
	try {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(state), "utf8");
	} catch {
		/* best-effort */
	}
}

/** One-line arg summary for tool cards (path/command first, capped). */
export function summarizeArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const first =
		typeof record["path"] === "string"
			? record["path"]
			: typeof record["command"] === "string"
				? record["command"]
				: Object.entries(record)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(" ");
	const text = String(first);
	return text.length > 100 ? text.slice(0, 100) + "…" : text;
}

const OVERLAY_OPTS = { anchor: "center" as const, width: "80%" as const, maxHeight: "80%" as const };

/** Compute adaptive overlay options based on terminal width. */
export function getOverlayOpts(
	cols = process.stdout.columns ?? 80,
): { anchor: "center"; width: "80%" | "90%" | "95%"; maxHeight: "80%" | "85%" | "90%" } {
	if (cols < 80) return { anchor: "center", width: "95%", maxHeight: "90%" };
	if (cols < 120) return { anchor: "center", width: "90%", maxHeight: "85%" };
	return OVERLAY_OPTS;
}

/** Extract a command-like pattern from an approval prompt for pattern allowlisting. */
export function cmdPatternFromPrompt(prompt: string, argsFull?: string): string {
	if (argsFull) {
		try {
			const parsed = JSON.parse(argsFull) as Record<string, unknown>;
			if (typeof parsed["command"] === "string") return parsed["command"];
			if (typeof parsed["path"] === "string") return parsed["path"];
		} catch {
			/* ignore */
		}
	}
	const m = prompt.match(/([^\s]+)$/);
	return m ? m[1]! : prompt;
}

export function formatReasoningSteps(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return "";
	const blocks = normalized
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter(Boolean);
	if (blocks.length <= 1) return normalized;

	const hasExplicitMarkers = blocks.some((b) => /^(?:step\s*\d+[:.)-]?|\d+[.)]|[-*•]|#{1,6}\s)/i.test(b));
	if (hasExplicitMarkers) {
		return blocks.join("\n\n");
	}
	return blocks.map((b, i) => `Step ${i + 1}: ${b}`).join("\n\n");
}

const BUDGET_INT_FIELDS = new Set<keyof BudgetLimits>([
	"maxInputTokens",
	"maxOutputTokens",
	"maxTotalTokens",
	"maxTurns",
	"maxToolCallsPerTurn",
	"maxTotalToolCalls",
	"maxWallTimeMs",
]);

const BUDGET_ALL_FIELDS = new Set<keyof BudgetLimits>([
	"maxCost",
	...BUDGET_INT_FIELDS,
]);

export function parseBudgetArgs(
	arg: string,
): { ok: true; limits: Partial<BudgetLimits> } | { ok: false; error: string } {
	const trimmed = arg.trim();
	if (!trimmed) return { ok: true, limits: {} };
	const limits: Partial<BudgetLimits> = {};
	const pairs = trimmed.split(/\s+/);
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0 || eq === pair.length - 1) {
			return { ok: false, error: `Invalid format: "${pair}". Use field=value (e.g. maxCost=0.05)` };
		}
		const key = pair.slice(0, eq) as keyof BudgetLimits;
		const valStr = pair.slice(eq + 1);
		if (!BUDGET_ALL_FIELDS.has(key)) {
			return {
				ok: false,
				error: `Unknown budget field "${key}". Valid: ${[...BUDGET_ALL_FIELDS].join(", ")}`,
			};
		}
		const val = Number(valStr);
		if (!Number.isFinite(val) || val < 0) {
			return { ok: false, error: `Invalid value for ${key}: must be a non-negative number` };
		}
		if (BUDGET_INT_FIELDS.has(key) && !Number.isInteger(val)) {
			return { ok: false, error: `Invalid value for ${key}: must be a non-negative integer` };
		}
		(limits as unknown as Record<string, number>)[key] = val;
	}
	return { ok: true, limits };
}

export function resolveExportPath(
	cwd: string,
	file: string | undefined,
	sessionId?: string | null,
): { ok: true; path: string } | { ok: false; error: string } {
	const root = resolve(cwd);
	const rawTarget = file ?? join(root, `kern-session-${sessionId ?? "export"}.md`);
	try {
		const target = resolve(root, rawTarget);
		const rel = relative(root, target);
		if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
			return { ok: false, error: `Export refused: path escapes workspace: ${file}` };
		}
		return { ok: true, path: target };
	} catch (error) {
		return { ok: false, error: `Export refused: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function buildSessionExportMarkdown(
	entries: readonly SessionEntry[],
	meta: { provider: string; modelId: string; cwd: string },
): string {
	const lines: string[] = [`# kern session`, ""];
	lines.push(`- model: ${meta.provider}/${meta.modelId}`, `- cwd: ${meta.cwd}`, "");
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			lines.push(`## ${msg.role}`, "");
			for (const block of msg.content) {
				if (block.type === "text") lines.push(block.text, "");
				else if (block.type === "reasoning") lines.push(`> thinking: ${block.text.slice(0, 500)}`, "");
				else if (block.type === "tool_call") {
					lines.push(`\`\`\`tool ${block.name}`, `${JSON.stringify(block.arguments, null, 2)}`, "```", "");
				} else if (block.type === "tool_result") {
					lines.push(`**tool result${block.isError ? " (error)" : ""}:**`, "");
					for (const c of block.content) lines.push(c.text, "");
				}
			}
		} else if (entry.type === "compaction") {
			lines.push("## compaction checkpoint", "", entry.summary, "");
		} else if (isBranchSummaryEntry(entry)) {
			lines.push("## branch summary", "", entry.summary, "");
		} else if (entry.type === "model_change") {
			lines.push(`*model → ${entry.provider}/${entry.model}*`, "");
		} else if (entry.type === "branch") {
			lines.push(`*branch from ${entry.forkedFromId}${entry.note ? `: ${entry.note}` : ""}*`, "");
		}
	}
	return lines.join("\n");
}

export type ReplayItem =
	| { kind: "user"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; toolCallId: string; toolName: string; argsSummary: string; output: string; isError: boolean; done: boolean }
	| { kind: "checkpoint"; label: string; summary: string };

/** Convert persisted active session entries into replayable transcript items with paired tool results. */
export function collectReplayItems(entries: readonly SessionEntry[]): {
	items: ReplayItem[];
	userTurns: number;
} {
	const items: ReplayItem[] = [];
	const toolIndexById = new Map<string, number>();
	let userTurns = 0;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			items.push({ kind: "checkpoint", label: "compaction checkpoint", summary: entry.summary });
			continue;
		}
		if (isBranchSummaryEntry(entry)) {
			items.push({ kind: "checkpoint", label: `branch summary (from ${entry.fromId})`, summary: entry.summary });
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "user") {
			const text = msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			if (text) {
				userTurns += 1;
				items.push({ kind: "user", text });
			}
			continue;
		}

		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "reasoning" && block.text.trim()) {
					items.push({ kind: "reasoning", text: formatReasoningSteps(block.text) });
				} else if (block.type === "text" && block.text) {
					items.push({ kind: "assistant", text: block.text });
				} else if (block.type === "tool_call") {
					const idx = items.length;
					toolIndexById.set(block.id, idx);
					items.push({
						kind: "tool",
						toolCallId: block.id,
						toolName: block.name,
						argsSummary: summarizeArgs(block.arguments),
						output: "",
						isError: false,
						done: false,
					});
				}
			}
			continue;
		}

		if (msg.role === "tool") {
			for (const block of msg.content) {
				if (block.type !== "tool_result") continue;
				const output = block.content.map((c) => c.text).join("\n");
				const existingIdx = toolIndexById.get(block.toolCallId);
				if (existingIdx !== undefined) {
					const existing = items[existingIdx];
					if (existing && existing.kind === "tool") {
						existing.output = output;
						existing.isError = block.isError;
						existing.done = true;
						continue;
					}
				}
				items.push({
					kind: "tool",
					toolCallId: block.toolCallId,
					toolName: "tool",
					argsSummary: block.toolCallId,
					output,
					isError: block.isError,
					done: true,
				});
			}
		}
	}

	return { items, userTurns };
}
