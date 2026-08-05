import { open, stat } from "node:fs/promises";
import { parseSensorLogLine, type SensorLogLine } from "../environmental/file-source.js";
import { EVENT_CHANNELS } from "../rules/channels.js";
import type { ChannelState, ChannelView, ClimatePoint, SensorEvent } from "./types.js";

/**
 * Reads the same JSON-lines file the environmental MCP tool reads, but keeps the
 * whole recent window instead of just the newest line.
 *
 * The MCP tool answers "what is it now?"; the wall display also has to answer
 * "what has been happening?" -- the door/light channels, the climate trend, and
 * the event feed all need history the tool deliberately discards.
 *
 * Only the tail of the file is read. At one line per ~10s the log grows about
 * 1.7MB/day, and re-reading all of it every 2s would turn a display into a disk
 * benchmark.
 */

/** How much of the file's end to read. ~1600 lines at the board's line size. */
const MAX_TAIL_BYTES = 256 * 1024;
/** Climate points kept for the sparklines: ~15 min at the board's 10s cadence. */
const CLIMATE_POINTS = 90;
/** Lines kept for the event feed. */
const EVENT_LIMIT = 40;

export interface SensorLogView {
  ok: boolean;
  reason?: string;
  fileSizeBytes: number;
  /** True when the tail window did not cover the whole file. */
  windowed: boolean;
  linesInWindow: number;
  lastLineAt?: string;
  ageSeconds?: number;
  /**
   * Newest usable ToF reading in the window, with its own timestamp.
   *
   * Tracked separately because since 2026-08-05 the board puts `distance_mm` on
   * presence and button lines only -- never on the ~10s `sensor_tick`. The
   * environmental tool reads the newest line, which is nearly always a tick, so
   * it reports no distance almost all the time. The wall has the whole window,
   * so it can show the last real measurement and say how old it is.
   */
  distanceMm?: number;
  distanceAt?: string;
  /**
   * Timestamp of every `door_open` edge in the whole tail window.
   *
   * Kept separate from `events` because `events` is a *display* buffer, capped at
   * EVENT_LIMIT for the feed pane. The access sentry counts authorised entries
   * against this to detect tailgating, and a security count must not be silently
   * truncated by a UI constant: ToF flapping in a busy room can push the real
   * door edge out of a 40-line window, which would report **anti-passback at
   * someone who badged in perfectly normally**.
   */
  doorOpenAt: string[];
  door: ChannelView;
  light: ChannelView;
  presence: ChannelView;
  climate: ClimatePoint[];
  events: SensorEvent[];
  eventCounts: Record<string, number>;
}

interface ChannelSpec {
  /** Event name that puts the channel in `activeState`. */
  active: string;
  /** Event name that puts it back in `restState`. */
  rest: string;
  activeState: ChannelState;
  restState: ChannelState;
}

/**
 * Event names come from `rules/channels.ts`; only the display vocabulary is local.
 *
 * This file used to spell the strings out a second time. That made
 * `EVENT_CHANNELS` a *claimed* single source of truth rather than an actual one --
 * and the duplicate was the load-bearing copy, because this is where door and
 * presence state is derived. A firmware rename would have left both the wall and
 * the access sentry quietly reporting "unknown" forever, with nothing failing.
 */
const CHANNELS: Record<"door" | "light" | "presence", ChannelSpec> = {
  door: {
    active: EVENT_CHANNELS.door.enter,
    rest: EVENT_CHANNELS.door.exit,
    activeState: "open",
    restState: "closed",
  },
  light: {
    active: EVENT_CHANNELS.light.enter,
    rest: EVENT_CHANNELS.light.exit,
    activeState: "on",
    restState: "off",
  },
  presence: {
    active: EVENT_CHANNELS.presence.enter,
    rest: EVENT_CHANNELS.presence.exit,
    activeState: "present",
    restState: "clear",
  },
};

const UNKNOWN: ChannelView = { state: "unknown", observed: false };

/**
 * Read the last `MAX_TAIL_BYTES` of a file as UTF-8.
 *
 * The first line of the window is dropped whenever the window did not start at
 * byte 0, because a byte-offset read lands mid-line and a half-record parses as
 * garbage -- or worse, as a valid record with a mangled timestamp.
 */
async function readTail(path: string): Promise<{ text: string; size: number; windowed: boolean }> {
  const info = await stat(path);
  const size = info.size;
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const length = size - start;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    const windowed = start > 0;
    if (windowed) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    return { text, size, windowed };
  } finally {
    await handle.close();
  }
}

/**
 * Latest state of a two-edge channel, scanning newest-first.
 *
 * Whichever edge appears first decides, and a channel with no edge in the window
 * stays `unknown`. That last case is real on this project's own log: the board
 * only learned to emit release events partway through the build, so older files
 * contain `light_on` with no matching `light_off`.
 */
