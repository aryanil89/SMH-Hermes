#!/usr/bin/env node
/**
 * Local test surface for the rule engine -- everything the Telegram agent can
 * do, without Telegram in the way.
 *
 *   node dist/rules/cli.js baselines
 *   node dist/rules/cli.js list
 *   node dist/rules/cli.js validate '{"kind":"level","channel":"temperature_c","op":"<","value":-100}'
 *   node dist/rules/cli.js add      '{"kind":"event","channel":"door","match":"door_open","windowSeconds":86400,"note":"..."}'
 *   node dist/rules/cli.js check
 *   node dist/rules/cli.js cancel r1
 *   node dist/rules/cli.js resume sys-leak
 *
 * `check` is the same call the cron watchdog makes, so what it prints is
 * exactly what would arrive on the phone. It NEVER writes state: persisting
 * here would advance watermarks and set `fired` latches for alerts printed to a
 * terminal with no phone attached, eating the message the next cron tick was
 * about to send. `--commit` rehearses state transitions and is refused unless
 * ALERT_RULE_STATE_PATH points somewhere other than the live store.
 */
import {
  buildPredicate,
  cancelRule,
  createRule,
  listRules,
  resumeRule,
  type CreateRuleInput,
} from "./manage.js";
import { currentBaselines, currentReadings, runRuleTick } from "./runner.js";
import { validateRule } from "./validate.js";

function parseArg(raw: string | undefined): CreateRuleInput {
  if (!raw) throw new Error("expected a JSON rule argument");
  return JSON.parse(raw) as CreateRuleInput;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "baselines": {
      const b = await currentBaselines();
      process.stdout.write(JSON.stringify(b, null, 2) + "\n");
      return 0;
    }

    case "list": {
      const rules = await listRules();
      if (rules.length === 0) {
        process.stdout.write("no rules\n");
        return 0;
      }
      for (const r of rules) {
        const state = r.enabled ? "on " : "MUTED";
        const exp = r.expiresAt ? ` expires ${r.expiresAt}` : "";
        process.stdout.write(
          `${state} ${r.id.padEnd(20)} ${r.description.padEnd(38)} fired=${r.fireCount}${exp}\n`,
        );
      }
      return 0;
    }

    case "validate": {
      const input = parseArg(rest[0]);
      const built = buildPredicate(input);
      if ("error" in built) {
        process.stdout.write(`REJECT: ${built.error}\n`);
        return 0;
      }
      const result = validateRule({
        predicate: built,
        baselines: await currentBaselines(),
        current: await currentReadings(),
        ...(input.windowSeconds != null ? { windowSeconds: input.windowSeconds } : {}),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    case "add": {
      const result = await createRule(parseArg(rest[0]));
      process.stdout.write(result.message + "\n");
      return result.created ? 0 : 1;
    }

    case "cancel": {
      const id = rest[0];
      if (!id) throw new Error("expected a rule id");
      const result = await cancelRule(id);
      process.stdout.write(result.message + "\n");
      return result.ok ? 0 : 1;
    }

    case "resume": {
      const id = rest[0];
      if (!id) throw new Error("expected a rule id");
      const result = await resumeRule(id);
      process.stdout.write(result.message + "\n");
      return result.ok ? 0 : 1;
    }

    case "check": {
      // Dry-run unless explicitly committing, and committing is refused against
      // the live store. The only legitimate consumer of a tick is
      // check-environmental.js, whose output Hermes actually delivers; a commit
      // here would advance watermarks and set `fired` latches for alerts then
      // printed to a terminal with no phone attached. Requiring an explicit
      // ALERT_RULE_STATE_PATH makes "scratch logs only" a property rather than
      // a comment someone has to read.
      const commit = rest.includes("--commit");
      if (commit && !process.env["ALERT_RULE_STATE_PATH"]) {
        process.stderr.write(
          "refusing --commit against the live rule state: set ALERT_RULE_STATE_PATH " +
            "(and usually UNOQ_SENSOR_LOG / ALERT_RULES_PATH) to a scratch location first.\n",
        );
        return 2;
      }
      const tick = await runRuleTick({ dryRun: !commit });
      if (tick.logError) {
        process.stdout.write(`log error: ${tick.logError}\n`);
      }
      process.stdout.write(
        `read ${tick.linesRead} lines, ${tick.rules.filter((r) => r.enabled).length} active rules` +
          `${commit ? " (state WRITTEN)" : " (dry run, state not written)"}\n`,
      );
      if (tick.firings.length === 0) {
        process.stdout.write("NO_ALERT\n");
      } else {
        process.stdout.write("--- would send to Telegram ---\n");
        for (const f of tick.firings) process.stdout.write(`[${f.ruleId}] ${f.text}\n`);
      }
      return 0;
    }

    default:
      process.stderr.write(
        "usage: cli.js <baselines|list|validate|add|cancel|resume|check> [args]\n",
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[rules-cli]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
