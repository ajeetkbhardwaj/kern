# 07 — Retrieval, Ranking, and Evidence Selection

> **Part II — The Answer Engine Core — Chapter 7**
> Subproject: `docs/07-retrieval-ranking-evidence/index.md`

---

## 1. First-Principle Question

How does the system move from 100+ raw candidates to a small, diverse, accurate evidence packet without missing the right passage or overloading the model's context?

---

## 2. Mental Model

Retrieval is not search: retrieval produces candidates; ranking decides which deserve the model's attention. The pipeline is candidate generation → filtering → fast first-stage ranking → top-N → accurate reranking → evidence selection. Reranking jointly evaluates query and passage for refined relevance. The final evidence packet is small (3–8 chunks per source), diverse, and non-repetitive.

---

## 3. How Perplexity-Style Systems Work

Perplexity uses hybrid retrieval and multi-stage ranking: retrieval and initial ranking, then second-stage ranking (reranking). A reranker jointly evaluates the query and candidate passage, producing a refined relevance score before generation.

Sources: [Perplexity Photon blog](https://www.perplexity.ai/en-GB/hub/blog/photon), [RAG reranking arxiv](https://arxiv.org/html/2507.18910v1)

```mermaid
flowchart LR
    Query[Query] --> Candidates[100+ candidates]
    Candidates --> Filter[Filter irrelevant / duplicate]
    Filter --> Rank1[Fast first-stage ranking]
    Rank1 --> Top[Top 20]
    Top --> Rank2[Accurate reranking]
    Rank2 --> Select[Top 5–10 evidence chunks]
```

---

## 4. Local-First Adaptation

First-stage ranking uses the local hybrid index (keyword + semantic) run on-device. Filtering removes duplicates, broken pages, irrelevant domains, and expired content. Reranking may use a local cross-encoder or a small model. Evidence selection caps the packet at 3–8 local chunks and/or 3–8 web passages, with source diversity. Local and web evidence are tagged with provenance so the synthesizer can cite them separately.

---

## 5. Architecture Diagram

```mermaid
flowchart LR
    Query[Query] --> Candidates[Candidate passages]
    Candidates --> Rank1[First-stage ranking]
    Rank1 --> Rerank[Reranking]
    Rerank --> Select[Select evidence]
    Select --> Packet[Evidence packet]
```

---

## 6. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| First-stage retrieval | Hybrid (BM25 + semantic vector) | Broad recall; catches exact and semantic matches |
| Candidate pool | 100+ per query | Do not miss the right evidence |
| Filtering | Duplicates, broken, irrelevant, expired | Clean candidates before ranking |
| First-stage ranker | Fast (vector cosine + BM25) | Low latency over large candidate set |
| Reranker | Cross-encoder / small local model | Higher precision on top-20 |
| Evidence packet size | 3–8 local chunks + 3–8 web passages | Small enough for context; large enough for diversity |
| Source diversity | Enforced per source type | Avoid single-source bias |

---

## 7. Failure Modes

| Failure | Consequence | Safeguard |
|---|---|---|
| Missed evidence | Incomplete answer | Broad first-stage recall (100+ candidates) |
| Duplicate passages | Wasted context, redundant citations | Deduplication before ranking |
| Poor reranking | Irrelevant evidence selected | Cross-encoder reranker on top-N |
| Context overflow | Poor reasoning, high cost | Small evidence packet limit |
| Single-source dominance | Biased answer | Source diversity requirement |

---

## 8. Design Rules

1. Retrieve broadly first; rank precisely second.
2. Filter duplicates and broken pages before ranking.
3. Rerank the top-N before final selection.
4. Keep the evidence packet small (5–10 chunks total).
5. Enforce source diversity across local and web.
6. Tag every evidence item with provenance and citation ID.

---

## 9. Checkpoint

- [ ] Retrieval pipeline defined (candidates → filter → rank1 → rerank → select)
- [ ] Hybrid first-stage retrieval (keyword + semantic) specified
- [ ] Reranking approach (cross-encoder / small model) defined
- [ ] Evidence packet size and composition rules set (3–8 per source)
- [ ] Source diversity and provenance tagging required