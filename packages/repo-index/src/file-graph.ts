export interface FileGraphNode {
  path: string;
  imports: string[];
  exports: string[];
}

export class FileGraph {
  private readonly nodes = new Map<string, FileGraphNode>();
  private readonly importers = new Map<string, Set<string>>();

  add(path: string, imports: string[] = [], exports: string[] = []): void {
    const uniqueImports = [...new Set(imports)];
    const uniqueExports = [...new Set(exports)];
    const previous = this.nodes.get(path);
    if (previous) {
      for (const imp of previous.imports) {
        const set = this.importers.get(imp);
        if (!set) continue;
        set.delete(path);
        if (set.size === 0) this.importers.delete(imp);
      }
    }
    this.nodes.set(path, { path, imports: uniqueImports, exports: uniqueExports });
    for (const imp of uniqueImports) {
      const set = this.importers.get(imp) ?? new Set<string>();
      set.add(path);
      this.importers.set(imp, set);
    }
  }

  get(path: string): FileGraphNode | undefined {
    return this.nodes.get(path);
  }

  all(): FileGraphNode[] {
    return [...this.nodes.values()];
  }

  importersOf(path: string): string[] {
    return [...(this.importers.get(path) ?? [])].sort();
  }

  related(path: string, depth = 1): string[] {
    const seen = new Set<string>([path]);
    const queue: Array<{ path: string; depth: number }> = [{ path, depth: 0 }];
    const result = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= depth) continue;
      const node = this.nodes.get(current.path);
      const neighbors = [
        ...(node?.imports ?? []),
        ...this.importersOf(current.path),
      ];
      for (const next of neighbors) {
        if (seen.has(next)) continue;
        seen.add(next);
        result.add(next);
        queue.push({ path: next, depth: current.depth + 1 });
      }
    }

    return [...result].filter((p) => p !== path).sort();
  }
}
