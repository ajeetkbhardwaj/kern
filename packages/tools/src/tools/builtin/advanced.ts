import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDefinition, ToolResult, textResult } from "@kern/protocol";

async function loadJsonRecord<T>(filePath: string): Promise<Record<string, T>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, T>;
    }
  } catch {
    // missing or unreadable
  }
  return {};
}

async function saveJsonRecord<T>(workspaceRoot: string, fileName: string, data: Record<string, T>): Promise<void> {
  const dir = join(workspaceRoot, ".kern");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function createMemoryTool(_root: string): ToolDefinition<{ action: "get" | "set" | "delete" | "list"; key?: string; value?: string }> {
  return {
    name: "memory",
    description: "Persistent key-value memory across sessions (stored in .kern/memory.json)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "delete", "list"] },
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["action"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const filePath = join(ctx.workspaceRoot, ".kern", "memory.json");
      const store = await loadJsonRecord<string>(filePath);
      switch (args.action) {
        case "get":
          if (!args.key) return textResult("key required for get", true);
          return { content: [{ type: "text", text: store[args.key] ?? "(not found)" }], isError: false };
        case "set":
          if (!args.key || args.value === undefined) return textResult("key and value required for set", true);
          store[args.key] = args.value;
          await saveJsonRecord(ctx.workspaceRoot, "memory.json", store);
          return { content: [{ type: "text", text: `Set ${args.key} = ${args.value}` }], isError: false };
        case "delete":
          if (!args.key) return textResult("key required for delete", true);
          delete store[args.key];
          await saveJsonRecord(ctx.workspaceRoot, "memory.json", store);
          return { content: [{ type: "text", text: `Deleted ${args.key}` }], isError: false };
        case "list": {
          const entries = Object.entries(store).map(([k, v]) => `${k}=${v}`).join("\n") || "(empty)";
          return { content: [{ type: "text", text: entries }], isError: false };
        }
      }
    },
  };
}

export function createModelPickerTool(_root: string): ToolDefinition<{ task?: string }> {
  return {
    name: "model-picker",
    description: "Let the model pick the best configured model for a task",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "Description of the task" } } },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args): Promise<ToolResult> {
      return { content: [{ type: "text", text: `Model selection for: ${args.task ?? "general task"}\n(Use --model or /model to change manually)` }], isError: false };
    },
  };
}

interface PlanRecord {
  title: string;
  content: string;
  completed: boolean;
  createdAt: number;
}

export function createPlanTool(_root: string): ToolDefinition<{ action: "add" | "update" | "complete" | "remove" | "list"; id?: string; title?: string; content?: string }> {
  return {
    name: "plan",
    description: "Manage structured plans and task lists (persisted in .kern/plans.json)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "complete", "remove", "list"] },
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["action"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const filePath = join(ctx.workspaceRoot, ".kern", "plans.json");
      const plans = await loadJsonRecord<PlanRecord>(filePath);
      switch (args.action) {
        case "add":
          if (!args.id || !args.title) return textResult("id and title required for add", true);
          plans[args.id] = { title: args.title, content: args.content ?? "", completed: false, createdAt: Date.now() };
          await saveJsonRecord(ctx.workspaceRoot, "plans.json", plans);
          return { content: [{ type: "text", text: `Added plan: ${args.id}` }], isError: false };
        case "update": {
          if (!args.id || !plans[args.id]) return textResult("plan not found", true);
          const p = plans[args.id]!;
          if (args.title) p.title = args.title;
          if (args.content) p.content = args.content;
          await saveJsonRecord(ctx.workspaceRoot, "plans.json", plans);
          return { content: [{ type: "text", text: `Updated plan: ${args.id}` }], isError: false };
        }
        case "complete":
          if (!args.id || !plans[args.id]) return textResult("plan not found", true);
          plans[args.id]!.completed = true;
          await saveJsonRecord(ctx.workspaceRoot, "plans.json", plans);
          return { content: [{ type: "text", text: `Completed: ${args.id}` }], isError: false };
        case "remove":
          if (!args.id || !plans[args.id]) return textResult("plan not found", true);
          delete plans[args.id];
          await saveJsonRecord(ctx.workspaceRoot, "plans.json", plans);
          return { content: [{ type: "text", text: `Removed: ${args.id}` }], isError: false };
        case "list": {
          const lines = Object.entries(plans).map(([id, p]) => `${p.completed ? "✓" : "○"} ${id}: ${p.title}${p.content ? ` - ${p.content}` : ""}`);
          return { content: [{ type: "text", text: lines.join("\n") || "(no plans)" }], isError: false };
        }
      }
    },
  };
}

interface TodoRecord {
  content: string;
  completed: boolean;
  createdAt: number;
}

let todoSeq = 0;

export function createTodoTool(_root: string): ToolDefinition<{ action: "add" | "complete" | "remove" | "list"; id?: string; content?: string }> {
  return {
    name: "todo",
    description: "Manage persistent todo lists (stored in .kern/todos.json)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "remove", "list"] },
        id: { type: "string" },
        content: { type: "string" },
      },
      required: ["action"],
    },
    sideEffect: "write",
    annotations: { destructiveHint: false },
    async execute(args, ctx): Promise<ToolResult> {
      const filePath = join(ctx.workspaceRoot, ".kern", "todos.json");
      const todos = await loadJsonRecord<TodoRecord>(filePath);
      switch (args.action) {
        case "add": {
          if (!args.content) return textResult("content required for add", true);
          const id = `todo_${Date.now()}_${++todoSeq}`;
          todos[id] = { content: args.content, completed: false, createdAt: Date.now() };
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Added: ${id}` }], isError: false };
        }
        case "complete":
          if (!args.id || !todos[args.id]) return textResult("todo not found", true);
          todos[args.id]!.completed = true;
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Completed: ${args.id}` }], isError: false };
        case "remove":
          if (!args.id || !todos[args.id]) return textResult("todo not found", true);
          delete todos[args.id];
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Removed: ${args.id}` }], isError: false };
        case "list": {
          const lines = Object.entries(todos).map(([id, t]) => `${t.completed ? "✓" : "○"} ${id}: ${t.content}`);
          return { content: [{ type: "text", text: lines.join("\n") || "(no todos)" }], isError: false };
        }
      }
    },
  };
}

export function createThinkTool(_root: string): ToolDefinition<{ thought: string }> {
  return {
    name: "think",
    description: "Scratchpad for reasoning (never enters conversation history)",
    inputSchema: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args): Promise<ToolResult> {
      return { content: [{ type: "text", text: `Thought recorded: ${args.thought}` }], isError: false };
    },
  };
}

export function createUserPromptTool(_root: string): ToolDefinition<{ prompt: string }> {
  return {
    name: "user-prompt",
    description: "Ask the human a question mid-run",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.requestApproval) return textResult("No approval handler available for user prompt", true);
      const answer = await ctx.requestApproval(args.prompt, { toolName: "user-prompt", origin: "model" });
      return { content: [{ type: "text", text: `User answered: ${answer}` }], isError: false };
    },
  };
}