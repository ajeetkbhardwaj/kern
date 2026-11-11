# Plan: Tools Framework for Kern (TypeScript Adaptation)

## Overview
Adapt docker-agents' tools framework (Chapter 6) as kern's tool management system. Provides type-safe handlers, tool catalog/search, deferred loading, and 30+ built-in toolsets ready for use.

## TypeScript Adaptation Goals

### 1. Core Tool Contract (analogue to `pkg/tools/tools.go`)
Define the tool type that everything builds on:

```typescript
// Tool struct analogue
export interface Tool {
  // What the model sees
  name: string;
  category: string;
  description: string;
  
  // JSON Schema for arguments; OutputSchema for structured results
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  
  // MCP-style hints that feed directly into permission/safety classification
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    // Additional annotations for policy classification
  };
  
  // Execution function
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
  
  // Allow repeated calls opt-out
  allowRepeatedCalls?: boolean;
  
  // Deferred loading: tool stays out of prompt until discovered via catalog
  deferred?: boolean;
  searchOnly?: boolean;
  
  // Per-tool cheaper model (e.g., summarize outputs)
  modelOverride?: string;
  
  // Category for grouping in TUI/catalog
  category?: string;
}
```

### 2. Type-Safe Handlers (signature feature)
```typescript
// analogue to: func readTool[Args any](name, desc string, h func(ctx, *Args) (*tools.ToolCallResult, error)) tools.Tool
export function readTool<Args extends object>(
  name: string,
  description: string,
  handler: (ctx: ToolContext, args: Args) => Promise<ToolResult>
): Tool {
  return { name, description, inputSchema: { type: "object", properties: {}, required: [] }, execute: handler };
}
```

**NewHandler[T]** / **RuntimeHandler[T]** unmarshal args with strict JSON first, then narrow shape repairs:
- Stringified arrays, bare scalars where objects expected
- Every repair emits `tool_input_repaired` telemetry event keyed by (model, tool)
- Tracks which models break which tools instead of silently swallowing quirks

### 3. Tool Catalog & Search (analogue to `catalog.go`, `deferrals.go`)
- **Catalog**: Searchable index of all available tools
- **Deferrals**: Tool-search catalog & deferred materialization - tool stays out of prompt until discovered
- **Token economy**: Deferred loading saves token economy (Ch. 13 code-mode synergy)
- **Native tool-search catalog**: Search tools by name/description/query

### 4. Built-in Toolsets (30+ ready-to-use)
| Toolset | What it gives agents |
|---------|---------------------|
| `read` | Read file contents or directory listing |
| `write` | Create or overwrite a file |
| `edit` | Replace exact text in a file |
| `bash` | Execute a shell command in the workspace |
| `glob` | Search for files by pattern |
| `grep` | Search file contents |
| `ls-class` | List class definitions in TypeScript/JavaScript |
| `calculate` | Safe math evaluation |
| `time` | Current time/timezone |
| `git-status` | Git status |
| `git-diff` | Git diff |
| `git-log` | Git log |
| `git-checkout` | Git checkout |
| `mkdir` | Make directory |
| `rm` | Remove file (with safety checks) |
| `cat` | Read file content (simplified) |
| `head` | Read first N lines |
| `tail` | Read last N lines |
| `which` | Find command location |
| `type-check` | Run type checker on code |
| `test` | Run tests |
| `serve` | Start development server |
| `format` | Format code |
| `import` | Import modules |
| `export` | Export modules |
| `type-define` | Type definitions |
| `rename` | Rename symbol |
| `find-references` | Find symbol references |
| `debugger` | Attach debugger |
| `profiler` | Run profiler |
| `memory` | Persistent key-value memory |
| `model-picker` | Let model pick among configured models |
| `plan`, `todo` | Planning sidebars & task lists |
| `think` | Scratchpad reasoning that never enters conversation history |
| `user-prompt` | Ask the human a question mid-run |

Each toolset has standardized:
- `inputSchema` (JSON Schema for arguments)
- `annotations` (readOnlyHint, destructiveHint for automatic policy classification)
- `description` (what the model sees)
- `execute` function (implementation)

### 5. Extension Points
- **Adding custom toolset in TypeScript**: Implement `Tool` interface and register in ToolRegistry
- **Config-only users**: Get new capabilities through MCP servers (treats builtin and MCP tools identically after collection)
- **MCP integration**: Built-in and MCP tools collected identically into single tool registry

### 6. Supporting Machinery
- `graph.go` analogues: relationships between tools (dependency/affinity edges)
- `catalog.go`, `deferrals.go` - tool-search catalog & deferred materialization
- `elicitation.go` - a tool can pause and ask the user mid-call (round-trips as `ElicitationRequestEvent`)
- `toon/` - compact serialization format for tool payloads
- `testutil/` - test doubles for tool testing
- `fakemcp/` - MCP test doubles

### 7. Integration with Kern Policy & Safety
- **Annotations drive classification**: `readOnlyHint` → `safe` classifier, `destructiveHint` → `destructive` classifier
- **Tool input transform**: Hooks pipeline can rewrite tool input before guards
- **Policy evaluation**: Tool sideEffect (read/write/execute) feeds into DefaultPolicy
- **Safety modes**: Annotations + safety mode determine allow/deny/ask decision

## Implementation Priority
**HIGH** - Provides 30+ ready toolsets and standardized framework for tool management.

## Files to Create/Modify
- `src/tools/registry.ts` - ToolRegistry with standardized methods
- `src/tools/builtin/` - Directory for built-in tool implementations (read.ts, write.ts, edit.ts, bash.ts, etc.)
- `src/tools/types.ts` - Tool interface, ToolResult, JsonSchema types
- `src/hooks/` - Integrate hooks with tool execution (input_transform, post_tool_use, etc.)
- `src/policy.ts` - Integrate tool annotations into policy evaluation
- `docs/tools/` - Documentation for each built-in tool with YAML examples

## Reference from docker-agents
- Chapter 6: Tools Framework & Built-in Toolsets
- `pkg/tools/tools.go`, `pkg/tools/builtin/` (32 dirs)
- Type-safe handlers with github.com/docker/aijson
- 32+ builtin toolsets with doc pages under `docs/tools/NN-name.md`
- Extension point: implement `ToolSet` or `StartableToolSet`
- `codemode/` - JS orchestration wrapper for tool payload serialization
- `testutil/`, `fakemcp/` - test doubles
- Tool catalog, deferrals, elicitation, codemode serialization