import { hostname } from "node:os";
import type { AccessSentry } from "../access/sentry.js";
import { assessIncident } from "../assess/assess.js";
import { activityStatus, humanizeActivity } from "../common/activity.js";
import { statusForValue } from "../common/alerts.js";
import { windowSeed } from "../common/rng.js";
import { THERMAL_ZONE } from "../common/thermal.js";
import { ENVIRONMENTAL_THRESHOLDS } from "../common/thresholds.js";
import type { Status } from "../common/types.js";
import { DEFAULT_MAX_AGE_S } from "../environmental/file-source.js";
import { getEnvironmentalReading } from "../environmental/source.js";
import { generateComputeReport } from "../mock/compute.js";
import { generateNetworkReport } from "../mock/network.js";
import { generateStorageReport } from "../mock/storage.js";
import { readSensorLogView } from "./sensor-log.js";
import type { TelegramFeed } from "./telegram-feed.js";
import { envPositive } from "../common/env.js";
import type {
  DashboardSnapshot,
  DeviceView,
  FamilySummary,
  FeedView,
  FeederDevice,
  PipelineEvent,
  SensorEvent,
} from "./types.js";

/**
 * Assembles one frame of the wall display.
 *
 * The rule this file follows: every number rendered on the page is produced by
 * the same function an MCP tool would call, with the same inputs. The dashboard
 * is a second consumer of the reasoning layer, not a parallel implementation of
 * it -- otherwise the wall and the agent could disagree on stage, and the wall
 * would be the one lying.
 *
 * The one piece of plumbing that matters: `windowSeed()` is captured ONCE per
 * tick and passed to the assessment and to each family report. The generators
 * already bucket their seed by a 60s window (common/rng.ts), so this is normally
 * redundant -- but a tick that straddles a bucket boundary would otherwise show
 * an assessment built from one world and a device grid built from the next.
 */

/** Pipeline events retained for the middle column's stream. */
const EVENT_LIMIT = 60;
/** Cap on device events promoted into the pipeline stream per tick. */
const NEW_EVENTS_PER_TICK = 6;

/**
 * Friendly names for the board's raw event vocabulary. `sensor_tick` is
 * deliberately absent: it is counted, not streamed. At one tick per 10s it would
 * push every other event out of a 60-entry window within two minutes, and the
 * middle column exists to show *processing*, not to mirror the raw log (which
 * the left column already does, in full).
 */
const DEVICE_EVENT_LABELS: Record<string, { label: string; status: Status }> = {
  door_open: { label: "Door opened", status: "warning" },
  door_closed: { label: "Door closed", status: "ok" },
  light_on: { label: "Lighting on", status: "ok" },
  light_off: { label: "Lighting off", status: "ok" },
  leak_detected: { label: "Leak detected", status: "critical" },
  leak_cleared: { label: "Leak cleared", status: "ok" },
  object_entered: { label: "Presence detected", status: "ok" },
  object_left: { label: "Presence cleared", status: "ok" },
};


/**
 * Verdict wording for the pipeline stream. Spelled out rather than slugged: the
 * middle column is read aloud during the demo, and "unauthorized-during-incident"
 * is not a sentence.
 */
const ACCESS_LABELS: Record<string, string> = {
  idle: "rack clear",
  "pending-capture": "presence detected · awaiting capture",
  clear: "authorised person at the rack",
  expected: "on-call on site · escalation suppressed",
  challenge: "UNKNOWN PERSON · approval required",
  "unauthorized-during-incident": "UNKNOWN PERSON during an active incident",
  "anti-passback": "at the rack with no door entry",
  tailgating: "TAILGATING · more people than authorised entries",
};

export interface SnapshotBuilderOptions {
  sensorLogPath: string;
  telegram: TelegramFeed;
  access: AccessSentry;
  tickMs: number;
}

export class SnapshotBuilder {
  private readonly startedAt = new Date();
  private tick = 0;
  private eventSeq = 0;
  private readonly events: PipelineEvent[] = [];
  private linesIngested = 0;
  private lastSeenLineMs = 0;
  private lastWorldSeed: number | undefined;
  private lastInferenceKey: string | undefined;
  private lastFeedConnected: boolean | undefined;
  private lastTelegramId: string | undefined;
  private lastAccessKey: string | undefined;
  private readonly lastFeederStatus = new Map<string, Status>();

  constructor(private readonly opts: SnapshotBuilderOptions) {}

