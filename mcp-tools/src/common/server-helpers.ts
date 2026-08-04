import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createServer(name: string, version = "0.1.0"): McpServer {
  return new McpServer({ name, version });
}

/**
 * Connect a server over stdio and keep the process alive.
 *
 * IMPORTANT: stdout is the MCP protocol stream over stdio -- never `console.log` anywhere in a
 * server process. All diagnostic/startup logging here goes to stderr instead.
 */
export async function runStdioServer(server: McpServer, label: string): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${label}] MCP server ready on stdio`);
}
