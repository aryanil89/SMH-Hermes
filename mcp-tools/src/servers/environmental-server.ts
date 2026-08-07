import { createServer, runStdioServer } from "../common/server-helpers.js";
import { getEnvironmentalReading } from "../environmental/source.js";

const server = createServer("smh-hermes-environmental");

server.registerTool(
  "get_environmental_status",
  {
    title: "Get environmental sensor status",
    description:
      "Read the datacenter environmental sensor: temperature (Celsius), humidity (%), leak detection (true/false), and water-level distance (distanceMm, from a downward-facing ToF sensor over a drip tray). Data source: the sensor log the Arduino UNO Q board pushes every 10s (UNOQ_SENSOR_LOG env var; the board emits periodic sensor_tick lines plus button events), with realistic mock data as the fallback. leakVia='event' means a leak event (Button C) was logged in the last few minutes; the level-based threshold (UNOQ_LEAK_DISTANCE_MM) is currently inert because sensor_tick lines omit distance. The 'source' field is 'real' or 'mock', and 'fallbackReason' explains why mock data was used, if it was. Takes no arguments.",
    inputSchema: {},
  },
  async () => {
    const reading = await getEnvironmentalReading();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(reading, null, 2) }],
    };
  },
);

runStdioServer(server, "environmental").catch((err: unknown) => {
  console.error("[environmental] fatal:", err);
  process.exit(1);
});
