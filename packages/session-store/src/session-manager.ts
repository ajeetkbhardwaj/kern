import { createLogger, newId, now, type Logger } from "@kern/protocol";
import type {
  SessionEntry,
  MessageEntry,
  CompactionEntry,
  DiagnosticEntry,
  LabelEntry,
  BranchEntry,
  BranchSummaryEntry,
  SessionNameEntry,
  ExtensionEntry,
  ModelChangeEntry,
  UsageEntry,
  TokenCounts,
  CostSnapshot,
  ChatMessage,
} from "@kern/protocol";
import { isMessageEntry, isCompactionEntry, isUsageEntry } from "@kern/protocol";
import type { SessionStore, SessionFile } from "./jsonl-store.js";
import { migrateSessionEntries } from "./migration.js";

export interface SessionState {
  entries: Map<string, SessionEntry>;
  children: Map<string, string[]>;
  activeLeafId: string;
  headerId: string;
  lastSeq: number;
}

export interface LoadResult {
  filePath: string;
  state: SessionState;
  header: SessionEntry;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  private readonly cwd: string;
  private state: SessionState | null = null;
  private filePath: string | null = null;

  constructor(store: SessionStore, logger: Logger = createLogger("info"), cwd = process.cwd()) {
    this.store = store;
    this.logger = logger;
    this.cwd = cwd;
  }

  static async create(store: SessionStore, cwd: string, meta?: Record<string, unknown>): Promise<SessionManager> {
    const mgr = new SessionManager(store, store["logger"] as Logger ?? createLogger("info"), cwd);
    const { filePath, header } = await store.createSession({ cwd, meta });
    mgr.state = {
      entries: new Map([[header.id, header]]),
      children: new Map(),
      activeLeafId: header.id,
      headerId: header.id,
      lastSeq: 0,
    };
    mgr.filePath = filePath;
    return mgr;
  }

  static async resume(store: SessionStore, cwd: string, sessionFile?: string): Promise<SessionManager> {
    const mgr = new SessionManager(store, store["logger"] as Logger ?? createLogger("info"), cwd);
    let file: SessionFile | null = null;
    if (sessionFile) {
      file = { filePath: sessionFile, sessionId: "", createdAt: now(), mtimeMs: 0, size: 0 };
    } else {
      file = await store.findMostRecent(cwd);
    }
    if (!file) return SessionManager.create(store, cwd);
    try {
      await mgr.loadFromFile(file.filePath);
      return mgr;
    } catch (error) {
      mgr.logger.warn("session_resume_failed_falling_back", {
        filePath: file.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return SessionManager.create(store, cwd);
    }
  }

  private async loadFromFile(filePath: string): Promise<void> {
    const entries = new Map<string, SessionEntry>();
    const children = new Map<string, string[]>();
    let header: SessionEntry | null = null;
    let lastId: string | null = null;
    const rawEntries: SessionEntry[] = [];
    for await (const entry of this.store.readAll(filePath)) {
      rawEntries.push(entry);
    }
    const readStats = this.store.lastReadStats;
    if (readStats && (readStats.malformed > 0 || readStats.invalid > 0)) {
      await this.quarantineCorruptSession(filePath, readStats);
      throw new Error(
        `Session file corrupted (${readStats.malformed} malformed, ${readStats.invalid} invalid line(s)): ${filePath}`,
      );
    }
    const migrated = migrateSessionEntries(rawEntries);
    if (migrated.migratedCount > 0) {
      this.logger.info("session_migrated", {
        filePath,
        fromVersion: migrated.fromVersion,
        toVersion: migrated.toVersion,
      });
    }
    for (const entry of migrated.entries) {
      entries.set(entry.id, entry);
      if (entry.parentId !== null) {
        const arr = children.get(entry.parentId) ?? [];
        if (!arr.includes(entry.id)) arr.push(entry.id);
        children.set(entry.parentId, arr);
      } else {
        header = entry;
      }
      lastId = entry.id;
    }
    if (!header || lastId === null) {
      const corruptInfo = readStats && (readStats.malformed > 0 || readStats.invalid > 0)
        ? ` (corruption detected: ${readStats.malformed} malformed, ${readStats.invalid} invalid; a quarantine copy may exist)`
        : "";
      throw new Error(`Session file missing header: ${filePath}${corruptInfo}`);
    }
    let lastSeq = 0;
    for (const e of entries.values()) {
      if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
    }
    const { reseedIdCounters } = await import("@kern/protocol");
    reseedIdCounters(entries.keys());
    this.state = { entries, children, activeLeafId: lastId, headerId: header.id, lastSeq };
    const { validateInvariants } = await import("./invariants.js");
    const inv = validateInvariants(this.state);
    if (!inv.valid) {
      throw new Error(`Session invariants failed: ${inv.errors.join("; ")}`);
    }
    this.filePath = filePath;
    this.logger.info("session_loaded", { filePath, entries: entries.size, leafId: lastId });
  }

  get activeLeafId(): string {
    if (!this.state) throw new Error("SessionManager not initialized");
    return this.state.activeLeafId;
  }

  /** Session file on disk, if this manager is file-backed. */
  get sessionFile(): string | null {
    return this.filePath;
  }

  /** Session id from the header entry. */
  get sessionId(): string | null {
    if (!this.state) return null;
    const header = this.state.entries.get(this.state.headerId);
    return header && header.type === "session_header" ? header.sessionId : null;
  }

  get sessionName(): string | null {
    return this.getSessionName();
  }

  getEntry(id: string): SessionEntry | undefined {
    if (!this.state) throw new Error("SessionManager not initialized");
    return this.state.entries.get(id);
  }

  getActivePath(): SessionEntry[] {
    if (!this.state) throw new Error("SessionManager not initialized");
    const path: SessionEntry[] = [];
    let currentId: string | null = this.state.activeLeafId;
    const seen = new Set<string>();
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.state.entries.get(currentId);
      if (!entry) break;
      path.push(entry);
      currentId = entry.parentId;
    }
    return path.reverse();
  }

  getActiveMessages(): MessageEntry[] {
    return this.getActivePath().filter(isMessageEntry);
  }

  lastCompaction(): CompactionEntry | null {
    const path = this.getActivePath();
    for (let i = path.length - 1; i >= 0; i--) {
      const e = path[i];
      if (e && isCompactionEntry(e)) return e;
    }
    return null;
  }

  getSessionName(): string | null {
    if (!this.state) return null;
    for (const entry of this.getActivePath().slice().reverse()) {
      if (entry.type === "session_name") return entry.name;
    }
    return null;
  }

  branchTo(targetId: string): void {
    if (!this.state) throw new Error("SessionManager not initialized");
    if (!this.state.entries.has(targetId)) throw new Error(`Unknown entry ${targetId}`);
    this.state.activeLeafId = targetId;
    this.logger.info("session_branch", { targetId });
  }

  private nextSeq(): number {
    if (!this.state) throw new Error("SessionManager not initialized");
    this.state.lastSeq += 1;
    return this.state.lastSeq;
  }

  /** Serialize appends so concurrent callers never share a parentId/seq. */
  private appendChain: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.appendChain.then(fn, fn);
    this.appendChain = run.catch(() => undefined);
    return run;
  }