  async build(): Promise<DashboardSnapshot> {
    const buildStart = Date.now();
    const now = new Date();
    this.tick += 1;

    // One world per tick. See the note at the top of the file.
    const seed = windowSeed(now.getTime());

    const environmental = await getEnvironmentalReading();
    const log = await readSensorLogView({ path: this.opts.sensorLogPath, now });

    // Freshness is part of "connected", not a separate nicety. readSensorLogView
    // parses whatever is on disk; the environmental tool additionally rejects a
    // log older than UNOQ_LOG_MAX_AGE_S. Without applying the same gate here the
    // wall would animate a healthy feed while the tool was already falling back
    // to mock -- the two panels would contradict each other on stage.
    // Same default as the environmental tool, imported rather than repeated --
    // a second copy of this number is how the wall came to call an hour-dead
    // board "real" while the tool already considered it stale.
    const maxAgeSeconds = envNumber("UNOQ_LOG_MAX_AGE_S", DEFAULT_MAX_AGE_S);
    const stale = log.ok && log.ageSeconds !== undefined && log.ageSeconds > maxAgeSeconds;
    const feedConnected = log.ok && !stale;
    const feedReason =
      log.reason ??
      (stale
        ? `sensor log is stale: newest line is ${log.ageSeconds}s old ` +
          `(max ${maxAgeSeconds}s) -- board may be offline`
        : undefined);

    // Mirrors assess.ts exactly: a mocked temperature must never be allowed to
    // drive the coupled simulators, or the correlation is manufactured.
    const ambientC = environmental.source === "real" ? environmental.temperatureC : undefined;
    const network = generateNetworkReport({ seed });
    const storage = generateStorageReport({ seed, ambientC });
    const compute = generateComputeReport({ seed, ambientC });
    const assessment = await assessIncident({ seed, environmentalOverride: environmental });

    const feeders = buildFeeders(network, storage, compute);
    const telegram = await this.opts.telegram.update(environmental, now);
    // Fed the log view and the assessment the builder already has, rather than
    // re-reading either: the wall and the sentry must be looking at one world.
    //
    // `feedConnected` is passed explicitly. It used to compute `stale` here and
    // then hand the sentry the raw log anyway, so a dead board read as somebody
    // standing at the rack forever, and a dead cable could file an audit entry
    // saying a human walked away without deciding.
    const access = await this.opts.access.update(log, assessment, now, feedConnected);

    this.recordDeviceEvents(log.events);
    this.recordAccess(access, now);
    this.recordWorldEvents(seed, feeders, network.links.length, storage.volumes.length, compute.nodes.length);
    this.recordInference(assessment, seed);
    this.recordFeedHealth(feedConnected, feedReason, now);
    this.recordTelegram(telegram.messages);

    const device: DeviceView = {
      name: "Rack environmental monitor",
      board: "Arduino UNO Q",
      zone: THERMAL_ZONE,
      online: environmental.source === "real",
      source: environmental.source,
      ...(environmental.via ? { via: environmental.via } : {}),
      ...(environmental.fallbackReason ? { fallbackReason: environmental.fallbackReason } : {}),
      status: environmental.status,
      temperatureC: environmental.temperatureC,
      temperatureStatus: statusForValue(
        environmental.temperatureC,
        ENVIRONMENTAL_THRESHOLDS.temperatureC,
        "high",
      ),
      humidityPct: environmental.humidityPct,
      humidityStatus: statusForValue(
        environmental.humidityPct,
        ENVIRONMENTAL_THRESHOLDS.humidityPct,
        "high",
      ),
      // The tool's distance comes from the newest line only, and the board no
      // longer puts distance on the ~10s tick -- so fall back to the newest
      // measured line in the window and carry its age rather than showing a dash.
      ...distanceView(environmental.distanceMm, log, now),
      presenceThresholdMm: PRESENCE_THRESHOLD_MM,
      leakDetected: environmental.leakDetected,
      ...(environmental.leakVia ? { leakVia: environmental.leakVia } : {}),
      leakStatus: environmental.leakDetected ? "critical" : "ok",
      door: log.door,
      light: log.light,
      presence: log.presence,
      ...(environmental.ageSeconds !== undefined ? { ageSeconds: environmental.ageSeconds } : {}),
      ...(environmental.lastEventAt ? { lastEventAt: environmental.lastEventAt } : {}),
      ...(environmental.lastEvent ? { lastEvent: environmental.lastEvent } : {}),
      climate: log.climate,
      events: log.events,
      thresholds: {
        temperatureC: ENVIRONMENTAL_THRESHOLDS.temperatureC,
        humidityPct: ENVIRONMENTAL_THRESHOLDS.humidityPct,
      },
    };

    const feed: FeedView = {
      path: this.opts.sensorLogPath,
      transport: "JSON-lines sensor log (board push / adb pull)",
      connected: feedConnected,
      ...(feedReason ? { reason: feedReason } : {}),
      fileSizeBytes: log.fileSizeBytes,
      linesInWindow: log.linesInWindow,
      ...(log.lastLineAt ? { lastLineAt: log.lastLineAt } : {}),
      ...(log.ageSeconds !== undefined ? { ageSeconds: log.ageSeconds } : {}),
      linesIngested: this.linesIngested,
      eventCounts: log.eventCounts,
      maxAgeSeconds,
    };

    return {
      generatedAt: now.toISOString(),
      device,
      feed,
      server: {
        host: hostname(),
        runtime: `Node ${process.version}`,
        model: process.env.HERMES_MODEL ?? "Qwen3-4B-Instruct-2507 · Q4_0",
        accelerator: process.env.HERMES_ACCELERATOR ?? "Hexagon NPU via GenieX",
        startedAt: this.startedAt.toISOString(),
        uptimeSeconds: Math.round((now.getTime() - this.startedAt.getTime()) / 1000),
        tick: this.tick,
        tickMs: this.opts.tickMs,
        buildMs: Date.now() - buildStart,
        worldSeed: seed,
        worldWindowSeconds: envPositive("SIM_WORLD_WINDOW_S", 60),
        assessment,
        families: buildFamilies(environmental.status, network, storage, compute),
        feeders,
        reports: { network, storage, compute },
      },
      telegram,
      events: [...this.events].reverse(),
      environmental,
      access,
    };
  }

