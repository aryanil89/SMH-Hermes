import { stat } from "node:fs/promises";
import { decideAlert } from "../alert-skill/decide-alert.js";
import { readState, type AlertState } from "../alert-skill/state-store.js";
import { summarizeReading } from "../alert-skill/summarize.js";
import type { EnvironmentalResult } from "../environmental/types.js";
import type { TelegramMessage, TelegramView } from "./types.js";
import { probeWatchRunner, type WatchRunner } from "./watch-health.js";

/**
 * What the on-call phone is showing, reconstructed from the alert pipeline
 * rather than invented for the display.
 *
 * There are three ways a message gets onto this panel, and the panel says which:
 *
 *  1. `watchdog`, recorded -- the watchdog's persisted state file changed, which
 *     means a tick *decided* to send. It is deliberately NOT rendered as
 *     delivered on that basis: the tick writes its state file before it attempts
 *     delivery (tick.ts, then watch-loop.ts), and the send failure path is
 *     swallowed so the loop survives a WiFi drop. So a changed state file with
 *     the venue WiFi down would otherwise have the wall reporting that the
 *     on-call was paged when nothing left the machine -- the exact false
 *     all-clear this panel exists to prevent. The bubble is posted unconfirmed
 *     and promoted to delivered only once the watchdog's own health endpoint
 *     reports a completed send at or after that message. See confirmDeliveries().
 *  2. `watchdog`, queued -- running the *same* `decideAlert` the watchdog runs
 *     says an alert is due right now. The wall ticks every 2s and the watchdog
 *     every 15s (watch-loop.ts) or every ~2 min (hermes cron), so the wall knows
 *     before the phone does. Rendered greyed and marked queued: the display must
 *     never claim a delivery that has not happened.
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
/**
 * Shown on a watchdog page between the state file changing and the watchdog
 * confirming the send. Normally a second or two; permanent if the send failed.
 */
const AWAITING_SUFFIX = "[sending -- delivery not yet confirmed]";

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
  /**
   * Asks which watchdog process is actually alive. Injected so tests do not open
   * a socket, and defaulted to the real loopback probe.
   */
  watchRunner?: (now: Date) => Promise<WatchRunner>;
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
  /**
   * Watchdog pages posted but not yet evidenced as delivered, oldest first.
   *
   * `text` is kept verbatim so the rendered suffix can be rewritten as the
   * verdict firms up, without ever mutating what the watchdog actually said.
   */
  private awaitingDelivery: { id: string; atMs: number; text: string }[] = [];

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
          : "Wall display attached. No watchdog state file yet -- no watchdog tick has run since install.",
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
      // Passed for the same reason the watchdog passes it: the panel's "queued"
      // bubble is a prediction of what the watchdog will do, so it has to be
      // made from the same inputs. Without this the wall would promise a page
      // off a mock reading that the watchdog will correctly refuse to send.
      readingTrusted: reading.source === "real",
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
    const runner = await (this.opts.watchRunner ?? probeWatchRunner)(now);

    // After the probe, so this tick's verdict uses this tick's health reading.
    this.confirmDeliveries(runner);

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
        runner,
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
   * Turn a change in the watchdog's state file into a recorded -- not yet
   * delivered -- message.
   *
   * A threshold alert bumps `lastAlertedAt`; a recovery clears it and drops
   * `lastStatus` back to ok, so recovery has to be detected from the status
   * transition instead -- watching `lastAlertedAt` alone would miss it.
   *
   * Both are posted with `delivered: false`. The state file only evidences that
   * a tick decided to send; confirmDeliveries() promotes the bubble once the
   * watchdog reports the send actually completed.
   */
  private reconcile(state: AlertState, summary: string, now: Date): void {
    const alertedAtChanged =
      state.lastAlertedAt !== undefined && state.lastAlertedAt !== this.observedAlertAt;
    const recovered = this.observedStatus !== "ok" && state.lastStatus === "ok";

    if (alertedAtChanged) {
      this.recordUndelivered({
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
        delivered: false,
      });
    } else if (recovered) {
      this.recordUndelivered({
        at: now.toISOString(),
        direction: "outbound",
        origin: "watchdog",
        kind: "recovery",
        status: "ok",
        text:
          this.queuedText ??
          `Environmental status has recovered to OK (was ${this.observedStatus.toUpperCase()}). ${summary}`,
        delivered: false,
      });
    }

    this.observedAlertAt = state.lastAlertedAt;
    this.observedStatus = state.lastStatus;
  }

  /** Post a watchdog page and put it in the queue awaiting delivery evidence. */
  private recordUndelivered(message: Omit<TelegramMessage, "id">): void {
    const posted = this.push({ ...message, text: `${message.text}\n\n${AWAITING_SUFFIX}` });
    const atMs = Date.parse(message.at);
    this.awaitingDelivery.push({
      id: posted.id,
      atMs: Number.isNaN(atMs) ? Date.now() : atMs,
      text: message.text,
    });
  }

  /**
   * Settle the delivery verdict on watchdog pages, from the watchdog's own
   * health endpoint rather than from the state file.
   *
   * `lastMessageAt` is set only after `sendTelegramMessage` resolves, so a value
   * at or after the page's timestamp is positive evidence that this page (or one
   * after it) left the machine. `lastDeliveryError` is set on failure and cleared
   * on the next success, so it is the current verdict, not a historical counter.
   *
   * Where the loop is not reachable at all -- the hermes cron path, or nothing
   * running -- there is no way to observe delivery from here, and the bubble
   * keeps saying so instead of guessing in either direction.
   */
  private confirmDeliveries(runner: WatchRunner): void {
    if (!this.awaitingDelivery.length) return;

    const sentUpTo = runner.lastMessageAt ? Date.parse(runner.lastMessageAt) : Number.NaN;
    const still: typeof this.awaitingDelivery = [];

    for (const entry of this.awaitingDelivery) {
      const found = this.messages.find((m) => m.id === entry.id);
      if (!found) continue; // aged out of the ring buffer

      if (!Number.isNaN(sentUpTo) && sentUpTo >= entry.atMs) {
        found.delivered = true;
        found.text = entry.text;
        continue;
      }
      if (runner.mode === "loop" && runner.canDeliver === false) {
        found.text = `${entry.text}\n\n[not delivered: watchdog has no Telegram credentials]`;
        continue; // terminal: credentials do not appear mid-run
      }
      if (runner.lastDeliveryError) {
        found.text = `${entry.text}\n\n[not delivered: ${runner.lastDeliveryError}]`;
        still.push(entry); // a later retry can still succeed
        continue;
      }
      if (runner.mode !== "loop") {
        found.text =
          `${entry.text}\n\n[recorded by the watchdog; delivery not confirmed -- ` +
          `no watch loop on the health port to report it]`;
        still.push(entry);
        continue;
      }
      found.text = `${entry.text}\n\n${AWAITING_SUFFIX}`;
      still.push(entry);
    }

    this.awaitingDelivery = still;
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
