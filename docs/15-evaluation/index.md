# 15 — Evaluation

> **Part IV — Reliability, Trust, and Extensions — Chapter 15**
> Subproject: `docs/15-evaluation/index.md`

---

## 1. First-Principle Question

How do we measure whether LocalPerplex returns correct, well-cited, current answers, and improve retrieval, ranking, and prompts over time without regressing?

---

## 2. Mental Model

Evaluation is essential because retrieval and generation failures are silent without measurement. Metrics span retrieval quality (precision/recall/MRR), answer faithfulness (claims supported by evidence), citation accuracy (citations resolve to correct sources), freshness (results are current), latency, and cost. Human evaluation validates edge cases. A regression suite runs test questions through the engine and diffs metrics over time. Improvement flows back into retrieval, ranking, and prompts.

---

## 3. How Perplexity-Style Systems Work

Perplexity evaluates answer quality internally but does not publish a public regression suite. LocalPerplex adopts an open, local-first evaluation: fixed test questions → engine → answers → metrics → improve.

---

## 4. Local-First Adaptation

Evaluation runs entirely on-device: test questions, answers, and metrics never leave the machine. Retrieval metrics are computed against the local index and cached web results. Citation accuracy checks that each citation ID resolves to the source it claims. Faithfulness checks that every factual claim maps to evidence. Freshness measures result age against the question's time-sensitivity. Latency and cost are tracked per query. A local regression suite stores golden answers and diffs new runs against them.

---

## 5. Architecture Diagram

```mermaid
flowchart LR
    Questions[Test questions] --> Engine[Answer engine]
    Engine --> Answers[Answers]
    Answers --> Metrics[Metrics]
    Metrics --> Improve[Improve retrieval / ranking / prompts]
```

---

## 6. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Evaluation scope | Retrieval, faithfulness, citations, freshness, latency, cost | Full answer-engine stack covered |
| Test questions | Fixed golden set, versioned | Reproducible measurements |
| Citation accuracy | Citation ID resolves to correct source | Direct verifiability check |
| Faithfulness | Every factual claim maps to evidence | Anti-hallucination check |
| Freshness | Result age vs question time-sensitivity | Current-answer check |
| Regression suite | Local; golden answers diffed per run | Catch regressions before release |
| Human evaluation | Sampled answers reviewed by user | Validate edge cases |

---

## 7. Failure Modes

| Failure | Consequence | Safeguard |
|---|---|---|
| No evaluation | Silent regressions | Mandatory regression suite |
| Poor metric definition | Optimising wrong thing | Metrics map to product promise |
| Test set drift | Stale benchmarks | Versioned golden set; periodic refresh |
| Only automated metrics | Misses nuance | Human evaluation sample |
| Local-only eval misses web | Web path untested | Cached web results + optional live tests |

---

## 8. Design Rules

1. Evaluation runs locally; no test data leaves the device.
2. Metrics cover retrieval, faithfulness, citations, freshness, latency, cost.
3. Citation accuracy: each citation ID resolves to its claimed source.
4. Faithfulness: every factual claim maps to evidence.
5. Regression suite diffs new runs against golden answers.
6. Human evaluation samples answers for nuance.
7. Improvement loop: metrics → retrieval/ranking/prompts.

---

## 9. Checkpoint

- [ ] Evaluation metrics defined (retrieval, faithfulness, citations, freshness, latency, cost)
- [ ] Test question set (golden, versioned) specified
- [ ] Citation accuracy and faithfulness checks defined
- [ ] Regression suite approach (golden answer diffing) specified
- [ ] Human evaluation sampling defined
- [ ] Improvement loop (metrics → retrieval/ranking/prompts) documented