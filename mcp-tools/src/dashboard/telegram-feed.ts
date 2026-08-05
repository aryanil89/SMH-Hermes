import { stat } from "node:fs/promises";
import { decideAlert } from "../alert-skill/decide-alert.js";
import { readState, type AlertState } from "../alert-skill/state-store.js";
import { summarizeReading } from "../alert-skill/summarize.js";
import type { EnvironmentalResult } from "../environmental/types.js";
import type { TelegramMessage, TelegramView } from "./types.js";

/**
 * What the on-call phone is showing, reconstructed from the alert pipeline
 * rather than invented for the display.
 *
 * There are three ways a message gets onto this panel, and the panel says which:
 *
 *  1. `watchdog`, delivered -- the cron job's persisted state file changed, which
 *     only happens when a tick actually decided to send. This is evidence of a
 *     real delivery, observed after the fact.
 *  2. `watchdog`, queued -- running the *same* `decideAlert` the cron job runs
 *     says an alert is due right now. The watchdog fires every 5 minutes, so the
 *     wall knows before the phone does. Rendered greyed and marked queued: the
 *     display must never claim a delivery that has not happened.
 *  3. `gateway` -- posted in over `POST /api/telegram` by whatever is bridging
 *     the real Hermes gateway. These are verbatim, both directions.
 *
 * The alternative -- having the dashboard run its own alert loop against its own
 * state file -- would show the demo a plausible message stream that no phone
 * ever received. Mirroring the real state file keeps the panel accountable.
 */

const MESSAGE_LIMIT = 40;
/** Stable id so the queued bubble does not re-animate on every 2s tick. */
const PENDING_ID = "pending";

export interface TelegramFeedOptions {
  statePath: string;
  botLabel: string;
  chatTitle: string;
  ingestUrl: string;
  /**
   * Pulls messages the server has actually pushed to the phone since the last
   * tick (the access sentry's challenge notifications).
   *
   * Injected rather than imported so the feed keeps no dependency on the access
   * subsystem and stays testable without one. Without this, a challenge could
   * land on the on-call's phone while this panel showed nothing -- the display
   * missing the exact traffic it exists to mirror.
   */
  drainOutbound?: () => OutboundSend[];
  /** Live status of the inbound path, for the panel to report honestly. */
  inboundStatus?: () => InboundReport;
}

export interface OutboundSend {
  at: string;
  text: string;
  delivered: boolean;
  error?: string;
}

export interface InboundReport {
  mode: string;
  detail: string;
  bot: string;
}

export interface IngestInput {
  direction: "outbound" | "inbound";
  text: string;
  kind?: TelegramMessage["kind"];
  at?: string;
}

export class TelegramFeed {
  private readonly messages: TelegramMessage[] = [];
  private seq = 0;
  private ingestedCount = 0;
  private attached = false;
  private observedAlertAt: string | undefined;
  private observedStatus: AlertState["lastStatus"] = "ok";
  /** Text of the alert we last predicted, promoted verbatim once the watchdog fires. */
  private queuedText: string | undefined;

  constructor(private readonly opts: TelegramFeedOptions) {}

  /** Append a message the real gateway actually carried. */
  ingest(input: IngestInput): TelegramMessage {
    const message = this.push({
      at: input.at ?? new Date().toISOString(),
      direction: input.direction,
      origin: "gateway",
      kind: input.kind ?? (input.direction === "inbound" ? "question" : "reply"),
      text: input.text,
      delivered: true,
    });
    this.ingestedCount += 1;
    return message;
  }

