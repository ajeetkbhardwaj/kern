import { ProjectMemoryStore, type ProjectMemoryNote } from "./memory-store.js";

export class ProjectMemory {
  store: ProjectMemoryStore;

  constructor(store: ProjectMemoryStore = new ProjectMemoryStore()) {
    this.store = store;
  }

  async add(note: Omit<ProjectMemoryNote, "id" | "createdAt" | "updatedAt">): Promise<ProjectMemoryNote> {
    const now = new Date().toISOString();
    const entry: ProjectMemoryNote = {
      ...note,
      id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsert(entry);
    return entry;
  }

  async upsert(note: ProjectMemoryNote): Promise<ProjectMemoryNote> {
    return this.store.upsert(note);
  }

  async remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async get(id: string): Promise<ProjectMemoryNote | undefined> {
    return this.store.get(id);
  }

  async search(query: string): Promise<ProjectMemoryNote[]> {
    return this.store.search(query);
  }

  async recent(limit = 10): Promise<ProjectMemoryNote[]> {
    const notes = await this.store.load();
    return notes
      .map((note, index) => ({ note, index }))
      .sort((a, b) => {
        const at = a.note.updatedAt ?? a.note.createdAt ?? new Date(0).toISOString();
        const bt = b.note.updatedAt ?? b.note.createdAt ?? new Date(0).toISOString();
        const byTime = bt.localeCompare(at);
        if (byTime !== 0) return byTime;
        return b.index - a.index;
      })
      .slice(0, limit)
      .map(({ note }) => note);
  }
}
