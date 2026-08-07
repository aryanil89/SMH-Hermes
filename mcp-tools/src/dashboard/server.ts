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
 *
 * Phone -> wall messages. The gateway transcript bridge is on by default and
 * needs no configuration; the rest are alternatives for a machine without Hermes:
 *   HERMES_STATE_DB          the Hermes transcript to mirror. Auto-detected from
 *                            HERMES_HOME / %LOCALAPPDATA%\hermes; HERMES_BRIDGE=0
 *                            turns it off. See gateway-bridge.ts
 *   TELEGRAM_WALL_BOT_TOKEN  a SECOND bot, polled by the wall. Cannot collide
 *                            with `hermes gateway`
 *   TELEGRAM_POLL=1          poll the shared TELEGRAM_BOT_TOKEN instead. Only
 *                            safe when the gateway is NOT running; see
 *                            telegram-poll.ts
 *   TELEGRAM_ALLOWED_USERS   comma-separated numeric ids allowed on the wall
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { envPositive } from "../common/env.js";
import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessSentry } from "../access/sentry.js";
import { THERMAL_ZONE } from "../common/thermal.js";
import { drainSentNotifications } from "../access/notify.js";
import { HermesGatewayBridge, mergeInbound, resolveHermesStateDb } from "./gateway-bridge.js";
import { SnapshotBuilder } from "./snapshot.js";
import { TelegramFeed } from "./telegram-feed.js";
import { TelegramPoller, allowedUsers, resolveInboundToken } from "./telegram-poll.js";
import type { DashboardSnapshot, TelegramMessage } from "./types.js";
import type { ApprovalDecision } from "../access/types.js";

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

const PORT = envPositive("DASHBOARD_PORT", 7788);
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
/** This is a demo-table display meant to be looked at, so open it by default. Opt out for a
 *  headless run (e.g. before a projector is connected) with DASHBOARD_OPEN_BROWSER=0. */
const OPEN_BROWSER = process.env.DASHBOARD_OPEN_BROWSER !== "0";
// Floored: a sub-250ms cadence buys nothing visually and turns the log tail into
// a busy loop on a machine that is also running NPU inference.
//
// envPositive, not Number(): `Math.max(250, NaN)` is NaN and `setInterval(NaN)`
// is treated as 1ms, so a typo in DASHBOARD_TICK_MS produced exactly the busy
// loop the floor above exists to prevent. See common/env.ts.
const TICK_MS = Math.max(250, envPositive("DASHBOARD_TICK_MS", 2000));
const SENSOR_LOG = process.env.UNOQ_SENSOR_LOG ?? DEFAULT_SENSOR_LOG;
const STATE_PATH = process.env.ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
/** Ingest bodies are one chat message; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * Capture bodies carry a base64 JPEG from the phone, so they need their own,
 * much larger ceiling -- a 200MP sensor downscaled by the browser still lands in
 * the low megabytes. Kept separate from MAX_BODY_BYTES rather than raising it:
 * the Telegram ingest endpoint has no business accepting an 8MB body.
 */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const ACCESS_STATE_PATH =
  process.env.ACCESS_STATE_PATH ?? join(PACKAGE_ROOT, ".state", "access.json");
const ROSTER_PATH = process.env.ACCESS_ROSTER_PATH ?? join(PACKAGE_ROOT, ".state", "roster.json");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Inbound Telegram, if it is safe to poll. `resolveInboundToken` prefers a
 * dedicated wall bot and only touches the shared bot behind TELEGRAM_POLL=1 --
 * see telegram-poll.ts for why polling the shared token would break the agent.
 */
const inbound = resolveInboundToken();
let poller: TelegramPoller | undefined;

/**
 * The default inbound source: Hermes's own durable transcript, read-only.
 *
 * This is what makes the thread two-directional out of the box. The gateway
 * already owns the bot token and already writes down every message it carried,
 * so mirroring that file gives the panel real phone → server traffic without a
 * second bot and without a `getUpdates` consumer fighting the agent for updates.
 */
const stateDb = resolveHermesStateDb();
// A junk value here must fall back to the default rather than reach SQLite as a
// NaN bind, which fails the read and takes the whole inbound path down.
const backfill = Number(process.env.HERMES_BRIDGE_BACKFILL?.trim() || Number.NaN);
const bridge = stateDb
  ? new HermesGatewayBridge({
      dbPath: stateDb,
      ...(Number.isFinite(backfill) ? { backfill: Math.max(0, Math.trunc(backfill)) } : {}),
    })
  : undefined;

