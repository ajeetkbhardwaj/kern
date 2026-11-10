import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory, ProjectMemoryStore } from "../src/index";

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kern-project-memory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectMemoryStore", () => {

  it("load returns empty array when file doesn't exist", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const result = await store.load();
    expect(result).toEqual([]);
  });

  it("save adds a note and persists it", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const note = { id: "test1", type: "decision" as const, content: "test decision" };
    await store.save(note);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("test1");
    expect(loaded[0]?.content).toBe("test decision");
  });

  it("save appends note without overwriting", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "note1", type: "decision" as const, content: "first" });
    await store.save({ id: "note2", type: "decision" as const, content: "second" });
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
  });

  it("upsert replaces existing note by id", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "note1", type: "decision" as const, content: "original" });
    await store.upsert({ id: "note1", type: "decision" as const, content: "updated" });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("updated");
  });

  it("upsert appends when no id match", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "note1", type: "decision" as const, content: "first" });
    await store.upsert({ id: "note2", type: "decision" as const, content: "second" });
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
  });

  it("remove removes note by id", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "note1", type: "decision" as const, content: "to remove" });
    await store.save({ id: "note2", type: "decision" as const, content: "to keep" });
    await store.remove("note1");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("note2");
  });

  it("remove returns false when id not found", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "note1", type: "decision" as const, content: "only one" });
    const result = await store.remove("nonexistent");
    expect(result).toBe(false);
  });

  it("search finds notes by content or type", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "n1", type: "decision" as const, content: "buy milk" });
    await store.save({ id: "n2", type: "decision" as const, content: "use typescript" });
    await store.save({ id: "n3", type: "bug" as const, content: "fix crash" });

    const decisions = await store.search("decision");
    expect(decisions).toHaveLength(2);

    const milk = await store.search("milk");
    expect(milk).toHaveLength(1);
    expect(milk[0]?.id).toBe("n1");
  });

  it("search is case-insensitive", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    await store.save({ id: "n1", type: "decision" as const, content: "test" });
    const results = await store.search("decision");
    expect(results).toHaveLength(1);
  });
});

describe("ProjectMemory", () => {
  it("add creates note with id and createdAt", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const memory = new ProjectMemory(store);
    const note = await memory.add({ type: "decision", content: "test decision" });
    expect(note.id).toMatch(/^pm_/);
    expect(note.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(note.content).toBe("test decision");
  });

  it("remove removes a note", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const memory = new ProjectMemory(store);
    await memory.add({ type: "decision", content: "to remove" });
    const loaded = await memory.store.load();
    const id = loaded[0]?.id ?? "";
    const result = await memory.remove(id);
    expect(result).toBe(true);
  });

  it("search returns notes matching query", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const memory = new ProjectMemory(store);
    await memory.add({ type: "decision", content: "buy milk" });
    await memory.add({ type: "bug", content: "fix crash" });
    const results = await memory.search("milk");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("buy milk");
  });

  it("recent returns notes sorted by createdAt descending", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const memory = new ProjectMemory(store);
    await memory.add({ type: "decision", content: "first" });
    await memory.add({ type: "decision", content: "second" });
    await new Promise((r) => setTimeout(r, 100));
    const recent = await memory.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe("second");
  });

  it("recent with limit", async () => {
    const store = new ProjectMemoryStore({ root: await testRoot() });
    const memory = new ProjectMemory(store);
    await memory.add({ type: "decision", content: "first" });
    await memory.add({ type: "decision", content: "second" });
    await memory.add({ type: "decision", content: "third" });
    await new Promise((r) => setTimeout(r, 100));
    const recent = await memory.recent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.content).toBe("third");
    expect(recent[1]?.content).toBe("second");
  });
});