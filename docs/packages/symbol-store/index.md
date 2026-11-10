# @kern/symbol-store — Lightweight Symbol Extraction & Lookup

> **Package:** `packages/symbol-store`
> **Subproject:** `docs/packages/symbol-store/index.md`

---

## 1. First-Principle Question

How can the agent find where a function, class, interface, or type is defined in a TypeScript/JavaScript codebase without a full language server?

---

## 2. Mental Model

`@kern/symbol-store` extracts exported symbols from `.ts`, `.tsx`, `.js`, `.mjs` files using regex patterns (not a full parser). It indexes the entire repo once (`indexRepo()`), caching symbols per file in memory. Lookups are by name (`findByName`) or by file (`findByFile`). Symbols carry name, kind (function/class/interface/type/const), file, and line numbers.

This is intentionally lightweight — good enough for the context builder to surface relevant symbols and files for a query, without the overhead of a language server.

---

## 3. Architecture Diagram

```mermaid
flowchart TD
    RepoIndex["RepoIndex: all files"] --> IndexRepo["indexRepo(): read + parse each file"]
    IndexRepo --> Cache[("in-memory map file symbol record list")]
    
    Cache --> FindByName["findByName(name): exact or substring match"]
    Cache --> FindByFile["findByFile(file): symbols in one file"]
    Cache --> Related["related(name): alias for findByName"]
    
    SemanticSearch["SemanticSearch"] -->|lookupSymbols(file)| Cache
    ReadStrategy["ReadStrategy"] -->|symbolStore.findByName / findByFile| Cache
```

---

## 4. Components

### `SymbolStore` (`symbol-store.ts`)

| Method | Purpose |
|---|---|
| `indexRepo()` | Ensures RepoIndex loaded; clears cache; reads + parses each `.ts`/`.tsx`/`.js`/`.mjs` file |
| `findByName(name)` | Returns all symbols matching (exact or substring, case-insensitive) across all files |
| `findByFile(file)` | Returns symbols for a specific file |
| `related(name)` | Alias for `findByName` |

### `ts-parser.ts` — Symbol Extraction

Patterns (regex, applied to full source text):
| Pattern | Kind |
|---|---|
| `export (async)? function (\w+)` | `function` |
| `export class (\w+)` | `class` |
| `export interface (\w+)` | `interface` |
| `export type (\w+)` | `type` |
| `export const (\w+)` | `const` |

Each match yields a `SymbolRecord` with `name`, `kind`, `file`, `startLine`, `endLine` (startLine + 5), and optional `module`.

`SymbolRecord` shape:
```ts
{ name: string; kind: "function" \| "class" \| "interface" \| "type" \| "const" \| "export"; file: string; startLine: number; endLine?: number; module?: string }
```

---

## 5. Failure Modes

| Failure | Consequence | Safeguard |
|---|---|---|
| Regex misses non-exported symbols | Only exported symbols indexed | Acceptable: agent needs public API surface; unexported symbols are internal |
| File read fails during indexRepo | Empty symbol list for that file | Try/catch per file; cache set to `[]` |
| Regex false positives (e.g., `export const` in a string) | Spurious symbols | Best-effort; symbol lookup is advisory |
| No full TypeScript parser | Can't resolve re-exports or type aliases | Acceptable trade-off for zero-dependency operation |

---

## 6. Design Rules

1. Zero-dependency symbol extraction via regex (no language server).
2. Index once (`indexRepo()`); cache in memory; lookups are O(1) per file + O(n) across files for name search.
3. Only `.ts`/`.tsx`/`.js`/`.mjs` files are indexed.
4. Symbols are advisory — used by semantic search and read strategy, never authoritative.

---

## 7. Checkpoint

- [ ] `SymbolStore.indexRepo()` reads + parses all JS/TS files
- [ ] `findByName` / `findByFile` / `related` lookups
- [ ] `ts-parser.ts` regex patterns for function/class/interface/type/const
- [ ] `SymbolRecord` with name, kind, file, line numbers
- [ ] Per-file error isolation during indexing