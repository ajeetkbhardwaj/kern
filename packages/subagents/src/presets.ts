import type { SubagentPreset } from "./types.js";

/**
 * Starter specialist templates (NOT active by default).
 * Users can explicitly install any of these via CLI (`kern agents add --preset`),
 * TUI (`/agents`), or Web UI.
 */
export const SUBAGENT_PRESETS: SubagentPreset[] = [
  {
    id: "explorer",
    name: "Codebase Explorer",
    description: "Fast read-only scout for tracing files, symbols, call sites, and architecture",
    entry: {
      name: "explorer",
      description: "Read-only codebase exploration specialist for locating files, symbols, and call graphs quickly.",
      mode: "readonly",
      isolation: "readonly",
      tools: ["read", "grep", "find", "git-status", "git-diff", "git-log"],
      maxTurns: 10,
      maxTotalToolCalls: 30,
      instruction: [
        "You are a focused read-only codebase explorer working as part of a team.",
        "Locate exact files, line numbers, symbol definitions, and dependencies relevant to the task.",
        "Verify every path and identifier by reading or grepping files; never guess.",
        "Return a concise, factual report formatted cleanly for the orchestrator.",
      ].join("\n"),
    },
  },
  {
    id: "reviewer",
    name: "Code & Security Reviewer",
    description: "Read-only reviewer checking diffs, regressions, edge cases, and security issues",
    entry: {
      name: "reviewer",
      description: "Read-only code and security reviewer inspecting changes for bugs, edge cases, and test gaps.",
      mode: "readonly",
      isolation: "readonly",
      tools: ["read", "grep", "find", "git-status", "git-diff", "git-log"],
      maxTurns: 10,
      maxTotalToolCalls: 25,
      instruction: [
        "You are a rigorous read-only code and security reviewer.",
        "Inspect the specified files or git diff carefully for logic bugs, race conditions, security flaws, and missing test coverage.",
        "Cite exact file paths, line ranges, severity, and concrete fix recommendations.",
      ].join("\n"),
    },
  },
  {
    id: "coder",
    name: "Implementation Specialist",
    description: "Focused engineer with exclusive write access for implementing & testing scoped changes",
    entry: {
      name: "coder",
      description: "Focused implementation specialist for making targeted edits and running tests inside scoped files.",
      mode: "write",
      isolation: "exclusive",
      tools: ["read", "write", "edit", "bash", "grep", "find", "git-status", "git-diff"],
      maxTurns: 16,
      maxTotalToolCalls: 40,
      instruction: [
        "You are an implementation specialist executing a focused coding task for the orchestrator.",
        "Read relevant context first, make minimal surgical edits, and run relevant verification checks/tests.",
        "Report every modified file, commands executed, test outcomes, and any remaining blockers.",
      ].join("\n"),
    },
  },
  {
    id: "researcher",
    name: "Web & Docs Researcher",
    description: "Read-only external documentation & web researcher returning cited findings",
    entry: {
      name: "researcher",
      description: "External web and documentation research specialist returning concise cited findings.",
      mode: "readonly",
      isolation: "readonly",
      tools: ["web-fetch", "read", "grep", "find"],
      maxTurns: 8,
      maxTotalToolCalls: 20,
      instruction: [
        "You are an external documentation and research specialist.",
        "Fetch primary documentation pages, extract exact API contracts/constraints, and cite URLs.",
        "Summarize cleanly according to expectedOutput.",
      ].join("\n"),
    },
  },
];

export function findSubagentPreset(id: string): SubagentPreset | undefined {
  return SUBAGENT_PRESETS.find((p) => p.id === id.toLowerCase());
}
