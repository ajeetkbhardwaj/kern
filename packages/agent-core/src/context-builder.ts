import type { Logger, ModelToolSchema, ChatMessage } from "@kern/protocol";
import { nullLogger, isBranchSummaryEntry } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";
import { countContextTokens, type ContextUsage } from "./tokens.js";

export interface ContextSnapshot {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  usage: ContextUsage;
}

export interface ContextBuilderOptions {
  baseSystemPrompt: string;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  /** Extra system sections appended after the base prompt (AGENTS.md, skills catalog). */
  systemExtra?: string;
}

export class ContextBuilder {
  private readonly baseSystemPrompt: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger: Logger;
  private systemExtra: string;
  private readonly dynamicSections = new Map<string, string>();

  constructor(options: ContextBuilderOptions) {
    this.baseSystemPrompt = options.baseSystemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.logger = options.logger ?? nullLogger;
    this.systemExtra = options.systemExtra ?? "";
  }

  setSystemExtra(text: string): void {
    this.systemExtra = text;
  }

  setDynamicSection(key: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) this.dynamicSections.delete(key);
    else this.dynamicSections.set(key, trimmed);
  }

  systemPrompt(): string {
    const parts = [this.baseSystemPrompt];
    if (this.systemExtra) parts.push(this.systemExtra);
    for (const sec of this.dynamicSections.values()) {
      parts.push(sec);
    }
    return parts.join("\n\n");
  }

  async build(sessions: SessionManager): Promise<ContextSnapshot> {
    const systemPrompt = this.systemPrompt();
    const compaction = sessions.lastCompaction();
    const messages: ChatMessage[] = [];
    if (compaction) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[COMPACTED SUMMARY]\n${compaction.summary}` }],
        timestamp: compaction.timestamp,
      });
    }
    const active = sessions.getActivePath();
    const cutoff = compaction ? sessions.getEntry(compaction.replacesThroughId) : undefined;
    const cutoffSeq = cutoff?.seq;
    const cutoffIndex = compaction ? active.findIndex((e) => e.id === compaction.replacesThroughId) : -1;
    for (let i = 0; i < active.length; i++) {
      const entry = active[i]!;
      if (compaction && isCoveredByCompaction(entry.id, entry.seq, i, compaction.replacesThroughId, cutoffSeq, cutoffIndex)) {
        continue;
      }
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (isBranchSummaryEntry(entry)) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: `[BRANCH SUMMARY from ${entry.fromId}]\n${entry.summary}` }],
          timestamp: entry.timestamp,
        });
      }
    }
    const tools = this.toolRegistry.listModelSchemas();
    const usage = countContextTokens(systemPrompt, tools, messages);
    return { systemPrompt, messages, tools, usage };
  }
}

function isCoveredByCompaction(
  entryId: string,
  entrySeq: number | undefined,
  activeIndex: number,
  replacesThroughId: string,
  cutoffSeq: number | undefined,
  cutoffIndex: number,
): boolean {
  if (entrySeq !== undefined && cutoffSeq !== undefined) {
    return entrySeq <= cutoffSeq;
  }
  if (cutoffIndex >= 0) {
    return activeIndex <= cutoffIndex;
  }
  return entryId === replacesThroughId;
}
