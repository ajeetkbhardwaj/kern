export interface SymbolRecord {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "export";
  file: string;
  startLine: number;
  endLine?: number;
  module?: string;
}

export function extractSymbolsFromText(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();
  const patterns: Array<{ regex: RegExp; kind: SymbolRecord["kind"] }> = [
    { regex: /export\s+(?:async\s+)?function\s*\*?\s*(\w+)/g, kind: "function" },
    { regex: /export\s+default\s+(?:async\s+)?function\s+(\w+)/g, kind: "function" },
    { regex: /export\s+class\s+(\w+)/g, kind: "class" },
    { regex: /export\s+default\s+class\s+(\w+)/g, kind: "class" },
    { regex: /export\s+interface\s+(\w+)/g, kind: "interface" },
    { regex: /export\s+type\s+(\w+)/g, kind: "type" },
    { regex: /export\s+const\s+(\w+)/g, kind: "const" },
    { regex: /export\s+(?:let|var)\s+(\w+)/g, kind: "const" },
    { regex: /export\s+enum\s+(\w+)/g, kind: "enum" },
  ];

  for (const { regex, kind } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const name = match[1];
      if (!name) continue;
      const startLine = source.slice(0, match.index).split(/\r?\n/).length;
      const endLine = estimateEndLine(source, match.index, startLine);
      const key = `${kind}:${name}:${startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, file: filePath, startLine, ...(endLine ? { endLine } : {}) });
    }
  }

  // Named exports: export { A, B as C } [from "..."]
  for (const match of source.matchAll(/export\s*\{\s*([^}]+)\s*\}(?:\s+from\s+["'][^"']+["'])?/g)) {
    const block = match[1];
    if (!block) continue;
    const startLine = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
    const names = block
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => n.split(/\s+as\s+/i).map((p) => p.trim()).filter(Boolean).at(-1) ?? "")
      .filter((n) => n && n !== "type" && n !== "default");
    for (const name of names) {
      const key = `export:${name}:${startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind: "export", file: filePath, startLine, endLine: startLine });
    }
  }

  if (/\bexport\s+default\b/.test(source) && !symbols.some((s) => s.name === "default")) {
    const idx = source.search(/\bexport\s+default\b/);
    const startLine = idx >= 0 ? source.slice(0, idx).split(/\r?\n/).length : 1;
    symbols.push({ name: "default", kind: "export", file: filePath, startLine, endLine: startLine });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
}

function estimateEndLine(source: string, index: number, startLine: number): number {
  const slice = source.slice(index, index + 2000);
  const brace = slice.indexOf("{");
  if (brace >= 0) {
    let depth = 0;
    for (let i = brace; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return startLine + slice.slice(0, i + 1).split(/\r?\n/).length - 1;
        }
      }
    }
  }
  const semi = slice.indexOf(";");
  if (semi >= 0) {
    return startLine + slice.slice(0, semi + 1).split(/\r?\n/).length - 1;
  }
  return startLine;
}