function inboundStatus(): { mode: string; detail: string; bot: string } {
  const merged = mergeInbound(
    bridge?.getStatus(),
    poller?.getStatus() ??
      (inbound ? { mode: "starting", detail: "starting", bot: inbound.bot } : undefined),
  );
  return (
    merged ?? {
      mode: "off",
      detail:
        "No Hermes transcript found and no wall bot configured, so questions typed on the phone " +
        "do not reach this panel. Set HERMES_STATE_DB, or TELEGRAM_WALL_BOT_TOKEN, or POST to /api/telegram.",
      bot: "none",
    }
  );
}

const telegram: TelegramFeed = new TelegramFeed({
  statePath: STATE_PATH,
  botLabel: process.env.TELEGRAM_BOT_LABEL ?? "Hermes Ops",
  chatTitle: process.env.TELEGRAM_CHAT_TITLE ?? "On-call · Telegram",
  ingestUrl: `http://${HOST}:${PORT}/api/telegram`,
  // The access sentry pages the phone directly; this is how those real sends
  // reach the panel instead of only the cron watchdog's alerts.
  drainOutbound: () => drainSentNotifications(),
  inboundStatus,
});

if (inbound) {
  poller = new TelegramPoller({
    token: inbound.token,
    bot: inbound.bot,
    allowedUsers: allowedUsers(),
    // Only set when pointing the loop at a stub; unset means api.telegram.org.
    ...(process.env.TELEGRAM_API_BASE ? { apiBase: process.env.TELEGRAM_API_BASE } : {}),
    onMessage: (message) => {
      telegram.ingest({
        direction: "inbound",
        text: message.text,
        kind: "question",
        at: message.at,
      });
      // Push a frame now: waiting up to 2s reads as lag between the phone and
      // the wall when both are in shot.
      void tick();
    },
  });
}

const access = new AccessSentry({
  statePath: ACCESS_STATE_PATH,
  rosterPath: ROSTER_PATH,
  zone: THERMAL_ZONE,
  captureUrl: `http://${HOST}:${PORT}/api/access/capture`,
});

const builder = new SnapshotBuilder({
  sensorLogPath: SENSOR_LOG,
  telegram,
  access,
  tickMs: TICK_MS,
});

const clients = new Set<ServerResponse>();
let latest: DashboardSnapshot | undefined;
/** Guards against a slow tick overlapping the next one on a loaded machine. */
let building = false;

async function tick(): Promise<void> {
  if (building) return;
  building = true;
  try {
    // Before the snapshot, not after: a message pulled from the gateway
    // transcript has to be in the feed that this tick is about to publish, or it
    // shows up 2s late next to a phone that is in the same shot.
    if (bridge) {
      for (const message of await bridge.drain()) telegram.ingest(message);
    }
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

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBody(req, limit)) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid JSON body" });
    return undefined;
  }
}

/**
 * A capture from the phone.
 *
 * The image is resolved to faces and then dropped -- nothing downstream of here
 * writes image bytes to disk. A `data:` prefix is stripped because that is what
 * `canvas.toDataURL()` produces and making the phone strip it would be one more
 * thing to get wrong at the rack.
 */
async function accessCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res, MAX_CAPTURE_BYTES);
  if (!body) return;

  const raw = typeof body.imageBase64 === "string" ? body.imageBase64 : undefined;
  // Captured before stripping, not reconstructed after: this is the mime the
  // pending-photo GET route serves back, and `canvas.toDataURL()` on the
  // phone is the source of truth for it, not an assumption made here.
  const imageMime = raw?.match(/^data:(image\/[a-z+]+);base64,/i)?.[1];
  const imageBase64 = raw?.replace(/^data:image\/[a-z+]+;base64,/i, "");
  const badges = Array.isArray(body.badges)
    ? body.badges.filter((b): b is string => typeof b === "string")
    : undefined;

  if (!imageBase64 && (!badges || badges.length === 0)) {
    sendJson(res, 400, { error: "imageBase64 or badges is required" });
    return;
  }

  const result = await access.capture({
    ...(imageBase64 ? { imageBase64, imageMime: imageMime ?? "image/jpeg" } : {}),
    ...(badges ? { badges } : {}),
    now: new Date(),
  });
  // Repaint now: a capture that waits up to 2s for the next tick reads as lag
  // between the phone and the wall while an audience is watching both.
  void tick();
  sendJson(res, result.ok ? 202 : 409, result);
}

