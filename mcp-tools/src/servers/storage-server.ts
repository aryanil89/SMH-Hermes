import { z } from "zod";
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { generateStorageReport } from "../mock/storage.js";

const server = createServer("smh-hermes-storage");

server.registerTool(
  "get_storage_status",
  {
    title: "Get storage status",
    description:
      "Check storage volume health: capacity used (%) and failure risk score (0-100, higher is worse). Data is mocked but changes between calls. Call with no arguments to check all volumes, or set 'volume' to a specific volume id, e.g. 'vol-01'.",
    inputSchema: {
      volume: z.string().optional().describe("Optional volume id to check, e.g. 'vol-01'."),
    },
  },
  async ({ volume }) => {
    const report = generateStorageReport({ volume });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    };
  },
);

runStdioServer(server, "storage").catch((err: unknown) => {
  console.error("[storage] fatal:", err);
  process.exit(1);
});
