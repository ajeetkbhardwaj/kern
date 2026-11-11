import { ToolDefinition, ToolResult } from "@kern/protocol";
import { textResult } from "@kern/protocol";

export function createMemoryTool(root: string): ToolDefinition<{ action: "get" | "set" | "delete" | "list"; key?: string; value?: string }> {
  const store = new Map<string, string>();
  return {
    name: "memory",
    description: "Persistent key-value memory across sessions",
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
    async execute(args, ctx) {
      switch (args.action) {
        case "get":
          if (!args.key) return textResult("key required for get", true);
          return { content: [{ type: "text", text: store.get(args.key) ?? "(not found)" }], isError: false };
        case "set":
          if (!args.key || args.value === undefined) return textResult("key and value required for set", true);
          store.set(args.key, args.value);
          return { content: [{ type: "text", text: `Set ${args.key} = ${args.value}` }], isError: false };
        case "delete":
          if (!args.key) return textResult("key required for delete", true);
          store.delete(args.key);
          return { content: [{ type: "text", text: `Deleted ${args.key}` }], isError: false };
        case "list":
          const entries = [...store.entries()].map(([k, v]) => `${k}=${v}`).join("\n") || "(empty)";
          return { content: [{ type: "text", text: entries }], isError: false };
      }
    },
  };
}

export function createModelPickerTool(root: string): ToolDefinition<{ task?: string }> {
  return {
    name: "model-picker",
    description: "Let the model pick the best configured model for a task",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "Description of the task" } } },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx) {
      return { content: [{ type: "text", text: `Model selection for: ${args.task ?? "general task"}\n(Use --model or /model to change manually)` }], isError: false };
    },
  };
}

export function createPlanTool(root: string): ToolDefinition<{ action: "add" | "update" | "complete" | "remove" | "list"; id?: string; title?: string; content?: string }> {
  const plans = new Map<string, { title: string; content: string; completed: boolean; createdAt: number }>();
  return {
    name: "plan",
    description: "Manage structured plans and task lists",
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
    async execute(args, ctx) {
      switch (args.action) {
        case "add":
          if (!args.id || !args.title) return textResult("id and title required for add", true);
          plans.set(args.id, { title: args.title, content: args.content ?? "", completed: false, createdAt: Date.now() });
          return { content: [{ type: "text", text: `Added plan: ${args.id}` }], isError: false };
        case "update":
          if (!args.id || !plans.has(args.id)) return textResult("plan not found", true);
          const p = plans.get(args.id)!;
          if (args.title) p.title = args.title;
          if (args.content) p.content = args.content;
          plans.set(args.id, p);
          return { content: [{ type: "text", text: `Updated plan: ${args.id}` }], isError: false };
        case "complete":
          if (!args.id || !plans.has(args.id)) return textResult("plan not found", true);
          plans.get(args.id)!.completed = true;
          return { content: [{ type: "text", text: `Completed: ${args.id}` }], isError: false };
        case "remove":
          if (!args.id || !plans.has(args.id)) return textResult("plan not found", true);
          plans.delete(args.id);
          return { content: [{ type: "text", text: `Removed: ${args.id}` }], isError: false };
        case "list":
          const lines = [...plans.entries()].map(([id, p]) => `${p.completed ? "✓" : "○"} ${id}: ${p.title}${p.content ? ` - ${p.content}` : ""}`);
          return { content: [{ type: "text", text: lines.join("\n") || "(no plans)" }], isError: false };
      }
    },
  };
}

export function createTodoTool(root: string): ToolDefinition<{ action: "add" | "complete" | "remove" | "list"; id?: string; content?: string }> {
  const todos = new Map<string, { content: string; completed: boolean; createdAt: number }>();
  return {
    name: "todo",
    description: "Manage simple todo lists",
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
    async execute(args, ctx) {
      switch (args.action) {
        case "add":
          if (!args.content) return textResult("content required for add", true);
          const id = `todo_${Date.now()}`;
          todos.set(id, { content: args.content, completed: false, createdAt: Date.now() });
          return { content: [{ type: "text", text: `Added: ${id}` }], isError: false };
        case "complete":
          if (!args.id || !todos.has(args.id)) return textResult("todo not found", true);
          todos.get(args.id)!.completed = true;
          return { content: [{ type: "text", text: `Completed: ${args.id}` }], isError: false };
        case "remove":
          if (!args.id || !todos.has(args.id)) return textResult("todo not found", true);
          todos.delete(args.id);
          return { content: [{ type: "text", text: `Removed: ${args.id}` }], isError: false };
        case "list":
          const lines = [...todos.entries()].map(([id, t]) => `${t.completed ? "✓" : "○"} ${id}: ${t.content}`);
          return { content: [{ type: "text", text: lines.join("\n") || "(no todos)" }], isError: false };
      }
    },
  };
}

export function createThinkTool(root: string): ToolDefinition<{ thought: string }> {
  return {
    name: "think",
    description: "Scratchpad for reasoning (never enters conversation history)",
    inputSchema: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx) {
      return { content: [{ type: "text", text: `Thought recorded: ${args.thought}` }], isError: false };
    },
  };
}

export function createUserPromptTool(root: string): ToolDefinition<{ prompt: string }> {
  return {
    name: "user-prompt",
    description: "Ask the human a question mid-run",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx) {
      if (!ctx.requestApproval) return textResult("No approval handler available for user prompt", true);
      const answer = await ctx.requestApproval(args.prompt, { toolName: "user-prompt", origin: "model" });
      return { content: [{ type: "text", text: `User answered: ${answer}` }], isError: false };
    },
  };
}