/**
 * A human decision.
 *
 * Local plane only, by design. Telegram carries the notification and the photo;
 * it does not carry the authorisation, because a third-party relay is not
 * somewhere physical datacenter access should be granted from. Same layering
 * argument as the swappable notifier in POSITIONING.md §3, applied to consent.
 */
async function accessApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;

  const id = typeof body.id === "string" ? body.id : "";
  const decision = body.decision;
  if (decision !== "approved" && decision !== "denied") {
    sendJson(res, 400, { error: 'decision must be "approved" or "denied"' });
    return;
  }
  if (id === "") {
    sendJson(res, 400, { error: "id is required -- decisions are per challenge, never implicit" });
    return;
  }
  const decidedBy = typeof body.decidedBy === "string" && body.decidedBy.trim() !== ""
    ? body.decidedBy.trim()
    : "on-call";

  const result = await access.approve({
    id,
    decision: decision as ApprovalDecision,
    decidedBy,
    now: new Date(),
  });
  void tick();
  sendJson(res, result.ok ? 202 : 409, result);
}

/**
 * The captured photo for whichever challenge currently needs a human
 * decision -- 404 when there is none.
 *
 * Deliberately its own tiny route rather than a field on `/api/access/state`
 * or the SSE snapshot: those are polled/broadcast on every 2s tick, and a
 * base64 JPEG on every one of those payloads is a lot of bytes to move for
 * something that is usually absent and, when present, does not change
 * between ticks. `AccessSentry.pendingPhoto()` already gates on the approval
 * still being `"pending"`, so this route does not have to re-derive that.
 */
function accessPendingPhoto(res: ServerResponse): void {
  const photo = access.pendingPhoto();
  if (!photo) {
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("no photo pending");
    return;
  }
  const body = Buffer.from(photo.imageBase64, "base64");
  res.writeHead(200, {
    "content-type": photo.mime,
    "cache-control": "no-store",
    "content-length": String(body.length),
  });
  res.end(body);
}

/** Enrolment. Takes an embedding, never an image -- see access/roster.ts. */
async function accessEnrol(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res, MAX_CAPTURE_BYTES);
  if (!body) return;

  const name = typeof body.name === "string" ? body.name : "";
  const embedding = Array.isArray(body.embedding)
    ? body.embedding.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
  const method = typeof body.method === "string" ? body.method : "qr-badge";

  const result = await access.enrol({
    name,
    embedding,
    method: method as Parameters<typeof access.enrol>[0]["method"],
    now: new Date(),
  });
  sendJson(res, result.ok ? 202 : 400, result);
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

/**
 * Optional shared secret for the write routes.
 *
 * The read paths are a display; the write paths are an access-control system.
 * `/api/access/enroll` is the sharpest edge: the roster is what every later
 * decision trusts, so anyone who can reach the port could add themselves and
 * then badge in as `known`. That is fine on loopback and not fine on the
 * tailnet -- which is exactly where the phone terminal needs it bound.
 *
 * Deliberately opt-in and absent by default: the README promises anyone can
 * clone and run this, and a mandatory secret would turn "npm run start:dashboard"
 * into a support ticket. Set ACCESS_SHARED_SECRET whenever the bind address is
 * anything other than 127.0.0.1, and the startup banner says so if you have not.
 *
 * This is one lock on one door, not an auth system. Say that plainly rather than
 * implying more.
 */
const SHARED_SECRET = process.env.ACCESS_SHARED_SECRET?.trim();

function authorized(req: IncomingMessage): boolean {
  if (!SHARED_SECRET) return true;
  const header = req.headers["x-access-secret"];
  const supplied = Array.isArray(header) ? header[0] : header;
  return typeof supplied === "string" && timingSafeEqualStr(supplied, SHARED_SECRET);
}

