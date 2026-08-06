#!/usr/bin/env node
/**
 * The environmental watchdog as a long-lived process.
 *
 *   node dist/alert-skill/watch-loop.js      ->  a tick every 15s, pages on its own
 *
 * ## Why this exists rather than a faster cron schedule
 *
 * Hermes cron cannot go faster than roughly two minutes, and not for a reason
 * any config can reach:
 *
 *   - `parse_duration` has no seconds unit (`{m:1, h:60, d:1440}`), so "every
 *     15s" does not parse and intervals are whole minutes.
 *   - the ticker thread polls on a fixed 60s grid.
 *   - `mark_job_run` computes `next_run_at` from the job's COMPLETION time, so a
 *     tick taking 0.3s lands its due time 0.3s past the next poll, misses it,
 *     and fires a minute later.
 *
 * Measured over 547 executions on this rig: gaps of 120s x415 while configured
 * `every 1m`, and 360s x113 while configured `every 5m`. Every interval is
 * really N+1 minutes, and it jitters when tick duration varies.
 *
 * Measured end to end, sensor edge -> Telegram: 14.2s on a lucky press, 102.2s
 * on an unlucky one, of which the wait for the next tick was 7.5s and 88.1s.
 * The wait was ~86% of the worst case. This loop removes it.
 *
 * ## Why 15 seconds and not faster
 *
 * The board writes every ~10s and the push lands every ~10s; measured transport
 * was 6.8s and 14.1s. Below about 15s there is nothing new to read, and each
 * extra tick is another chance to catch the sensor log mid-replace. 5s is the
 * floor this accepts, and even that is generous.
 *
 * ## One writer per file
 *
 * This process and `hermes cron` both persist environmental-watch.json. RUN ONLY
 * ONE. Two writers means the on-call gets every page twice and the cooldowns
 * race; scripts/install-autostart.ps1 refuses to install this while the cron job
 * is enabled.
 *
 * Environment:
 *   WATCH_INTERVAL_MS   tick cadence (default 15000, floor 5000)
 *   WATCH_HEALTH_PORT   loopback health/mutex port (default 7789, 0 disables)
 *   TELEGRAM_BOT_TOKEN  \ both required to deliver. Without them the loop still
 *   TELEGRAM_CHAT_ID    / ticks, persists state and logs -- it just cannot page.
 *   ALERT_STATE_PATH, ACCESS_STATE_PATH, UNOQ_SENSOR_LOG -- as check-environmental.
 */
import { createServer, type Server } from "node:http";
import { applySensorLogDefault, runWatchTick } from "./tick.js";
import { sendTelegramMessage, telegramCredentials } from "../common/telegram.js";
import { envNumber, envPositive } from "../common/env.js";

applySensorLogDefault();

/** Below this the board simply has not produced anything new. See the header. */
const MIN_INTERVAL_MS = 5000;
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_HEALTH_PORT = 7789;

