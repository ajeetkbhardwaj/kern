import { describe, expect, it } from "vitest";
import { RepoIndex } from "@kern/repo-index";
import { SymbolStore } from "@kern/symbol-store";
import { RetrievalRanker } from "../src/retrieval-ranker.js";
import { SemanticSearch } from "../src/searcher.js";

const root = process.cwd();

describe("semantic search", () => {
  it("retrieves relevant files for a task query", async () => {
    const repoIndex = new RepoIndex({ root });
    const symbolStore = new SymbolStore(repoIndex);
    const searcher = new SemanticSearch(repoIndex, symbolStore, new RetrievalRanker());
    const hits = await searcher.retrieve({ query: "session invariants", symbolHints: ["validateInvariants"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.path.includes("session-store") || hit.path.includes("invariants"))).toBe(true);
  });
});
