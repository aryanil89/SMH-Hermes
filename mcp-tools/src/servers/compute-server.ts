import { z } from "zod";
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { generateComputeReport } from "../mock/compute.js";

const server = createServer("smh-hermes-compute");

server.registerTool(
  "get_compute_status",
  {
    title: "Get server/compute status",
    description:
      "Check compute node health: CPU (%), memory (%), uptime (seconds), and service state (running/degraded/down). Data is mocked but changes between calls. Call with no arguments to check all nodes, or set 'node' to a specific node id, e.g. 'node-03'.",
    inputSchema: {
      node: z.string().optional().describe("Optional node id to check, e.g. 'node-03'."),
    },
  },
  async ({ node }) => {
    const report = generateComputeReport({ node });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    };
  },
);

runStdioServer(server, "compute").catch((err: unknown) => {
  console.error("[compute] fatal:", err);
  process.exit(1);
});
