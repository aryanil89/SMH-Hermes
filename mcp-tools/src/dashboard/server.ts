#!/usr/bin/env node
/**
 * Live operations wall for the Hermes demo.
 *
 * Serves a single local page that shows, side by side: the UNO Q environmental
 * device and what it is reporting, the server ingesting that feed alongside the
 * network/storage/compute telemetry and the inference it draws from all of it,
 * and the on-call phone's Telegram thread.
 *
 *   node dist/dashboard/server.js        ->  http://127.0.0.1:7788
 *
 * SCOPE, deliberately: this binds to loopback, has no authentication, and holds
 * no state a restart would miss. It is a demo-table display for the browser on
 * the same machine, not a service. Do not expose it -- `DASHBOARD_HOST=0.0.0.0`
 * exists for a laptop-plus-tablet demo table and nothing else.
 *
 * Environment:
 *   DASHBOARD_PORT       listen port (default 7788)
 *   DASHBOARD_HOST       bind address (default 127.0.0.1)
 *   DASHBOARD_TICK_MS    snapshot cadence (default 2000, floor 250)
 *   UNOQ_SENSOR_LOG      sensor log path (defaults to the repo-root file)
 *   ALERT_STATE_PATH     watchdog state file the phone panel mirrors
 *   TELEGRAM_BOT_LABEL   name shown on the phone panel (default "Hermes Ops")
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotBuilder } from "./snapshot.js";
import { TelegramFeed } from "./telegram-feed.js";
import type { DashboardSnapshot, TelegramMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/dashboard/server.js -> package root is two levels up.
const PACKAGE_ROOT = join(__dirname, "..", "..");
const PUBLIC_DIR = resolve(PACKAGE_ROOT, "public");
const DEFAULT_SENSOR_LOG = join(PACKAGE_ROOT, "..", "arduino_uno_q-sensor_log.json");
const DEFAULT_STATE_PATH = join(PACKAGE_ROOT, ".state", "environmental-watch.json");

// Same defaulting the cron skill does: the dashboard is usually launched from a
// plain shell that never saw the MCP server's env block.
if (!process.env.UNOQ_SENSOR_LOG && existsSync(DEFAULT_SENSOR_LOG)) {
  process.env.UNOQ_SENSOR_LOG = DEFAULT_SENSOR_LOG;
}

const PORT = Number(process.env.DASHBOARD_PORT ?? 7788);
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
// Floored: a sub-250ms cadence buys nothing visually and turns the log tail into
// a busy loop on a machine that is also running NPU inference.
const TICK_MS = Math.max(250, Number(process.env.DASHBOARD_TICK_MS ?? 2000));
const SENSOR_LOG = process.env.UNOQ_SENSOR_LOG ?? DEFAULT_SENSOR_LOG;
const STATE_PATH = process.env.ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
/** Ingest bodies are one chat message; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 16 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const telegram = new TelegramFeed({
  statePath: STATE_PATH,
  botLabel: process.env.TELEGRAM_BOT_LABEL ?? "Hermes Ops",
  chatTitle: process.env.TELEGRAM_CHAT_TITLE ?? "On-call · Telegram",
  ingestUrl: `http://${HOST}:${PORT}/api/telegram`,
});

const builder = new SnapshotBuilder({ sensorLogPath: SENSOR_LOG, telegram, tickMs: TICK_MS });

const clients = new Set<ServerResponse>();
let latest: DashboardSnapshot | undefined;
/** Guards against a slow tick overlapping the next one on a loaded machine. */
let building = false;

async function tick(): Promise<void> {
  if (building) return;
  building = true;
  try {
    latest = await builder.build();
    broadcast(latest);
  } catch (err) {
    console.error("[dashboard] snapshot failed:", err);
  } finally {
    building = false;
  }
}

function broadcast(snapshot: DashboardSnapshot): void {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of clients) {
    // A browser that navigated away can leave a half-closed socket; a failed
    // write must not take the tick loop down with it.
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(PUBLIC_DIR, normalize(relative));
  // Containment check: `normalize` collapses `..`, but a crafted path can still
  // escape the root, and this server reads from disk on an unauthenticated port.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      // The page is a live display; a cached shell against a new snapshot schema
      // is the classic "why is the wall blank" moment.
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function streamSnapshots(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Harmless locally, decisive if anyone ever puts a proxy in front.
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  // Paint immediately rather than making a reconnecting browser wait a tick.
  if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
  req.on("close", () => {
    clients.delete(res);
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ingest a message the real Telegram gateway carried, in either direction:
 *
 *   curl -X POST http://127.0.0.1:7788/api/telegram \
 *        -H 'content-type: application/json' \
 *        -d '{"direction":"inbound","text":"what is the temperature in rack B1?"}'
 *
 * This is the seam for showing genuine phone traffic on the wall. Without it the
 * panel shows only the watchdog path, which is real but is not the whole story.
 */
async function ingestTelegram(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid JSON body" });
    return;
  }

  const body = parsed as Partial<TelegramMessage> & { at?: string };
  const direction = body.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    sendJson(res, 400, { error: 'direction must be "inbound" or "outbound"' });
    return;
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    sendJson(res, 400, { error: "text is required" });
    return;
  }

  const message = telegram.ingest({
    direction,
    text: body.text,
    ...(body.kind ? { kind: body.kind } : {}),
    ...(body.at ? { at: body.at } : {}),
  });
  // Push the frame now: an ingested message that waits up to 2s for the next
  // tick reads as lag between the phone and the wall during a live demo.
  void tick();
  sendJson(res, 202, { ok: true, message });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  if (req.method === "POST" && pathname === "/api/telegram") {
    void ingestTelegram(req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD, POST" });
    res.end();
    return;
  }
  if (pathname === "/api/stream") {
    streamSnapshots(req, res);
    return;
  }
  if (pathname === "/api/state") {
    if (!latest) {
      sendJson(res, 503, { error: "no snapshot yet" });
      return;
    }
    sendJson(res, 200, latest);
    return;
  }
  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      tick: latest?.server.tick ?? 0,
      clients: clients.size,
      sensorLog: SENSOR_LOG,
      feedConnected: latest?.feed.connected ?? false,
    });
    return;
  }
  void serveStatic(res, pathname);
});

async function main(): Promise<void> {
  await tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  server.listen(PORT, HOST, () => {
    console.log(`[dashboard] http://${HOST}:${PORT}`);
    console.log(`[dashboard] sensor log : ${SENSOR_LOG}`);
    console.log(`[dashboard] alert state: ${STATE_PATH}`);
    console.log(`[dashboard] tick        : ${TICK_MS}ms`);
  });

  const shutdown = (): void => {
    clearInterval(timer);
    for (const client of clients) client.end();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[dashboard] fatal:", err);
  process.exit(1);
});
