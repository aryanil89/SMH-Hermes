/**
 * MCP server for conversational alert rules -- the Telegram-facing half.
 *
 * These tools run at authoring time only. They are the *only* place the model
 * is involved: it turns "tell me if the door opens today" into one
 * create_alert_rule call, then reads back the validator's findings in its own
 * words. Nothing here runs on a cron tick.
 *
 * Tool descriptions carry the channel vocabulary inline so the model doesn't
 * need a second round trip to discover what can be watched -- each extra tool
 * call costs a full prompt re-prefill on the local model.
 */
import { createServer, runStdioServer } from "../common/server-helpers.js";
import { z } from "zod";
import { cancelRule, createRule, listRules, resumeRule } from "../rules/manage.js";
import { describeChannels } from "../rules/channels.js";
import { currentBaselines } from "../rules/runner.js";

const server = createServer("smh-hermes-rules");

server.registerTool(
  "create_alert_rule",
  {
    title: "Create a proactive alert rule",
    description:
      "Arm a new alert on the datacenter sensors. Use for requests like 'tell me if the temperature goes above 25', " +
      "'alert me every time the door opens for the next 24 hours', or 'let me know if the door is left open 10 minutes'. " +
      `Channels available -- ${describeChannels()}. ` +
      "kind: 'level' (value crosses a threshold now), 'sustained' (stays past a threshold for forSeconds), " +
      "'event' (fires on every occurrence of an event), 'state_duration' (a state is held for forSeconds), " +
      "'stale' (the sensor feed goes silent). Set windowSeconds when the user gave a time limit " +
      "(24 hours = 86400); omit it for 'until I cancel'. " +
      "The rule is validated against the sensor's physical range and against this room's observed history: " +
      "an impossible request (e.g. temperature below -100C) is REJECTED and the reply explains why. " +
      "Report the returned message to the user, including any warnings, without contradicting it.",
    inputSchema: {
      kind: z.enum(["level", "sustained", "event", "state_duration", "stale"]),
      channel: z
        .string()
        .optional()
        .describe("temperature_c | humidity_pct | distance_mm | door | light | leak | presence"),
      op: z.enum([">", ">=", "<", "<="]).optional().describe("required for level and sustained"),
      value: z.number().optional().describe("threshold, required for level and sustained"),
      match: z
        .string()
        .optional()
        .describe("event name, required for event and state_duration (e.g. door_open)"),
      forSeconds: z
        .number()
        .optional()
        .describe("how long the condition must hold, for sustained / state_duration / stale"),
      windowSeconds: z
        .number()
        .nullable()
        .optional()
        .describe("how long the rule stays armed; null or omitted = until cancelled"),
      note: z.string().optional().describe("the user's own words, echoed back later"),
      chatId: z.string().optional(),
    },
  },
  async (args) => {
    const result = await createRule(args);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              created: result.created,
              message: result.message,
              findings: result.findings,
              facts: result.facts,
              rule: result.rule,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "list_alert_rules",
  {
    title: "List alert rules",
    description:
      "List every armed alert rule, built-in and user-created, with how many times each has fired and when it expires. " +
      "Rules whose id starts with 'sys-' are built-in safety alerts that are always on unless muted.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await listRules(), null, 2) }],
  }),
);

server.registerTool(
  "cancel_alert_rule",
  {
    title: "Cancel or mute an alert rule",
    description:
      "Cancel a rule by id. User-created rules are deleted. Built-in 'sys-' rules are muted rather than deleted, " +
      "so they can be restored later with resume_alert_rule -- tell the user that when you mute one.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => ({
    content: [{ type: "text" as const, text: (await cancelRule(id)).message }],
  }),
);

server.registerTool(
  "resume_alert_rule",
  {
    title: "Resume a muted alert rule",
    description: "Turn a previously muted rule back on, by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => ({
    content: [{ type: "text" as const, text: (await resumeRule(id)).message }],
  }),
);

server.registerTool(
  "get_sensor_baselines",
  {
    title: "What the system has learned about this room",
    description:
      "Observed min/max/mean/stddev for each numeric sensor channel and the events-per-hour rate for each event, " +
      "computed from the whole sensor log. Use it to answer 'what is normal here?' and to explain why a proposed " +
      "alert rule is or isn't likely to fire. Takes no arguments.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await currentBaselines(), null, 2) }],
  }),
);

runStdioServer(server, "rules").catch((err: unknown) => {
  console.error("[rules] fatal:", err);
  process.exit(1);
});
