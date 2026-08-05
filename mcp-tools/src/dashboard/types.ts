/**
 * The wire contract between the dashboard server and the browser.
 *
 * One `DashboardSnapshot` is pushed over SSE every tick and the page renders it
 * whole -- there is no incremental protocol, because at a 2s cadence a full
 * redraw of ~30KB of JSON is cheaper to reason about than a diff stream, and a
 * reconnecting browser is instantly correct rather than replaying history.
 *
 * Everything here is derived from the same functions the agent's MCP tools call.
 * Nothing on this page is invented for the display: if a number appears, some
 * tool would return it.
 */
import type { Status, Thresholds } from "../common/types.js";
import type { EnvironmentalResult } from "../environmental/types.js";
import type { Family, IncidentAssessment } from "../assess/types.js";
import type { AccessView } from "../access/sentry.js";
import type { NetworkReport } from "../mock/network.js";
import type { StorageReport } from "../mock/storage.js";
import type { ComputeReport } from "../mock/compute.js";

/** Two-state physical channels the UNO Q reports as paired button edges. */
export type ChannelState = "open" | "closed" | "on" | "off" | "present" | "clear" | "unknown";

export interface ChannelView {
  state: ChannelState;
  /** ISO timestamp of the edge that put the channel in this state. */
  since?: string;
  /** Seconds the channel has held this state. */
  heldSeconds?: number;
  /**
   * False when the log window contains no edge for this channel at all -- the
   * state is genuinely unknown, not "closed". Shown as such rather than guessed:
   * a dashboard that renders an unobserved door as "secure" is lying.
   */
  observed: boolean;
}

export interface ClimatePoint {
  at: string;
  temperatureC: number;
  humidityPct: number;
}

export interface SensorEvent {
  id: string;
  at: string;
  event: string;
  temperatureC: number;
  humidityPct: number;
  distanceMm?: number;
}

/** Left column: the UNO Q playing the environmental monitoring device. */
export interface DeviceView {
  name: string;
  board: string;
  zone: string;
  /** True when the environmental tool resolved a real board reading, not a mock. */
  online: boolean;
  source: "real" | "mock";
  via?: "file" | "ssh";
  fallbackReason?: string;
  status: Status;
  temperatureC: number;
  temperatureStatus: Status;
  humidityPct: number;
  humidityStatus: Status;
  /**
   * Newest ToF measurement available, from the tool when it has one and from the
   * log window otherwise. Since the board stopped putting `distance_mm` on the
   * ~10s tick, the tool almost never carries it -- so this is usually the log's
   * value, and `distanceAgeSeconds` is what makes that honest on screen.
   */
  distanceMm?: number;
  distanceAt?: string;
  distanceAgeSeconds?: number;
  /** The sketch's presence gate: nothing beyond this is reported at all. */
  presenceThresholdMm: number;
  leakDetected: boolean;
  leakVia?: "event" | "level";
  leakStatus: Status;
  door: ChannelView;
  light: ChannelView;
  presence: ChannelView;
  ageSeconds?: number;
  lastEventAt?: string;
  lastEvent?: string;
  climate: ClimatePoint[];
  events: SensorEvent[];
  thresholds: { temperatureC: Thresholds; humidityPct: Thresholds };
}

/** The device -> server link, so the page can show the feed itself, not just its payload. */
export interface FeedView {
  path: string;
  transport: string;
  connected: boolean;
  reason?: string;
  fileSizeBytes: number;
  linesInWindow: number;
  lastLineAt?: string;
  ageSeconds?: number;
  /** Lines the dashboard has watched arrive since it started. */
  linesIngested: number;
  eventCounts: Record<string, number>;
  maxAgeSeconds: number;
}

/** Middle column: one non-environmental device whose telemetry reaches the server. */
export interface FeederDevice {
  id: string;
  family: Family;
  kind: string;
  label: string;
  metrics: { label: string; value: string; status: Status }[];
  status: Status;
  /** True for the simulated families -- rendered as a badge, never hidden. */
  simulated: boolean;
}

export interface FamilySummary {
  family: Family;
  label: string;
  status: Status;
  deviceCount: number;
  simulated: boolean;
}

export interface PipelineEvent {
  id: string;
  at: string;
  source: Family | "inference" | "telegram";
  label: string;
  detail?: string;
  status: Status;
}

export interface TelegramMessage {
  id: string;
  at: string;
  direction: "outbound" | "inbound";
  /** watchdog = the cron alert path; gateway = posted in by Hermes; dashboard = this page. */
  origin: "watchdog" | "gateway" | "dashboard";
  kind: "alert" | "recovery" | "reply" | "question" | "system";
  status?: Status;
  text: string;
  /**
   * False for a message the watchdog *will* send on its next tick but has not
   * sent yet. The phone panel renders it greyed with a "queued" marker, so the
   * wall never claims a delivery that has not happened.
   */
  delivered: boolean;
}

export interface TelegramView {
  botLabel: string;
  chatTitle: string;
  messages: TelegramMessage[];
  /** Live mirror of the cron watchdog's persisted state file. */
  watchdog: {
    statePath: string;
    stateFound: boolean;
    lastStatus: Status;
    lastAlertedAt?: string;
    /** Seconds since the watchdog last actually delivered something. */
    lastAlertAgeSeconds?: number;
  };
  /** The alert the watchdog would raise right now, if any. */
  pending?: TelegramMessage;
  /**
   * Whether phone -> server messages can reach this panel at all.
   *
   * Load-bearing for honesty: with no inbound source configured the thread is
   * one-directional, and a panel that just looks quiet is indistinguishable from
   * a broken one. The page says which it is.
   */
  inbound: {
    /** off | starting | live | conflict | error */
    mode: string;
    detail: string;
    /** gateway (the Hermes transcript bridge) | dedicated | shared | none */
    bot: string;
  };
  ingestUrl: string;
  ingestedCount: number;
}

export interface ServerView {
  host: string;
  runtime: string;
  model: string;
  accelerator: string;
  startedAt: string;
  uptimeSeconds: number;
  tick: number;
  tickMs: number;
  /** Milliseconds the last snapshot build took -- the page's own honesty meter. */
  buildMs: number;
  /** The 60s time-bucket seed that pins the simulated world (see common/rng.ts). */
  worldSeed: number;
  worldWindowSeconds: number;
  assessment: IncidentAssessment;
  families: FamilySummary[];
  feeders: FeederDevice[];
  reports: {
    network: NetworkReport;
    storage: StorageReport;
    compute: ComputeReport;
  };
}

export interface DashboardSnapshot {
  generatedAt: string;
  device: DeviceView;
  feed: FeedView;
  server: ServerView;
  telegram: TelegramView;
  events: PipelineEvent[];
  /** The raw environmental tool result, shown verbatim in the provenance drawer. */
  environmental: EnvironmentalResult;
  /**
   * Physical access: who is at the rack and whether a human has allowed it.
   *
   * Carried on the same snapshot as everything else so the phone and the wall
   * cannot disagree about an open challenge -- which, for an approval surface,
   * is the difference between an audit trail and a rumour.
   */
  access: AccessView;
}