/** Constant-time compare, so a wrong secret cannot be recovered a byte at a time. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Run a POST handler without letting a rejection kill the process.
 *
 * `void handler(req, res)` -- what these routes used to do -- turns any rejected
 * promise into an unhandled rejection, which on modern Node terminates the
 * process. Every one of these handlers writes to disk, and `writeFile` rejects
 * for ordinary reasons on this machine: the repo lives under `Downloads` on
 * Windows, where antivirus and backup software take transient file locks
 * (EBUSY/EPERM). One locked state file would have taken down the wall, the phone
 * terminal and every SSE client at once, mid-demo.
 *
 * The tick loop already had this guard. The POST paths did not.
 */
function guarded(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  label: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!authorized(req)) {
      sendJson(res, 401, { error: "x-access-secret required or incorrect" });
      return;
    }
    handler(req, res).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard] ${label} failed:`, err);
      // Headers may already be out if the failure came after a partial write;
      // the connection still has to be closed rather than left hanging.
      if (!res.headersSent) sendJson(res, 500, { error: `${label} failed: ${detail}` });
      else res.end();
    });
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  if (req.method === "POST" && pathname === "/api/telegram") {
    guarded(ingestTelegram, "telegram ingest")(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/access/capture") {
    guarded(accessCapture, "access capture")(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/access/approve") {
    guarded(accessApprove, "access approve")(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/access/enroll") {
    guarded(accessEnrol, "access enrol")(req, res);
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
  if (pathname === "/api/access/state") {
    // The phone reconnects often (screen off, tab switch) and needs the open
    // challenge without waiting for a full snapshot frame.
    if (!latest) {
      sendJson(res, 503, { error: "no snapshot yet" });
      return;
    }
    sendJson(res, 200, latest.access);
    return;
  }
  if (pathname === "/api/access/pending-photo") {
    accessPendingPhoto(res);
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

/**
 * Open the wall in the OS default browser. Best-effort: a demo laptop with no
 * default browser configured, or a headless CI box, must not take the server
 * down over this -- the URL is already logged for a human to click instead.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? `cmd /c start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, (err) => {
    if (err) console.warn(`[dashboard] could not auto-open a browser: ${err.message}`);
  });
}

async function main(): Promise<void> {
  // Fail closed, before binding: off loopback with the write routes open,
  // anyone who can reach the port can enrol themselves onto the roster and
  // then badge in as a known person. This used to be a warning, which is a
  // thing people scroll past; refusing to start is a thing people fix.
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && !SHARED_SECRET) {
    console.error(
      `[dashboard] refusing to bind ${HOST} without ACCESS_SHARED_SECRET set.\n` +
        "[dashboard] Either set ACCESS_SHARED_SECRET (scripts/demo-face-ON.ps1 generates and\n" +
        "[dashboard] persists one), or bind loopback (DASHBOARD_HOST=127.0.0.1) and reach it\n" +
        "[dashboard] through a tailscale-serve proxy as documented in docs/RUNBOOK.md.",
    );
    process.exit(1);
  }

  await tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  server.listen(PORT, HOST, () => {
    console.log(`[dashboard] http://${HOST}:${PORT}`);
    console.log(`[dashboard] sensor log : ${SENSOR_LOG}`);
    console.log(`[dashboard] alert state: ${STATE_PATH}`);
    console.log(`[dashboard] tick        : ${TICK_MS}ms`);

    if (bridge) {
      console.log(`[dashboard] gateway     : mirroring phone traffic from ${stateDb}`);
    } else {
      console.log(
        "[dashboard] gateway     : no Hermes transcript found (set HERMES_STATE_DB to point at one)",
      );
    }

    if (poller && inbound) {
      poller.start();
      console.log(`[dashboard] telegram in : polling the ${inbound.bot} bot for phone messages`);
      if (inbound.bot === "shared") {
        // The gateway is the agent's only route from the phone. If both poll,
        // Telegram 409s one of them -- so say this before it bites.
        console.warn(
          "[dashboard] WARNING: polling the SHARED TELEGRAM_BOT_TOKEN. If `hermes gateway` is\n" +
            "[dashboard]          running, one of the two will lose its updates. Prefer a second\n" +
            "[dashboard]          bot via TELEGRAM_WALL_BOT_TOKEN.",
        );
      }
    } else {
      console.log(
        "[dashboard] telegram in : no wall bot (the gateway bridge above is the usual source)",
      );
    }

    if (OPEN_BROWSER) openInBrowser(`http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  });

  const shutdown = (): void => {
    clearInterval(timer);
    poller?.stop();
    bridge?.close();
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
