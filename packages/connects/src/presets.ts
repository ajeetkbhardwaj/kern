import type { ConnectorPreset } from "./types.js";

/**
 * Curated presets for common MCP connectors (Claude Code / Codex / Perplexity style).
 * Users can connect any of these via CLI, TUI (/mcp), or Web UI, or define custom stdio/HTTP servers.
 */
export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: "context7",
    name: "Context7 Docs",
    description: "Up-to-date library and framework documentation search (remote HTTP)",
    transport: "http",
    entry: {
      type: "http",
      url: "https://mcp.context7.com/mcp",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, PRs, code search, and actions",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}",
      },
    },
    variables: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub Personal Access Token",
        required: true,
        secret: true,
        placeholder: "ghp_... or ${GITHUB_PERSONAL_ACCESS_TOKEN}",
        target: "env",
      },
    ],
  },
  {
    id: "playwright",
    name: "Playwright Browser",
    description: "Headless/headed browser automation, screenshots, and DOM inspection",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    },
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Scoped filesystem access via official MCP server",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  },
  {
    id: "fetch",
    name: "MCP Fetch",
    description: "Web page fetching and markdown conversion via mcp-server-fetch",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
    },
  },
  {
    id: "memory",
    name: "Knowledge Graph Memory",
    description: "Persistent entity/relation graph memory server",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read-only schema inspection and SQL query execution",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"],
    },
    variables: [
      {
        key: "DATABASE_URL",
        label: "PostgreSQL Connection URL",
        required: true,
        secret: true,
        placeholder: "postgresql://user:pass@localhost:5432/db",
        target: "arg",
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Linear issues, projects, and cycles (remote HTTP)",
    transport: "http",
    entry: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {
        Authorization: "Bearer ${LINEAR_API_KEY}",
      },
    },
    variables: [
      {
        key: "LINEAR_API_KEY",
        label: "Linear API Key (or OAuth Bearer token)",
        required: false,
        secret: true,
        placeholder: "lin_api_...",
        target: "header",
        headerName: "Authorization",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search and read/write Notion pages and databases (remote HTTP)",
    transport: "http",
    entry: {
      type: "http",
      url: "https://mcp.notion.com/mcp",
    },
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Structured multi-step problem decomposition tool",
    transport: "stdio",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
];

export function findConnectorPreset(id: string): ConnectorPreset | undefined {
  return CONNECTOR_PRESETS.find((p) => p.id === id.toLowerCase());
}