  /**
   * Stream access verdicts as they change, not every tick.
   *
   * Keyed on the challenge id plus the verdict, so a stranger standing still for
   * two minutes produces one line rather than sixty, but the moment identity or
   * severity moves -- capture arrives, approval lands -- that is a new event.
   */
  private recordAccess(access: DashboardSnapshot["access"], now: Date): void {
    const pendingId = access.pending?.id ?? "none";
    const approval = access.pending?.approval.state ?? "none";
    const key = `${pendingId}:${access.verdict}:${approval}`;
    if (key === this.lastAccessKey) return;
    const first = this.lastAccessKey === undefined;
    this.lastAccessKey = key;
    // Priming: an idle rack at startup is not an event worth a line.
    if (first && access.verdict === "idle") return;

    // The approval is its own moment, so it gets its own line rather than
    // repeating the verdict text and looking like a duplicate frame.
    const decided = access.pending?.approval.state;
    const label =
      decided === "approved" || decided === "denied"
        ? `Access ${decided.toUpperCase()} · ${ACCESS_LABELS[access.verdict] ?? access.verdict}`
        : `Access · ${ACCESS_LABELS[access.verdict] ?? access.verdict}`;

    this.pushEvent({
      at: now.toISOString(),
      source: "physical",
      label,
      detail: access.reasons[0] ?? undefined,
      status: access.severity,
    });
  }

  /** Promote genuinely new, non-tick device events into the pipeline stream. */
  private recordDeviceEvents(events: SensorEvent[]): void {
    // `events` arrives newest-first; walk oldest-first so the stream stays ordered.
    const fresh = [...events].reverse().filter((event) => {
      const ms = Date.parse(event.at);
      return !Number.isNaN(ms) && ms > this.lastSeenLineMs;
    });
    if (fresh.length === 0) return;

    // The first tick sees the whole existing log as "new". Adopt it as the
    // baseline: those lines arrived before the wall did, so they are neither
    // ingested-since-start nor live events to stream.
    const priming = this.lastSeenLineMs === 0;
    const newestMs = Date.parse(fresh[fresh.length - 1]?.at ?? "");
    if (!Number.isNaN(newestMs)) this.lastSeenLineMs = newestMs;
    if (priming) return;

    this.linesIngested += fresh.length;
    for (const event of fresh.slice(-NEW_EVENTS_PER_TICK)) {
      if (event.event === "activity" && event.activity) {
        // source: "board-inference", not "physical" or "inference" -- this
        // line was written by the board's own on-device LLM correlating the
        // raw physical events, not read directly off a sensor, and not the
        // laptop's own risk assessment either. Kept as its own value (see
        // PipelineEvent.source) so the wall can tell the viewer which tier
        // produced which line.
        this.pushEvent({
          at: event.at,
          source: "board-inference",
          label: humanizeActivity(event.activity),
          detail: event.trigger ?? `${event.temperatureC.toFixed(1)} C · ${event.humidityPct.toFixed(1)}% RH`,
          status: activityStatus(event.activity),
        });
        continue;
      }
      const mapped = DEVICE_EVENT_LABELS[event.event];
      if (!mapped) continue; // sensor_tick and anything unrecognised: counted, not streamed
      this.pushEvent({
        at: event.at,
        source: "physical",
        label: mapped.label,
        detail: `${event.temperatureC.toFixed(1)} C · ${event.humidityPct.toFixed(1)}% RH`,
        status: mapped.status,
      });
    }
  }