  async appendUserMessage(text: string): Promise<MessageEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const msg: ChatMessage = { role: "user", content: [{ type: "text", text }], timestamp: now() };
    const parentId = this.state.activeLeafId;
    const entry: MessageEntry = { id: newId("m"), parentId, timestamp: now(), type: "message", message: msg, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendAssistantMessage(msg: ChatMessage): Promise<MessageEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: MessageEntry = { id: newId("m"), parentId, timestamp: now(), type: "message", message: msg, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendToolResult(msg: ChatMessage): Promise<MessageEntry> {
    return this.appendAssistantMessage(msg);
  }

  async appendModelChange(provider: string, model: string, thinkingLevel?: string): Promise<ModelChangeEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: ModelChangeEntry = { id: newId("v"), parentId, timestamp: now(), type: "model_change", provider, model, seq: this.nextSeq() };
    if (thinkingLevel !== undefined) entry.thinkingLevel = thinkingLevel;
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendCompaction(
    summary: string,
    replacesThroughId: string,
    opts?: { tokensBefore?: TokenCounts; tokensAfter?: TokenCounts },
  ): Promise<CompactionEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: CompactionEntry = {
      id: newId("c"),
      parentId,
      timestamp: now(),
      type: "compaction",
      summary,
      replacesThroughId,
      seq: this.nextSeq(),
      ...(opts?.tokensBefore ? { tokensBefore: opts.tokensBefore } : {}),
      ...(opts?.tokensAfter ? { tokensAfter: opts.tokensAfter } : {}),
    };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendUsage(data: {
    provider: string;
    model: string;
    usage: TokenCounts;
    cost?: number;
    source?: "turn" | "compaction";
  }): Promise<UsageEntry> {
    return this.serialized(async () => {
      if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
      const parentId = this.state.activeLeafId;
      const entry: UsageEntry = {
        id: newId("u"),
        parentId,
        timestamp: now(),
        type: "usage",
        provider: data.provider,
        model: data.model,
        usage: data.usage,
        ...(data.cost !== undefined ? { cost: data.cost } : {}),
        ...(data.source !== undefined ? { source: data.source } : {}),
        seq: this.nextSeq(),
      };
      await this.store.append(this.filePath, entry);
      this.state.entries.set(entry.id, entry);
      const arr = this.state.children.get(parentId) ?? [];
      arr.push(entry.id);
      this.state.children.set(parentId, arr);
      this.state.activeLeafId = entry.id;
      return entry;
    });
  }

  getUsageTotals(): CostSnapshot {
    if (!this.state) return { inputTokens: 0, outputTokens: 0, cost: 0, byModel: {} };
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    const byModel: Record<string, { input: number; output: number; cost: number }> = {};
    for (const entry of this.getActivePath()) {
      if (!isUsageEntry(entry)) continue;
      const inp = entry.usage.input ?? 0;
      const out = entry.usage.output ?? 0;
      const c = entry.cost ?? 0;
      inputTokens += inp;
      outputTokens += out;
      cost += c;
      const key = entry.model;
      const prev = byModel[key] ?? { input: 0, output: 0, cost: 0 };
      prev.input += inp;
      prev.output += out;
      prev.cost += c;
      byModel[key] = prev;
    }
    return { inputTokens, outputTokens, cost, byModel };
  }

  async appendBranch(note?: string): Promise<BranchEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const forkedFromId = this.state.activeLeafId;
    const entry: BranchEntry = { id: newId("b"), parentId: forkedFromId, timestamp: now(), type: "branch", forkedFromId, note, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(forkedFromId) ?? [];
    arr.push(entry.id);
    this.state.children.set(forkedFromId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendBranchSummary(fromId: string, summary: string): Promise<BranchSummaryEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: BranchSummaryEntry = { id: newId("bs"), parentId, timestamp: now(), type: "branch_summary", fromId, summary, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async setSessionName(name: string): Promise<SessionNameEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: SessionNameEntry = { id: newId("n"), parentId, timestamp: now(), type: "session_name", name, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async appendDiagnostic(d: Omit<DiagnosticEntry, "id" | "parentId" | "timestamp" | "type" | "seq">): Promise<DiagnosticEntry> {
    return this.serialized(async () => {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: DiagnosticEntry = { id: newId("d"), parentId, timestamp: now(), type: "diagnostic", seq: this.nextSeq(), ...d };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
    });
  }

  async deleteSession(filePath: string): Promise<boolean> {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(limit = 20): Promise<string[]> {
    const store = this.store;
    const cwd = this.cwd || process.cwd();
    const files = await store.listSessions(cwd, { limit });
    return files.map((file) => file.filePath);
  }

  /**
   * Fork the active session into a new JSONL file containing only the root-to-target
   * lineage (with fresh sessionId + forkedFrom provenance) and non-decreasing seqs.
   */
  async forkToNewSession(targetEntryId?: string): Promise<SessionManager> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const targetId = targetEntryId ?? this.state.activeLeafId;
    if (!this.state.entries.has(targetId)) {
      throw new Error(`Unknown entry ${targetId}`);
    }

    const path: SessionEntry[] = [];
    let currentId: string | null = targetId;
    const seen = new Set<string>();
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.state.entries.get(currentId);
      if (!entry) break;
      path.push(entry);
      currentId = entry.parentId;
    }
    path.reverse();

    const sourceHeader = path[0];
    const sourceMeta = sourceHeader?.type === "session_header" ? (sourceHeader.meta ?? {}) : {};
    const { filePath: nextPath, header: nextHeader } = await this.store.createSession({
      cwd: this.cwd,
      meta: {
        ...sourceMeta,
        forkedFrom: {
          sessionId: this.sessionId,
          entryId: targetId,
          filePath: this.filePath,
        },
      },
    });

    let seq = 0;
    for (let i = 1; i < path.length; i++) {
      const original = path[i]!;
      seq += 1;
      const cloned: SessionEntry = {
        ...original,
        parentId: i === 1 ? nextHeader.id : original.parentId,
        seq,
      };
      await this.store.append(nextPath, cloned);
    }

    this.logger.info("session_forked", {
      fromSessionId: this.sessionId,
      targetEntryId: targetId,
      toFilePath: nextPath,
      entries: path.length,
    });
    return SessionManager.resume(this.store, this.cwd, nextPath);
  }

  private async quarantineCorruptSession(
    filePath: string,
    readStats: { malformed: number; invalid: number; totalLines: number; yielded: number; empty: number },
  ): Promise<void> {
    const shouldQuarantine = (this.store as { quarantineLastMalformed?: boolean }).quarantineLastMalformed ?? true;
    if (!shouldQuarantine) return;
    try {
      const { copyFile } = await import("node:fs/promises");
      const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
      await copyFile(filePath, quarantinePath);
      this.logger.warn("session_quarantined", { filePath, quarantinePath, ...readStats });
    } catch (error) {
      this.logger.warn("session_quarantine_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
        ...readStats,
      });
    }
  }
}