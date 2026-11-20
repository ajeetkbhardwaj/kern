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

interface TodoRecord {
  content: string;
  status: "pending" | "in_progress" | "done";
  createdAt: number;
}

let todoSeq = 0;

export function createTodoTool(_root: string): ToolDefinition<{
  action: "add" | "update" | "complete" | "remove" | "list" | "clear";
  id?: string;
  content?: string;
  status?: "pending" | "in_progress" | "done";
}> {
  return {
    name: "todo",
    description: "Manage a lightweight task checklist for multi-step work (persisted in .kern/todos.json)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "complete", "remove", "list", "clear"] },
        id: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "done"] },
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
          if (!args.content) return textResult("content required for add", true, { code: "E_TOOL_INVALID_ARGS" });
          const id = args.id || `todo_${Date.now()}_${++todoSeq}`;
          todos[id] = { content: args.content, status: args.status ?? "pending", createdAt: Date.now() };
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Added: ${id}` }], isError: false, details: { id, todos } };
        }
        case "update": {
          if (!args.id || !todos[args.id]) return textResult("todo not found", true, { code: "E_TOOL_FAILED" });
          if (args.content !== undefined) todos[args.id]!.content = args.content;
          if (args.status !== undefined) todos[args.id]!.status = args.status;
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Updated: ${args.id}` }], isError: false, details: { id: args.id, todos } };
        }
        case "complete": {
          if (!args.id || !todos[args.id]) return textResult("todo not found", true, { code: "E_TOOL_FAILED" });
          todos[args.id]!.status = "done";
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Completed: ${args.id}` }], isError: false, details: { id: args.id, todos } };
        }
        case "remove": {
          if (!args.id || !todos[args.id]) return textResult("todo not found", true, { code: "E_TOOL_FAILED" });
          delete todos[args.id];
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", todos);
          return { content: [{ type: "text", text: `Removed: ${args.id}` }], isError: false, details: { id: args.id, todos } };
        }
        case "clear": {
          await saveJsonRecord(ctx.workspaceRoot, "todos.json", {});
          return { content: [{ type: "text", text: "Cleared all todos" }], isError: false, details: { todos: {} } };
        }
        case "list": {
          const lines = Object.entries(todos).map(([id, t]) => {
            const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "◐" : "○";
            return `${mark} ${id}: ${t.content}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") || "(no todos)" }], isError: false, details: { todos } };
        }
      }
    },
  };
}

export function createAskUserTool(): ToolDefinition<{
  question: string;
  options?: string[];
  allowCustom?: boolean;
}> {
  return {
    name: "ask-user",
    description: "Ask the user a clarifying question mid-turn and wait for their answer (interactive TTY/TUI only)",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Clear, concise question for the user" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of choices to present to the user",
        },
        allowCustom: {
          type: "boolean",
          default: true,
          description: "When options are provided, also let the user type a custom response",
        },
      },
      required: ["question"],
    },
    sideEffect: "read",
    annotations: { readOnlyHint: true },
    async execute(args, ctx): Promise<ToolResult> {
      const q = args.question.trim();
      if (!q) return textResult("question must be non-empty", true, { code: "E_TOOL_INVALID_ARGS" });
      if (!ctx.askUser) {
        return textResult("Interactive user input is unavailable in headless/non-TTY mode.", true, {
          code: "E_TOOL_DENIED",
          reason: "no_ask_user_handler",
        });
      }
      if (ctx.signal.aborted) {
        return textResult("ask-user aborted", true, { code: "E_CANCELLED" });
      }
      try {
        const answer = await ctx.askUser({
          question: q,
          ...(args.options && args.options.length > 0 ? { options: args.options } : {}),
          ...(args.allowCustom !== undefined ? { allowCustom: args.allowCustom } : {}),
        });
        if (answer === null) {
          return {
            content: [{ type: "text", text: "User cancelled the prompt without answering." }],
            isError: false,
            details: { cancelled: true },
          };
        }
        return {
          content: [{ type: "text", text: `User answered: ${answer}` }],
          isError: false,
          details: { answer },
        };
      } catch (error) {
        return textResult(`ask-user failed: ${error instanceof Error ? error.message : String(error)}`, true, {
          code: "E_TOOL_FAILED",
        });
      }
    },
  };
}