  /**
   * The simulated families hold still for a 60s window and then advance. That
   * boundary is the honest moment to say "telemetry polled" -- emitting a poll
   * event every 2s tick would imply a data rate that isn't there.
   */
  private recordWorldEvents(
    seed: number,
    feeders: FeederDevice[],
    linkCount: number,
    volumeCount: number,
    nodeCount: number,
  ): void {
    const seedChanged = this.lastWorldSeed !== undefined && this.lastWorldSeed !== seed;
    const first = this.lastWorldSeed === undefined;
    this.lastWorldSeed = seed;

    for (const feeder of feeders) {
      const previous = this.lastFeederStatus.get(feeder.id);
      this.lastFeederStatus.set(feeder.id, feeder.status);
      if (previous === undefined || previous === feeder.status) continue;
      this.pushEvent({
        source: feeder.family,
        label: `${feeder.label} → ${feeder.status.toUpperCase()}`,
        detail: feeder.metrics.map((m) => `${m.label} ${m.value}`).join(" · "),
        status: feeder.status,
      });
    }

    if (!seedChanged && !first) return;
    this.pushEvent({
      source: "network",
      label: `Network telemetry polled · ${linkCount} links`,
      status: "ok",
    });
    this.pushEvent({
      source: "storage",
      label: `Storage telemetry polled · ${volumeCount} volumes`,
      status: "ok",
    });
    this.pushEvent({
      source: "compute",
      label: `Compute telemetry polled · ${nodeCount} nodes`,
      status: "ok",
    });
  }

  private recordInference(
    assessment: DashboardSnapshot["server"]["assessment"],
    seed: number,
  ): void {
    const key = `${seed}:${assessment.risk.level}:${assessment.likelyCause}`;
    if (key === this.lastInferenceKey) return;
    this.lastInferenceKey = key;
    this.pushEvent({
      source: "inference",
      label: `Assessment · risk ${assessment.risk.level.toUpperCase()} ${assessment.risk.score}/100`,
      detail: assessment.likelyCause,
      status: riskToStatus(assessment.risk.level),
    });
  }

  private recordFeedHealth(connected: boolean, reason: string | undefined, now: Date): void {
    if (this.lastFeedConnected === connected) return;
    const first = this.lastFeedConnected === undefined;
    this.lastFeedConnected = connected;
    if (first && connected) return;
    this.pushEvent({
      at: now.toISOString(),
      source: "physical",
      label: connected ? "Sensor feed restored" : "Sensor feed lost",
      ...(reason ? { detail: reason } : {}),
      status: connected ? "ok" : "critical",
    });
  }

  private recordTelegram(messages: DashboardSnapshot["telegram"]["messages"]): void {
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === this.lastTelegramId) return;
    const first = this.lastTelegramId === undefined;
    this.lastTelegramId = newest.id;
    if (first) return; // the "wall display attached" line is not a pipeline event
    this.pushEvent({
      at: newest.at,
      source: "telegram",
      label:
        newest.direction === "outbound"
          ? `Telegram sent · ${newest.kind}`
          : `Telegram received · ${newest.kind}`,
      detail: newest.text.slice(0, 120),
      status: newest.status ?? "ok",
    });
  }

  private pushEvent(event: Omit<PipelineEvent, "id" | "at"> & { at?: string }): void {
    this.eventSeq += 1;
    this.events.push({
      id: `evt-${this.eventSeq}`,
      at: event.at ?? new Date().toISOString(),
      source: event.source,
      label: event.label,
      ...(event.detail ? { detail: event.detail } : {}),
      status: event.status,
    });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }
}

