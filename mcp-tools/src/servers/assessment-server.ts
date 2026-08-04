import { z } from "zod";
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { assessIncident } from "../assess/assess.js";

/**
 * The incident-triage tool: ONE call returns the whole verdict.
 *
 * This is a latency decision, not a style one. Each agent iteration on the NPU
 * re-prefills the entire prompt (2-4 minutes), so an answer that needs four
 * status calls costs ten minutes of demo time. Everything quantitative is
 * computed here in microseconds; the model only narrates `summary`.
 */
const server = createServer("smh-hermes-assessment");

server.registerTool(
  "get_incident_assessment",
  {
    title: "Assess current incident risk",
    description:
      "Correlate physical sensor data with storage, network and compute telemetry and return a " +
      "single triage verdict: risk score (0-100 rule-based severity index) and level, an ordinal " +
      "confidence with reasons, the evidence behind both, the likely cause and a recommended " +
      "action. Prefer this over calling the individual status tools: it is one call, the numbers " +
      "are reproducible, and it reports whether any input was simulated. Relay the 'summary' " +
      "field; do not invent numbers.",
    inputSchema: {
      seed: z
        .number()
        .optional()
        .describe("Optional PRNG seed to make a scenario reproducible on stage."),
    },
  },
  async ({ seed }) => {
    const assessment = await assessIncident(seed !== undefined ? { seed } : {});
    return {
      content: [{ type: "text" as const, text: JSON.stringify(assessment, null, 2) }],
    };
  },
);

runStdioServer(server, "assessment").catch((err: unknown) => {
  console.error("[assessment] fatal:", err);
  process.exit(1);
});
