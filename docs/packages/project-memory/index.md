# @kern/project-memory — Explicit Project Notes & Decision Memory

> **Package:** `packages/project-memory`
> **Subproject:** `docs/packages/project-memory/index.md`

---

## 1. First-Principle Question

How does the agent persist explicit project knowledge — decisions, architecture notes, bugs, patterns, tasks — across sessions, so it doesn't re-learn the same facts every time?

---

## 2. Mental Model

`@kern/project-memory` is a simple key-value store for project notes. Notes have a `type` (`decision`, `architecture`, `bug`, `pattern`, `task`), `content`, optional `relatedPaths`, and timestamps. They're stored as a JSON array in `~/.kern/project-memory/notes.json` (or a custom root). Operations: `add`, `upsert`, `remove`, `search` (substring match on content/type), `recent` (latest N by createdAt).

Notes are explicit and human-authored (or agent-authored via tool use), distinct from the implicit session history. They feed into repo-aware context via the `repoResolver` in coding-agent (`projectMemory.search(query)` → project notes injected into system prompt).

---

## 3. Architecture Diagram

```mermaid
flowchart TD
    NotesJSON[("project memory notes json")] --> Store["ProjectMemoryStore: load/save/upsert/remove/search"]
    Store --> PM["ProjectMemory: add/upsert/remove/search/recent"]
  
    PM -->|search(query)| RepoResolver["coding-agent repoResolver"]
    RepoResolver -->|projectNotes injected into system prompt| CB["ContextBuilder"]
  
    User["User / Agent"] -->|add decision/architecture/bug/pattern/task| PM
  
    subgraph Store Operations
    Load["load(): parse JSON array"] --> Save["save(): append + write"]
    Save --> Upsert["upsert(): replace by id or append"]
    Upsert --> Remove["remove(): filter out by id"]
    Remove --> Search["search(): substring match content/type"]
    end
```

---

## 4. Components

### `ProjectMemoryStore` (`memory-store.ts`)

File-backed JSON array store:

- `load()` — reads `notes.json`, returns `[]` on missing/invalid.
- `save(note)` — appends a note and writes the full array.
- `upsert(note)` — replaces by `id` if present, otherwise appends.
- `remove(id)` — filters out by id; returns boolean if removed.
- `search(query)` — substring match (case-insensitive) on `content` or `type`.

File path: `{root}/notes.json` where root defaults to `~/.kern/project-memory`.

### `ProjectMemory` (`project-memory.ts`)

Higher-level wrapper:

- `add(note)` — assigns `id` (`pm_<timestamp>_<random>`) and `createdAt` (ISO), then saves.
- `upsert(note)` — delegates to store.
- `remove(id)` — delegates to store.
- `search(query)` — delegates to store.
- `recent(limit=10)` — sorts by `createdAt` descending, returns top N.

### `ProjectMemoryNote` shape

```ts
{
  id: string;
  type: "decision" | "architecture" | "bug" | "pattern" | "task";
  content: string;
  createdAt: string;
  relatedPaths?: string[];
}
```

---

## 5. Failure Modes

| Failure                     | Consequence               | Safeguard                                             |
| --------------------------- | ------------------------- | ----------------------------------------------------- |
| notes.json missing          | `load()` returns `[]` | Graceful empty start                                  |
| notes.json corrupt JSON     | `load()` returns `[]` | Try/catch on parse; no crash                          |
| Concurrent writes           | Last write wins           | No file locking; single-process assumption            |
| Note id collision on upsert | Existing note replaced    | `upsert` finds by id; `add` always creates new id |

---

## 6. Design Rules

1. Simple JSON array file — no database, no migrations.
2. Notes are explicit and typed (decision/architecture/bug/pattern/task).
3. Search is substring-based (case-insensitive) — fast and dependency-free.
4. `relatedPaths` links notes to files for future cross-referencing.
5. Integrates with repo-aware context via `projectMemory.search(query)`.

---

## 7. Checkpoint

- [ ] `ProjectMemoryStore` JSON array persistence (load/save/upsert/remove/search)
- [ ] `ProjectMemory` higher-level API (add with id/createdAt, recent)
- [ ] `ProjectMemoryNote` with type discriminator and relatedPaths
- [ ] Integration point: `repoResolver` calls `projectMemory.search(query)`
