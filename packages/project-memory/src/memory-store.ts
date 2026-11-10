import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ProjectMemoryNote {
  id: string;
  type: "decision" | "architecture" | "bug" | "pattern" | "task";
  content: string;
  createdAt?: string;
  updatedAt?: string;
  relatedPaths?: string[];
  tags?: string[];
}

export interface ProjectMemoryStoreOptions {
  root?: string;
}

export class ProjectMemoryStore {
  private readonly root: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ProjectMemoryStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".kern", "project-memory");
  }

  async load(): Promise<ProjectMemoryNote[]> {
    const file = this.path();
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as ProjectMemoryNote[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((n): n is ProjectMemoryNote => !!n && typeof n === "object" && typeof n.id === "string");
    } catch {
      return [];
    }
  }

  async save(note: ProjectMemoryNote): Promise<void> {
    await this.upsert(note);
  }

  async upsert(note: ProjectMemoryNote): Promise<ProjectMemoryNote> {
    return this.serialized(async () => {
      const file = this.path();
      await mkdir(dirname(file), { recursive: true });
      const current = await this.load();
      const now = new Date().toISOString();
      const existing = current.find((entry) => entry.id === note.id);
      const entry: ProjectMemoryNote = {
        ...note,
        createdAt: note.createdAt ?? existing?.createdAt ?? now,
        updatedAt: now,
      };
      const index = current.findIndex((entry) => entry.id === note.id);
      if (index >= 0) {
        current[index] = entry;
      } else {
        current.push(entry);
      }
      await this.writeAtomic(file, JSON.stringify(current, null, 2) + "\n");
      return entry;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialized(async () => {
      const file = this.path();
      const current = await this.load();
      const next = current.filter((note) => note.id !== id);
      if (next.length === current.length) return false;
      await mkdir(dirname(file), { recursive: true });
      await this.writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
      return true;
    });
  }

  async get(id: string): Promise<ProjectMemoryNote | undefined> {
    return (await this.load()).find((note) => note.id === id);
  }

  async search(query: string): Promise<ProjectMemoryNote[]> {
    const q = query.toLowerCase().trim();
    if (!q) return this.load();
    const terms = q.split(/\s+/).filter(Boolean);
    return (await this.load())
      .map((note) => ({ note, score: this.score(note, q, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || (b.note.updatedAt ?? b.note.createdAt ?? "").localeCompare(a.note.updatedAt ?? a.note.createdAt ?? ""))
      .map((entry) => entry.note);
  }

  private score(note: ProjectMemoryNote, query: string, terms: string[]): number {
    const hay = `${note.type}\n${note.content}\n${(note.tags ?? []).join(" ")}\n${(note.relatedPaths ?? []).join(" ")}`.toLowerCase();
    let score = 0;
    if (note.type.toLowerCase() === query) score += 30;
    if (hay.includes(query)) score += 20;
    for (const term of terms) {
      if (!term) continue;
      if (note.type.toLowerCase().includes(term)) score += 8;
      if (note.content.toLowerCase().includes(term)) score += 6;
      if ((note.tags ?? []).some((t) => t.toLowerCase().includes(term))) score += 5;
      if ((note.relatedPaths ?? []).some((p) => p.toLowerCase().includes(term))) score += 4;
    }
    return score;
  }

  private async writeAtomic(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private path(): string {
    return join(this.root, "notes.json");
  }
}
