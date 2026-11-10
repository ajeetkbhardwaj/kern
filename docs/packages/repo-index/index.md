# @kern/repo-index — Workspace Indexing for Repo-Aware Context

> **Package:** `packages/repo-index`
> **Subproject:** `docs/packages/repo-index/index.md`

---

## 1. First-Principle Question

How does the agent know which files in the workspace are relevant to a user's query, without reading every file or relying on a heavy vector database?

---

## 2. Mental Model

`@kern/repo-index` is a lightweight workspace index. On `refresh()`, it walks the directory tree (ignoring `node_modules`, `.git`, `.next`, etc.), reads every file, extracts imports/exports via regex, and records each file's path, extension, size, modified time, imports, and exports. It builds a `FileGraph` mapping file → imports/exports for dependency traversal.

Queries are lightweight: `searchByName` (substring match on path), `searchByImport` (files importing a given name), and `all()` / `byPath()`. The index is refreshed lazily via `ensureLoaded()`.

This is Pi-style repo awareness: fast, dependency-free, and sufficient for the context builder to inject likely-relevant files into the system prompt.

---

## 3. Architecture Diagram

```mermaid
flowchart TD
    Root[("Workspace Root")] --> Walk["refresh(): walk directory tree"]
    Walk --> Filter["ignore: node_modules, .git, .next, dist, build, coverage, .turbo, .env*"]
    Filter --> Read["readFile: extract imports + exports"]
    Read --> Record["RepoFileRecord: path, ext, size, mtime, imports, exports"]
    Record --> Graph["FileGraph: file → imports/exports"]
    Graph --> Index[("in-memory map path repo file record")]
  
    Query["RepoIndexQuery: path / name / importName"] --> Index
    Index -->|searchByName| Results["matching files"]
    Index -->|searchByImport| Results
    Index -->|all()| Results
    Index -->|byPath()| Results
  
    AgentCore["Agent Core / ContextBuilder"] -->|likelyFiles, relevantSymbols| Query
```

---

## 4. Components

### `RepoIndex` (`repo-index.ts`)

| Method                         | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `refresh()`                  | Re-walk the tree, rebuild files map + graph           |
| `ensureLoaded()`             | Lazy refresh if not yet initialized                   |
| `all()`                      | All files, sorted by path                             |
| `byPath(path)`               | Single file record                                    |
| `searchByName(name)`         | Files whose path contains the name (case-insensitive) |
| `searchByImport(importName)` | Files that import the given name                      |
| `fileGraph()`                | The `FileGraph` for dependency traversal            |

### `FileGraph` (`file-graph.ts`)

| Method                          | Purpose                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `add(path, imports, exports)` | Register a file's import/export edges                                               |
| `get(path)`                   | Single node                                                                         |
| `all()`                       | All nodes                                                                           |
| `related(path, depth)`        | BFS traversal up to `depth` levels, returning related file paths (excluding self) |

### Import/Export Extraction

- **Imports**: regex matches `from "..."` and `import("...")`; relative paths are resolved to absolute; bare package names kept as-is.
- **Exports**: regex matches `export function`, `export class`, `export interface`, `export type`, `export const`, and `export { ... }` blocks.

### Ignored Directories

`node_modules`, `.git`, `.next`, `dist`, `build`, `coverage`, `.turbo` (plus user-specified). Hidden files (`.`) are skipped except `.agents` and `.pi`. `.env*` files and `session-*.md` files are ignored by default.

---

## 5. Failure Modes

| Failure                               | Consequence                              | Safeguard                                                 |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Directory walk fails (permissions)    | Individual file skipped; index continues | `stat().catch(() => null)`; read errors caught per-file |
| Import/export regex misses edge cases | Incomplete graph                         | Best-effort; graph is advisory, not authoritative         |
| Index not initialized                 | `ensureLoaded()` triggers refresh      | Lazy init on first query                                  |
| Large workspace                       | Slow initial refresh                     | One-time cost; index held in memory                       |

---

## 6. Design Rules

1. Lightweight, dependency-free index (only `@kern/protocol`).
2. Lazy initialization; refresh on demand.
3. Imports/exports extracted via regex (good enough for JS/TS; not a full parser).
4. FileGraph supports BFS dependency traversal for related-file discovery.
5. Hidden/system directories ignored by default; `.agents` and `.pi` preserved.

---

## 7. Checkpoint

- [ ] `RepoIndex` walks workspace, extracts imports/exports, builds file graph
- [ ] `FileGraph` supports BFS `related(path, depth)` traversal
- [ ] Queries: `all()`, `byPath()`, `searchByName()`, `searchByImport()`
- [ ] Lazy init via `ensureLoaded()`
- [ ] Ignored dirs/files configurable with sensible defaults
