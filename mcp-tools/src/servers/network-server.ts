import { z } from "zod";
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { generateNetworkReport } from "../mock/network.js";

const server = createServer("smh-hermes-network");

server.registerTool(
  "get_network_status",
  {
    title: "Get network status",
    description:
      "Check network link health between datacenter racks and zones: latency (ms), packet loss (%), and whether each link is connected. Data is mocked but changes between calls. Call with no arguments to check all links, or set 'zone' to filter to links touching one rack/zone name, e.g. 'zone-east'.",
    inputSchema: {
      zone: z
        .string()
        .optional()
        .describe("Optional rack or zone name to filter links by, e.g. 'zone-east' or 'rack-a1'."),
    },
  },
  async ({ zone }) => {
    const report = generateNetworkReport({ zone });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    };
  },
);

runStdioServer(server, "network").catch((err: unknown) => {
  console.error("[network] fatal:", err);
  process.exit(1);
});
