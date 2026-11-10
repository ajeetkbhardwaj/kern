import type { RepoIndex } from "@kern/repo-index";
import type { SymbolStore } from "@kern/symbol-store";
import { RetrievalRanker, type RetrievalCandidate } from "./retrieval-ranker.js";

export interface SearchIntent {
  query: string;
  taskType?: "bugfix" | "feature" | "refactor" | "explore" | "test";
  fileHints?: string[];
  symbolHints?: string[];
}

export class SemanticSearch {
  constructor(
    private readonly repoIndex: RepoIndex,
    private readonly symbolStore: SymbolStore,
    private readonly ranker: RetrievalRanker = new RetrievalRanker(),
  ) {}

  async retrieve(intent: SearchIntent): Promise<RetrievalCandidate[]> {
    if (this.repoIndex.getLastRefreshedAt()) {
      await this.repoIndex.refresh({ incremental: true });
    } else {
      await this.repoIndex.ensureLoaded();
    }
    await this.symbolStore.indexRepo({ incremental: !!this.symbolStore.getLastIndexedAt() });

    const query = intent.query.trim();
    const results = new Map<string, RetrievalCandidate>();

    for (const file of this.repoIndex.all()) {
      const symbols = this.lookupSymbols(file.path);
      const candidate = this.ranker.score(query, file.path, symbols, {
        taskType: intent.taskType,
        ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
      });
      if (candidate.score > 0) results.set(file.path, candidate);
    }

    for (const hint of (intent.fileHints ?? []).map((h) => h.trim()).filter(Boolean)) {
      for (const file of this.repoIndex.searchByName(hint)) {
        const current = results.get(file.path) ?? this.ranker.score(hint, file.path, this.lookupSymbols(file.path), { taskType: intent.taskType });
        current.score += 18;
        current.reasons = [...new Set([...current.reasons, "file hint"])];
        current.confidence = current.score >= 50 ? "high" : current.score >= 20 ? "medium" : "low";
        results.set(file.path, current);
      }
    }

    for (const symbol of (intent.symbolHints ?? []).map((h) => h.trim()).filter(Boolean)) {
      for (const match of this.symbolStore.findByName(symbol)) {
        const current = results.get(match.file) ?? this.ranker.score(symbol, match.file, [match.name], { taskType: intent.taskType });
        current.score += 28;
        current.symbolMatches = [...new Set([...(current.symbolMatches ?? []), match.name])];
        current.reasons = [...new Set([...current.reasons, "symbol hint"])];
        current.confidence = current.score >= 50 ? "high" : current.score >= 20 ? "medium" : "low";
        results.set(match.file, current);
      }
    }

    return [...results.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 25);
  }

  private lookupSymbols(filePath: string): string[] {
    return this.symbolStore.findByFile(filePath).map((symbol) => symbol.name);
  }
}
