import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { FileGraph } from "./file-graph.js";

export interface RepoFileRecord {
  path: string;
  relativePath: string;
  kind: "file" | "dir";
  extension?: string;
  size?: number;
  modifiedAt?: string;
  imports?: string[];
  exports?: string[];
}

export interface RepoIndexOptions {
  root: string;
  ignoreDirs?: string[];
  ignoreFiles?: RegExp[];
}

export interface RepoIndexQuery {
  path?: string;
  name?: string;
  importName?: string;
}

export interface RefreshOptions {
  incremental?: boolean;
}

export class RepoIndex {
  private readonly root: string;
  private readonly ignoreDirs: Set<string>;
  private readonly ignoreFiles: RegExp[];
  private files = new Map<string, RepoFileRecord>();
  private mtimes = new Map<string, number>();
  private graph = new FileGraph();
  private initialized = false;
  private lastRefreshedAt: string | null = null;

  constructor(options: RepoIndexOptions) {
    this.root = resolve(options.root);
    this.ignoreDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ...(options.ignoreDirs ?? [])]);
    this.ignoreFiles = options.ignoreFiles ?? [/^\.env(?:\.|$)/, /session-.*\.md$/i];
  }

  async refresh(options: RefreshOptions = {}): Promise<void> {
    if (!options.incremental || !this.initialized) {
      this.files.clear();
      this.mtimes.clear();
      this.graph = new FileGraph();
    }
    const seen = new Set<string>();
    await this.walk(this.root, seen, options.incremental === true);
    if (options.incremental && this.initialized) {
      for (const existing of [...this.files.keys()]) {
        if (!seen.has(existing)) {
          this.files.delete(existing);
          this.mtimes.delete(existing);
        }
      }
      this.rebuildGraph();
    }
    this.initialized = true;
    this.lastRefreshedAt = new Date().toISOString();
  }

  getRoot(): string {
    return this.root;
  }

  getLastRefreshedAt(): string | null {
    return this.lastRefreshedAt;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.initialized) await this.refresh();
  }

  all(): RepoFileRecord[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  byPath(path: string): RepoFileRecord | undefined {
    const abs = resolve(this.root, path);
    return this.files.get(abs) ?? this.files.get(resolve(path));
  }

  searchByName(name: string): RepoFileRecord[] {
    const needle = name.toLowerCase();
    return this.all().filter((file) => {
      const rel = file.relativePath.toLowerCase();
      const base = rel.split("/").at(-1) ?? rel;
      return rel.includes(needle) || base.includes(needle);
    });
  }

  searchByImport(importName: string): RepoFileRecord[] {
    const needle = importName.toLowerCase();
    return this.all().filter((file) => file.imports?.some((entry) => entry.toLowerCase().includes(needle)) || false);
  }

  fileGraph(): FileGraph {
    return this.graph;
  }

  private async walk(dir: string, seen: Set<string>, incremental: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".agents" && entry.name !== ".pi") {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (this.ignoreDirs.has(entry.name)) continue;
        await this.walk(resolve(dir, entry.name), seen, incremental);
        continue;
      }

      const fullPath = resolve(dir, entry.name);
      if (this.isIgnoredFile(fullPath)) continue;
      const stats = await stat(fullPath).catch(() => null);
      if (!stats || !stats.isFile()) continue;
      seen.add(fullPath);

      const prevMtime = this.mtimes.get(fullPath);
      if (incremental && prevMtime === stats.mtimeMs && this.files.has(fullPath)) {
        continue;
      }

      const rel = relative(this.root, fullPath).split("\\").join("/");
      const ext = extname(fullPath) || undefined;
      const imports = await this.collectImports(fullPath);
      const exports = await this.collectExports(fullPath);
      const record: RepoFileRecord = {
        path: fullPath,
        relativePath: rel,
        kind: "file",
        ...(ext ? { extension: ext } : {}),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        imports,
        exports,
      };
      this.files.set(fullPath, record);
      this.mtimes.set(fullPath, stats.mtimeMs);
      if (!incremental) this.graph.add(fullPath, imports, exports);
    }
  }

  private rebuildGraph(): void {
    this.graph = new FileGraph();
    for (const file of this.files.values()) {
      this.graph.add(file.path, file.imports ?? [], file.exports ?? []);
    }
  }

  private async collectImports(filePath: string): Promise<string[]> {
    try {
      const text = await readFile(filePath, "utf8");
      const matches = [...text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)];
      const result = new Set<string>();
      for (const match of matches) {
        const value = match[1] ?? match[2] ?? match[3];
        if (!value) continue;
        if (value.startsWith(".") || value.startsWith("/") || value.startsWith("@/")) {
          result.add(resolve(dirname(filePath), value));
        } else {
          result.add(value);
        }
      }
      return [...result];
    } catch {
      return [];
    }
  }

  private async collectExports(filePath: string): Promise<string[]> {
    try {
      const text = await readFile(filePath, "utf8");
      const symbols = new Set<string>();
      for (const pattern of [
        /export\s+(?:async\s+)?function\s*\*?\s*(\w+)/g,
        /export\s+class\s+(\w+)/g,
        /export\s+interface\s+(\w+)/g,
        /export\s+type\s+(\w+)/g,
        /export\s+const\s+(\w+)/g,
        /export\s+enum\s+(\w+)/g,
        /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+default\s+class\s+(\w+)/g,
        /export\s+\{\s*([^}]+)\s*\}(?:\s+from\s+["'][^"']+["'])?/g,
      ]) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const value = match[1];
          if (!value) continue;
          const names = value
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => {
              const parts = n.split(/\s+as\s+/i).map((p) => p.trim()).filter(Boolean);
              return parts[parts.length - 1] ?? parts[0] ?? "";
            })
            .filter((name): name is string => !!name && name !== "type");
          for (const name of names) symbols.add(name);
        }
      }
      if (/\bexport\s+default\b/.test(text) && symbols.size === 0) symbols.add("default");
      return [...symbols];
    } catch {
      return [];
    }
  }

  private isIgnoredFile(filePath: string): boolean {
    const base = filePath.split("/").at(-1) ?? "";
    const rel = relative(this.root, filePath).split("\\").join("/");
    return this.ignoreFiles.some((re) => re.test(base) || re.test(rel));
  }
}