  /**
   * Reconcile against the watchdog's state file and return the panel view.
   * Called once per dashboard tick.
   */
  async update(reading: EnvironmentalResult, now: Date): Promise<TelegramView> {
    const stateFound = await exists(this.opts.statePath);
    const state = await readState(this.opts.statePath);
    const summary = summarizeReading(reading);

    if (!this.attached) {
      // First tick: adopt the existing state as the baseline. Emitting messages
      // for history we did not witness would fabricate a delivery log.
      this.attached = true;
      this.observedAlertAt = state.lastAlertedAt;
      this.observedStatus = state.lastStatus;
      this.push({
        at: now.toISOString(),
        direction: "outbound",
        origin: "dashboard",
        kind: "system",
        text: stateFound
          ? `Wall display attached. Watchdog state: ${state.lastStatus.toUpperCase()}` +
            (state.lastAlertedAt ? `, last alert ${state.lastAlertedAt}.` : ", no alert on record.")
          : "Wall display attached. No watchdog state file yet -- the cron job has not run since install.",
        delivered: true,
      });
    } else {
      this.reconcile(state, summary, now);
    }

    // Real pushes the server made since the last tick. Drained every tick,
    // including the first, so a challenge fired during startup is not lost.
    this.drainOutbound();

    const decision = decideAlert({
      currentStatus: reading.status,
      previous: state,
      now,
      summary,
    });

    let pending: TelegramMessage | undefined;
    if (decision.shouldAlert && decision.message) {
      this.queuedText = decision.message;
      pending = {
        id: PENDING_ID,
        at: now.toISOString(),
        direction: "outbound",
        origin: "watchdog",
        kind: decision.kind === "recovered" ? "recovery" : "alert",
        status: reading.status,
        text: decision.message,
        delivered: false,
      };
    } else {
      this.queuedText = undefined;
    }

    const lastAlertMs = state.lastAlertedAt ? Date.parse(state.lastAlertedAt) : Number.NaN;

    return {
      botLabel: this.opts.botLabel,
      chatTitle: this.opts.chatTitle,
      messages: [...this.messages],
      watchdog: {
        statePath: this.opts.statePath,
        stateFound,
        lastStatus: state.lastStatus,
        ...(state.lastAlertedAt ? { lastAlertedAt: state.lastAlertedAt } : {}),
        ...(Number.isNaN(lastAlertMs)
          ? {}
          : { lastAlertAgeSeconds: Math.max(0, Math.round((now.getTime() - lastAlertMs) / 1000)) }),
      },
      ...(pending ? { pending } : {}),
      inbound: this.opts.inboundStatus?.() ?? {
        mode: "off",
        detail:
          "Inbound polling is not configured, so questions typed on the phone do not reach this panel. " +
          "Set TELEGRAM_WALL_BOT_TOKEN (a second bot), or POST them to /api/telegram.",
        bot: "none",
      },
      ingestUrl: this.opts.ingestUrl,
      ingestedCount: this.ingestedCount,
    };
  }

  /**
   * Move real outbound pushes onto the panel.
   *
   * `delivered` comes from whether the Telegram API call actually succeeded, so
   * a send that failed with the WiFi off shows as an undelivered bubble instead
   * of quietly claiming the on-call was paged.
   */
  private drainOutbound(): void {
    const drain = this.opts.drainOutbound;
    if (!drain) return;
    for (const send of drain()) {
      this.push({
        at: send.at,
        direction: "outbound",
        origin: "gateway",
        kind: "alert",
        text: send.delivered ? send.text : `${send.text}\n\n[not delivered: ${send.error ?? "send failed"}]`,
        delivered: send.delivered,
      });
      this.ingestedCount += 1;
    }
  }

  /**
   * Turn a change in the watchdog's state file into a delivered message.
   *
   * A threshold alert bumps `lastAlertedAt`; a recovery clears it and drops
   * `lastStatus` back to ok, so recovery has to be detected from the status
   * transition instead -- watching `lastAlertedAt` alone would miss it.
   */
  private reconcile(state: AlertState, summary: string, now: Date): void {
    const alertedAtChanged =
      state.lastAlertedAt !== undefined && state.lastAlertedAt !== this.observedAlertAt;
    const recovered = this.observedStatus !== "ok" && state.lastStatus === "ok";

    if (alertedAtChanged) {
      this.push({
        at: state.lastAlertedAt ?? now.toISOString(),
        direction: "outbound",
        origin: "watchdog",
        kind: "alert",
        status: state.lastStatus,
        // The queued text is the exact string the tick would have produced; fall
        // back to a reconstruction only if the wall came up mid-incident.
        text:
          this.queuedText ??
          `Environmental status is now ${state.lastStatus.toUpperCase()}. ${summary}`,
        delivered: true,
      });
    } else if (recovered) {
      this.push({
        at: now.toISOString(),
        direction: "outbound",
        origin: "watchdog",
        kind: "recovery",
        status: "ok",
        text:
          this.queuedText ??
          `Environmental status has recovered to OK (was ${this.observedStatus.toUpperCase()}). ${summary}`,
        delivered: true,
      });
    }

    this.observedAlertAt = state.lastAlertedAt;
    this.observedStatus = state.lastStatus;
  }

  private push(message: Omit<TelegramMessage, "id">): TelegramMessage {
    this.seq += 1;
    const withId: TelegramMessage = { id: `msg-${this.seq}`, ...message };
    this.messages.push(withId);
    if (this.messages.length > MESSAGE_LIMIT) this.messages.shift();
    return withId;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
