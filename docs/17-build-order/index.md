# 17 — Build Order

> **Part V — Building LocalPerplex — Chapter 17**
> Subproject: `docs/17-build-order/index.md`

---

## 1. First-Principle Question

In what order should capabilities be built so each milestone delivers usable value and no milestone depends on unbuilt complexity?

---

## 2. Mental Model

Build incrementally: V1 local document ingestion → V2 local semantic search → V3 cited local answers → V4 web search fallback → V5 hybrid local + web → V6 citation verification → V7 research workspace → V8 local model support → V9 extensions → V10 evaluation. Each version builds on the previous and is independently usable. Do not build all of LocalPerplex at once; the minimal product is local RAG with citations and optional web fallback.

---

## 3. How Perplexity-Style Systems Work

Perplexity evolved from web search + cited answers to internal knowledge + web hybrid. LocalPerplex mirrors this but starts local-only and adds web later, reflecting the privacy-first product promise.

Source: [Perplexity Photon blog](https://www.perplexity.ai/en-GB/hub/blog/photon)

```mermaid
flowchart LR
    V1[Local RAG] --> V2[Citations] --> V3[Web fallback] --> V4[Hybrid] --> V5[Multi-agent research]
```

---

## 4. Local-First Adaptation

V1–V3 are entirely local: ingestion, semantic search, cited answers. V4–V5 add web as an opt-in fallback then hybrid. V6 adds verification before any answer ships. V7–V10 add workspace, local models, extensions, and evaluation — all optional layers on top of the working core.

---

## 5. Architecture Diagram

```mermaid
flowchart LR
    V1[Local RAG] --> V2[Citations] --> V3[Web fallback] --> V4[Hybrid] --> V5[Multi-agent research]
```

---

## 6. Design Decisions

| Milestone | Capability | Depends on |
|---|---|---|
| V1 | Search local PDFs and notes | Ingestion pipeline + local index |
| V2 | Cited local answers | V1 + citation-grounded generation |
| V3 | Web fallback when local evidence weak | V2 + web research layer + router |
| V4 | Hybrid local + web research | V3 + hybrid retrieval + ranker |
| V5 | Multi-agent research (planner/researcher/critic/writer) | V4 + orchestration layer |
| V6 | Citation verification | V5 + verifier |
| V7 | Research workspace | V6 + local persistence |
| V8 | Local model support | V7 + model routing |
| V9 | Extensions | V8 + pluggable tool/connector layer |
| V10 | Evaluation | V9 + regression suite + metrics |

---

## 7. Failure Modes

| Failure | Consequence | Safeguard |
|---|---|---|
| Building V5 before V3 | Complex orchestration over broken retrieval | Hard dependency order; no skipping |
| Skipping V6 | Unverified citations ship | Verification is a hard gate before V7 |
| Building workspace before core | Empty shell with no answers | Core (V1–V3) must ship first |

---

## 8. Design Rules

1. Build in dependency order; never skip a milestone.
2. Each milestone must be independently usable.
3. V1–V3 (local RAG + citations) is the minimal product gate.
4. V6 (verification) gates all later user-facing versions.
5. Web is added after local answers work (V4).
6. Multi-agent is last among core features (V5), after retrieval is solid.

---

## 9. Checkpoint

- [ ] Build order V1→V10 defined with capabilities and dependencies
- [ ] Minimal product gate identified (V1–V3: local RAG + citations)
- [ ] Verification gate (V6) before later user-facing versions
- [ ] Web added after local answers (V4)
- [ ] Multi-agent scheduled last among core features (V5)