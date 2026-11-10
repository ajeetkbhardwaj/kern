import type { RepoFileRecord, RepoIndex } from "@kern/repo-index";
import type { SymbolStore } from "@kern/symbol-store";

export type TaskKind = "bugfix" | "feature" | "refactor" | "explore" | "test";

export interface ReadPlan {
  taskType: TaskKind;
  rationale: string;
  files: string[];
  tests: string[];
  symbols: string[];
  readOrder: string[];
}

export interface ReadStrategyInput {
  query: string;
  taskType?: TaskKind;
  fileHints?: string[];
  symbolHints?: string[];
}

export class ReadStrategy {
  constructor(
    private readonly repoIndex: RepoIndex,
    private readonly symbolStore: SymbolStore,
  ) {}

  async plan(input: ReadStrategyInput): Promise<ReadPlan> {
    if (this.repoIndex.getLastRefreshedAt()) {
      await this.repoIndex.refresh({ incremental: true });
    } else {
      await this.repoIndex.ensureLoaded();
    }
    await this.symbolStore.indexRepo({ incremental: !!this.symbolStore.getLastIndexedAt() });

    const query = input.query.trim();
    const taskType = this.detectTaskType(query, input.taskType);
    const fileHints = (input.fileHints ?? []).map((hint) => hint.trim()).filter(Boolean);
    const symbolHints = (input.symbolHints ?? []).map((hint) => hint.trim()).filter(Boolean);
    const terms = tokenize(query);

    const scored = new Map<string, { file: RepoFileRecord; score: number; reasons: string[] }>();
    for (const file of this.repoIndex.all()) {
      const { score, reason } = this.scoreFile(file, query, terms, taskType);
      if (score > 0) scored.set(file.path, { file, score, reasons: [reason] });
    }

    for (const hint of fileHints) {
      for (const file of this.repoIndex.searchByName(hint)) {
        const entry = scored.get(file.path) ?? { file, score: 0, reasons: [] };
        entry.score += 25;
        entry.reasons.push(`hint:${hint}`);
        scored.set(file.path, entry);
      }
    }

    for (const symbol of symbolHints) {
      for (const match of this.symbolStore.findByName(symbol)) {
        const file = this.repoIndex.byPath(match.file);
        if (!file) continue;
        const entry = scored.get(file.path) ?? { file, score: 0, reasons: [] };
        entry.score += 35;
        entry.reasons.push(`symbol:${match.name}`);
        scored.set(file.path, entry);
      }
    }

    const ordered = [...scored.values()].sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const files = ordered.map((entry) => entry.file.path);
    const tests = files.filter((path) => /(?:^|\/)(?:test|tests|__tests__)/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path));
    const symbols = [...new Set(
      ordered.flatMap((entry) => this.symbolStore.findByFile(entry.file.path).map((symbol) => symbol.name)).slice(0, 25),
    )];

    return {
      taskType,
      rationale: this.describeTask(taskType, query),
      files: files.slice(0, 8),
      tests: tests.slice(0, 5),
      symbols,
      readOrder: [...new Set([...files.slice(0, 5), ...tests.slice(0, 3)])],
    };
  }

  private detectTaskType(query: string, taskType?: TaskKind): TaskKind {
    if (taskType) return taskType;
    const lower = query.toLowerCase();
    if (/bug|error|fail|crash|null|exception|stack trace|broken|regression/.test(lower)) return "bugfix";
    if (/test|spec|assert|coverage/.test(lower)) return "test";
    if (/refactor|cleanup|simplify|rename|extract/.test(lower)) return "refactor";
    if (/add|implement|create|build|feature/.test(lower)) return "feature";
    return "explore";
  }

  private scoreFile(file: RepoFileRecord, query: string, terms: string[], taskType: TaskKind): { score: number; reason: string } {
    const lower = file.path.toLowerCase();
    const q = query.toLowerCase();
    let score = 0;
    let reason = "repo-shape";

    if (q && lower.includes(q)) {
      score += 40;
      reason = "query-match";
    }
    for (const term of terms) {
      if (lower.split("/").at(-1)?.includes(term)) score += 12;
      else if (lower.includes(term)) score += 6;
    }
    if (taskType === "test" && /test|spec/.test(lower)) {
      score += 30;
      reason = "test-target";
    } else if (/(^|\/)(src|packages)\//.test(lower)) {
      score += 10;
      if (reason === "repo-shape") reason = "source-area";
    }
    if (file.imports?.some((value) => terms.some((t) => value.toLowerCase().includes(t)))) score += 18;
    if (file.exports?.some((value) => terms.some((t) => value.toLowerCase().includes(t)))) score += 14;
    if (/test|spec/.test(lower)) score += 5;
    if (file.modifiedAt) {
      const ageMs = Date.now() - Date.parse(file.modifiedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) score += 2;
    }
    return { score, reason };
  }

  private describeTask(taskType: TaskKind, query: string): string {
    switch (taskType) {
      case "bugfix":
        return `Bug-fix task centered on the failing behavior described by: ${query}`;
      case "feature":
        return `Feature work likely spanning implementation and validation around: ${query}`;
      case "refactor":
        return `Refactor task for code structure and API boundaries in: ${query}`;
      case "test":
        return `Validation task around tests and expected behavior for: ${query}`;
      default:
        return `Exploration task for repository context related to: ${query}`;
    }
  }
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_./-]+/).map((t) => t.trim()).filter((t) => t.length >= 2))];
}