const INTERVAL_MS = Math.max(MIN_INTERVAL_MS, envPositive("WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
// envNumber, not envPositive: 0 is a documented value here ("no health server"),
// so it has to survive. What must NOT survive is a typo -- `Number("790O")` is
// NaN, which would fall through the same guard and silently disable the
// single-instance mutex along with the health endpoint.
const HEALTH_PORT = envNumber("WATCH_HEALTH_PORT", DEFAULT_HEALTH_PORT);

interface Health {
  startedAt: string;
  ticks: number;
  skipped: number;
  failures: number;
  delivered: number;
  undelivered: number;
  lastTickAt?: string;
  lastStatus?: string;
  lastSource?: string;
  lastError?: string;
  lastDeliveryError?: string;
  lastMessageAt?: string;
}

const health: Health = {
  startedAt: new Date().toISOString(),
  ticks: 0,
  skipped: 0,
  failures: 0,
  delivered: 0,
  undelivered: 0,
};

const credentials = telegramCredentials();

/**
 * Single instance, enforced by the OS.
 *
 * Same reasoning as the mutex in uno-q/pull_sensor_log.ps1, by a different
 * mechanism: a bound port is released by the kernel when the process dies, so
 * unlike a pidfile it cannot go stale and lock out the next start after a crash
 * -- which on a demo rig would be a watchdog that is silently not running.
 *
 * It doubles as the only way to see that this process is alive, since it has no
 * console once Task Scheduler owns it.
 */
function startHealthServer(): Promise<Server | undefined> {
  if (!Number.isFinite(HEALTH_PORT) || HEALTH_PORT <= 0) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...health, intervalMs: INTERVAL_MS, canDeliver: credentials !== undefined }, null, 2));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[watch-loop] port ${HEALTH_PORT} is already bound -- another watch-loop is running. Exiting.\n` +
            "            Two watchdogs mean the on-call gets every page twice.",
        );
        process.exit(1);
      }
      reject(err);
    });

    server.listen(HEALTH_PORT, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Deliver one line. Never throws: a failed send is recorded and the loop
 * continues, because the alternative is a watchdog that dies the first time the
 * venue WiFi drops -- which is precisely when it is needed.
 */
async function deliver(text: string): Promise<void> {
  if (!credentials) {
    health.undelivered++;
    console.warn(`[watch-loop] NOT DELIVERED (no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID): ${text}`);
    return;
  }
  try {
    await sendTelegramMessage(credentials, text);
    health.delivered++;
    health.lastMessageAt = new Date().toISOString();
    delete health.lastDeliveryError;
    console.log(`[watch-loop] delivered: ${text}`);
  } catch (err) {
    health.undelivered++;
    health.lastDeliveryError = err instanceof Error ? err.message : String(err);
    console.error(`[watch-loop] delivery failed (${health.lastDeliveryError}): ${text}`);
  }
}

/**
 * True while a tick is in flight.
 *
 * Ticks are skipped, never queued. A tick that overran the interval means the
 * disk or the network is slow; stacking a backlog behind it would turn one slow
 * tick into a thundering herd against the same locked file, and every queued
 * tick would deliver a decision made from stale state anyway.
 */
let running = false;

async function tick(): Promise<void> {
  if (running) {
    health.skipped++;
    return;
  }
  running = true;
  try {
    const result = await runWatchTick();
    health.ticks++;
    health.lastTickAt = new Date().toISOString();
    health.lastStatus = result.reading.status;
    health.lastSource = result.reading.source;
    delete health.lastError;

    // Delivered in order and awaited one at a time: two pages arriving out of
    // order on the phone would misrepresent the sequence of events, and the
    // whole panel is built on the thread being an accurate record.
    for (const part of result.parts) await deliver(part);
  } catch (err) {
    health.failures++;
    health.lastError = err instanceof Error ? err.message : String(err);
    // Logged and swallowed. A watchdog that exits on an unexpected error is a
    // watchdog that is not watching; Task Scheduler would restart it, but only
    // after a gap nobody would be told about.
    console.error("[watch-loop] tick failed (continuing):", err);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  const server = await startHealthServer();

  console.log(
    `[watch-loop] started: every ${INTERVAL_MS}ms, ` +
      `delivery ${credentials ? "enabled" : "DISABLED (no bot token/chat id)"}` +
      (server ? `, health on http://127.0.0.1:${HEALTH_PORT}/health` : ""),
  );

  // Run one immediately: a restart mid-incident should not wait a full interval
  // before noticing what it already missed.
  await tick();

  const timer = setInterval(() => void tick(), INTERVAL_MS);

  const shutdown = (signal: string): void => {
    console.log(`[watch-loop] ${signal} -- stopping`);
    clearInterval(timer);
    server?.close();
    // Let an in-flight tick finish writing state rather than tearing it up
    // mid-write; the state file is atomic now, but the rule state is a separate
    // write and a half-applied pair is still a bad way to go out.
    const wait = setInterval(() => {
      if (!running) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 50);
    // Backstop: never hang forever on a wedged tick.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[watch-loop] fatal:", err);
  process.exit(1);
});