function deriveChannel(lines: SensorLogLine[], spec: ChannelSpec, nowMs: number): ChannelView {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = line.event.toLowerCase();
    if (event !== spec.active && event !== spec.rest) continue;
    const state = event === spec.active ? spec.activeState : spec.restState;
    const ts = Date.parse(line.timestamp);
    return {
      state,
      since: line.timestamp,
      ...(Number.isNaN(ts) ? {} : { heldSeconds: Math.max(0, Math.round((nowMs - ts) / 1000)) }),
      observed: true,
    };
  }
  return { ...UNKNOWN };
}

export interface ReadSensorLogViewOptions {
  path: string;
  now?: Date;
}

/**
 * Never throws: a missing or unreadable log is a normal state on this rig (the
 * pull loop is a separate process), and the display has to keep rendering the
 * rest of the system while saying plainly that the feed is down.
 */
export async function readSensorLogView(opts: ReadSensorLogViewOptions): Promise<SensorLogView> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const empty: SensorLogView = {
    ok: false,
    fileSizeBytes: 0,
    windowed: false,
    linesInWindow: 0,
    doorOpenAt: [],
    door: { ...UNKNOWN },
    light: { ...UNKNOWN },
    presence: { ...UNKNOWN },
    climate: [],
    events: [],
    eventCounts: {},
  };

  let tail: { text: string; size: number; windowed: boolean };
  try {
    tail = await readTail(opts.path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...empty, reason: `sensor log not readable at ${opts.path}: ${reason}` };
  }

  const lines: SensorLogLine[] = [];
  for (const raw of tail.text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const parsed = parseSensorLogLine(raw);
    if (parsed) lines.push(parsed);
  }

  if (lines.length === 0) {
    return {
      ...empty,
      fileSizeBytes: tail.size,
      windowed: tail.windowed,
      reason: `sensor log at ${opts.path} has no parseable lines`,
    };
  }

  const eventCounts: Record<string, number> = {};
  for (const line of lines) {
    eventCounts[line.event] = (eventCounts[line.event] ?? 0) + 1;
  }

  const climate: ClimatePoint[] = lines.slice(-CLIMATE_POINTS).map((line) => ({
    at: line.timestamp,
    temperatureC: line.temperature_c,
    humidityPct: line.humidity_pct,
  }));

  // Newest first: the feed reads top-down like a console.
  //
  // The id is content-derived, never positional. Keying on an array index would
  // change every id the moment a new line arrived -- the browser's keyed diff
  // would then rebuild and re-animate the whole feed on every 2s tick.
  const events: SensorEvent[] = lines
    .slice(-EVENT_LIMIT)
    .map((line) => ({
      id: `${line.timestamp}|${line.event}`,
      at: line.timestamp,
      event: line.event,
      temperatureC: line.temperature_c,
      humidityPct: line.humidity_pct,
      ...(typeof line.distance_mm === "number" && line.distance_mm >= 0
        ? { distanceMm: line.distance_mm }
        : {}),
    }))
    .reverse();

  // Newest line carrying a real measurement. The sketch writes -1.0 when nothing
  // is inside PRESENCE_THRESHOLD_MM, which is "no sample", not a distance.
  let distanceLine: SensorLogLine | undefined;
  for (let i = lines.length - 1; i >= 0 && !distanceLine; i--) {
    const candidate = lines[i];
    if (candidate && typeof candidate.distance_mm === "number" && candidate.distance_mm >= 0) {
      distanceLine = candidate;
    }
  }

  const latest = lines[lines.length - 1] as SensorLogLine;
  const latestMs = Date.parse(latest.timestamp);

  return {
    ok: true,
    fileSizeBytes: tail.size,
    windowed: tail.windowed,
    linesInWindow: lines.length,
    lastLineAt: latest.timestamp,
    ...(Number.isNaN(latestMs) ? {} : { ageSeconds: Math.max(0, Math.round((nowMs - latestMs) / 1000)) }),
    ...(distanceLine
      ? { distanceMm: distanceLine.distance_mm, distanceAt: distanceLine.timestamp }
      : {}),
    // From every line in the window, deliberately -- not from `events`, which is
    // capped for the display.
    doorOpenAt: lines
      .filter((l) => l.event.toLowerCase() === CHANNELS.door.active)
      .map((l) => l.timestamp),
    door: deriveChannel(lines, CHANNELS.door, nowMs),
    light: deriveChannel(lines, CHANNELS.light, nowMs),
    presence: deriveChannel(lines, CHANNELS.presence, nowMs),
    climate,
    events,
    eventCounts,
  };
}