/**
 * The sketch's own presence gate (uno-q/hermes-sensor-logger/sketch/sketch.ino,
 * PRESENCE_THRESHOLD_MM). Anything further away is reported as -1.0 and treated
 * as "no sample", so the page has to say what the ceiling is rather than let a
 * missing reading look like a broken sensor.
 */
const PRESENCE_THRESHOLD_MM = 1000;

function distanceView(
  fromTool: number | undefined,
  log: { distanceMm?: number; distanceAt?: string },
  now: Date,
): { distanceMm?: number; distanceAt?: string; distanceAgeSeconds?: number } {
  if (fromTool !== undefined) return { distanceMm: fromTool };
  if (log.distanceMm === undefined) return {};
  const at = log.distanceAt;
  const ms = at ? Date.parse(at) : Number.NaN;
  return {
    distanceMm: log.distanceMm,
    ...(at ? { distanceAt: at } : {}),
    ...(Number.isNaN(ms) ? {} : { distanceAgeSeconds: Math.max(0, Math.round((now.getTime() - ms) / 1000)) }),
  };
}

/**
 * Same guard the environmental file source uses: a non-numeric override must
 * fall back to the default rather than becoming NaN, where every `> NaN`
 * comparison is false and the staleness check silently never fires.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function riskToStatus(level: DashboardSnapshot["server"]["assessment"]["risk"]["level"]): Status {
  if (level === "critical" || level === "high") return "critical";
  if (level === "medium") return "warning";
  return "ok";
}

function buildFeeders(
  network: ReturnType<typeof generateNetworkReport>,
  storage: ReturnType<typeof generateStorageReport>,
  compute: ReturnType<typeof generateComputeReport>,
): FeederDevice[] {
  const feeders: FeederDevice[] = [];

  for (const link of network.links) {
    feeders.push({
      id: link.id,
      family: "network",
      kind: "Link",
      label: `${link.from} → ${link.to}`,
      status: link.status,
      simulated: true,
      metrics: [
        { label: "latency", value: `${link.latencyMs} ms`, status: link.status },
        { label: "loss", value: `${link.packetLossPct}%`, status: link.status },
        {
          label: "state",
          value: link.connected ? "up" : "down",
          status: link.connected ? "ok" : "critical",
        },
      ],
    });
  }

  for (const volume of storage.volumes) {
    feeders.push({
      id: volume.id,
      family: "storage",
      kind: "Volume",
      label: `${volume.id} · ${volume.zone}`,
      status: volume.status,
      simulated: true,
      metrics: [
        { label: "read", value: `${volume.latencyMs} ms`, status: volume.status },
        { label: "used", value: `${volume.capacityUsedPct}%`, status: volume.status },
        {
          label: "backup",
          value: `${Math.round(volume.backupThroughputMbs)} MB/s`,
          status: volume.status,
        },
      ],
    });
  }

  for (const node of compute.nodes) {
    feeders.push({
      id: node.id,
      family: "compute",
      kind: "Node",
      label: node.id,
      status: node.status,
      simulated: true,
      metrics: [
        { label: "cpu", value: `${Math.round(node.cpuPct)}%`, status: node.status },
        { label: "mem", value: `${Math.round(node.memPct)}%`, status: node.status },
        {
          label: "svc",
          value: node.serviceState,
          status: node.serviceState === "running" ? "ok" : node.serviceState === "down" ? "critical" : "warning",
        },
      ],
    });
  }

  return feeders;
}

function buildFamilies(
  environmentalStatus: Status,
  network: ReturnType<typeof generateNetworkReport>,
  storage: ReturnType<typeof generateStorageReport>,
  compute: ReturnType<typeof generateComputeReport>,
): FamilySummary[] {
  return [
    {
      family: "physical",
      label: "Environmental",
      status: environmentalStatus,
      deviceCount: 1,
      simulated: false,
    },
    {
      family: "network",
      label: "Network",
      status: network.overallStatus,
      deviceCount: network.links.length,
      simulated: true,
    },
    {
      family: "storage",
      label: "Storage",
      status: storage.overallStatus,
      deviceCount: storage.volumes.length,
      simulated: true,
    },
    {
      family: "compute",
      label: "Compute",
      status: compute.overallStatus,
      deviceCount: compute.nodes.length,
      simulated: true,
    },
  ];
}
