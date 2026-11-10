import { readFile } from "node:fs/promises";
import type { RepoIndex } from "@kern/repo-index";
import { extractSymbolsFromText, type SymbolRecord } from "./ts-parser.js";

export interface SymbolQueryResult {
  matches: SymbolRecord[];
  score: number;
}

export class SymbolStore {
  private readonly repoIndex: RepoIndex;
  private cache = new Map<string, SymbolRecord[]>();
  private mtimes = new Map<string, number | undefined>();
  private lastIndexedAt: string | null = null;

  constructor(repoIndex: RepoIndex) {
    this.repoIndex = repoIndex;
  }

  async indexRepo(options: { incremental?: boolean } = {}): Promise<void> {
    await this.repoIndex.ensureLoaded();
    if (!options.incremental) {
      this.cache.clear();
      this.mtimes.clear();
    }
    const seen = new Set<string>();
    for (const file of this.repoIndex.all()) {
      if (!this.isSupported(file.path)) continue;
      seen.add(file.path);
      const mtimeMs = file.modifiedAt ? Date.parse(file.modifiedAt) : undefined;
      if (options.incremental && this.cache.has(file.path) && this.mtimes.get(file.path) === mtimeMs) {
        continue;
      }
      try {
        const source = await readFile(file.path, "utf8");
        this.cache.set(file.path, extractSymbolsFromText(source, file.path));
      } catch {
        this.cache.set(file.path, []);
      }
      this.mtimes.set(file.path, mtimeMs);
    }
    for (const existing of [...this.cache.keys()]) {
      if (!seen.has(existing)) {
        this.cache.delete(existing);
        this.mtimes.delete(existing);
      }
    }
    this.lastIndexedAt = new Date().toISOString();
  }

  getLastIndexedAt(): string | null {
    return this.lastIndexedAt;
  }

  findByName(name: string): SymbolRecord[] {
    const needle = name.toLowerCase().trim();
    if (!needle) return [];
    const results: SymbolRecord[] = [];
    for (const list of this.cache.values()) {
      for (const symbol of list) {
        const lower = symbol.name.toLowerCase();
        if (lower === needle || lower.includes(needle) || needle.includes(lower)) {
          results.push(symbol);
        }
      }
    }
    return results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === needle ? 1 : 0;
      const bExact = b.name.toLowerCase() === needle ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.startLine - b.startLine;
    });
  }

  findByFile(file: string): SymbolRecord[] {
    return this.cache.get(file) ?? [];
  }

  related(name: string): SymbolRecord[] {
    return this.findByName(name);
  }

  private isSupported(filePath: string): boolean {
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].some((ext) => filePath.endsWith(ext));
  }
}
