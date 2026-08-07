import { z } from "zod";
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { generateComputeReport } from "../mock/compute.js";
import { readHostComputeNode } from "../real/host-compute.js";
import { worstStatus } from "../common/alerts.js";

const server = createServer("smh-hermes-compute");

server.registerTool(
  "get_compute_status",
  {
    title: "Get server/compute status",
    description:
      "Check compute node health: CPU (%), memory (%), uptime (seconds), and service state " +
      "(running/degraded/down). Every node carries a 'source' field: 'host-01' is REAL telemetry " +
      "read from the machine this agent runs on (a Snapdragon X Elite Copilot+ PC), the rest are " +
      "simulated rack nodes. Say which is which if you report specific numbers. Call with no " +
      "arguments to check all nodes, or set 'node' to a specific node id, e.g. 'node-03' or " +
      "'host-01'.",
    inputSchema: {
      node: z.string().optional().describe("Optional node id to check, e.g. 'node-03'."),
    },
  },
  async ({ node }) => {
    const report = generateComputeReport({ node });

    // The real node is fetched only when it would actually be returned, so
    // asking about one simulated node does not pay the CPU sampling interval.
    // Undefined (unsupported platform, unreadable counters) simply means the
    // report is all-simulated, exactly as it was before this existed -- the
    // fallback is the absence of a row, never a fabricated one.
    const wantsHost = !node || node === "host-01";
    const host = wantsHost ? await readHostComputeNode() : undefined;
    if (host) {
      report.nodes.unshift(host);
      report.overallStatus = worstStatus(...report.nodes.map((n) => n.status));
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    };
  },
);

runStdioServer(server, "compute").catch((err: unknown) => {
  console.error("[compute] fatal:", err);
  process.exit(1);
});
