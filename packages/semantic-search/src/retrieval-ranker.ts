export interface RetrievalCandidate {
  path: string;
  score: number;
  reasons: string[];
  symbolMatches?: string[];
  confidence?: "low" | "medium" | "high";
}

export interface ScoreContext {
  taskType?: "bugfix" | "feature" | "refactor" | "explore" | "test";
  modifiedAt?: string;
}

export class RetrievalRanker {
  score(query: string, path: string, symbolMatches: string[] = [], context: ScoreContext = {}): RetrievalCandidate {
    const loweredPath = path.toLowerCase();
    const q = query.toLowerCase().trim();
    const terms = tokenize(q);
    let score = 0;
    const reasons: string[] = [];
    const matchedSymbols = symbolMatches.filter((m) => terms.some((t) => m.toLowerCase().includes(t) || t.includes(m.toLowerCase())));

    if (q && loweredPath.includes(q)) {
      score += 45;
      reasons.push("path match");
    }
    for (const term of terms) {
      if (!term) continue;
      if (loweredPath.split("/").at(-1)?.includes(term)) {
        score += 18;
        reasons.push(`filename:${term}`);
      } else if (loweredPath.includes(term)) {
        score += 10;
      }
    }
    if (matchedSymbols.length > 0) {
      score += Math.min(40, 18 + matchedSymbols.length * 8);
      reasons.push("symbol match");
    }
    if (/(^|\/)(src|packages|lib|app)\//.test(loweredPath)) score += 8;
    if (/test|spec|__tests__/.test(loweredPath)) {
      score += context.taskType === "test" || context.taskType === "bugfix" ? 14 : 4;
      reasons.push("test file");
    }
    if (context.taskType === "refactor" && /\/(index|types|utils|helpers|core)\./.test(loweredPath)) score += 6;
    if (context.taskType === "feature" && !/test|spec/.test(loweredPath)) score += 4;
    if (context.modifiedAt) {
      const ageMs = Date.now() - Date.parse(context.modifiedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) {
        score += 3;
        reasons.push("recently modified");
      }
    }

    const confidence: RetrievalCandidate["confidence"] = score >= 50 ? "high" : score >= 20 ? "medium" : "low";
    return { path, score, reasons: [...new Set(reasons)], symbolMatches: [...new Set(matchedSymbols)], confidence };
  }
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_./-]+/).map((t) => t.trim()).filter((t) => t.length >= 2))];
}
