/**
 * Inbound Telegram: what the on-call actually types on the phone.
 *
 * ## Why this needs a flag instead of just working
 *
 * Telegram's `getUpdates` is **single-consumer per bot token**. If two processes
 * long-poll the same bot, Telegram answers one of them with
 * `409 Conflict: terminated by other getUpdates request` and the two starve each
 * other. `hermes gateway` long-polls `TELEGRAM_BOT_TOKEN` for the whole demo --
 * that is how a question from the phone reaches the agent at all.
 *
 * So a wall display that polled the same token by default would look like it was
 * working while quietly eating the questions the agent needed to answer. That is
 * the worst possible failure here: a display that breaks the thing it depicts.
 *
 * Three ways to get inbound traffic, in order of preference:
 *
 *   1. `TELEGRAM_WALL_BOT_TOKEN` -- a **second bot**, dedicated to the wall. No
 *      conflict, because nothing else polls it. Message that bot from the phone
 *      and it appears on the panel immediately.
 *   2. `POST /api/telegram` -- push messages in from whatever already has them.
 *      Exact, no polling, no conflict.
 *   3. `TELEGRAM_POLL=1` with the shared `TELEGRAM_BOT_TOKEN` -- only when the
 *      Hermes gateway is **not** running. On a 409 this poller shuts itself down
 *      permanently and says why, rather than fighting for updates.
 */

/** `off` = not configured. `starting`/`live` = polling. The rest are terminal. */
export type InboundMode = "off" | "starting" | "live" | "conflict" | "error";

export interface InboundStatus {
  mode: InboundMode;
  detail: string;
  /** Which bot the poller is attached to -- "dedicated" never conflicts. */
  bot: "dedicated" | "shared" | "none";
}

export interface InboundMessage {
  text: string;
  at: string;
  from: string;
}

export interface TelegramPollerOptions {
  token: string;
  bot: "dedicated" | "shared";
  /** Numeric Telegram user ids allowed to appear on the wall. Empty = allow all. */
  allowedUsers?: string[];
  onMessage: (message: InboundMessage) => void;
  /** Overridable so the long-poll loop can be exercised against a local stub. */
  apiBase?: string;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

/** Telegram caps long-poll at 50s; 25 keeps the socket well inside any idle timeout. */
const LONG_POLL_S = 25;
const REQUEST_TIMEOUT_MS = (LONG_POLL_S + 10) * 1000;
/** Backoff after a transport error, so a laptop with the WiFi off doesn't spin. */
const RETRY_MS = 5000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    date?: number;
    text?: string;
    from?: { id?: number; first_name?: string; username?: string };
  };
}

export class TelegramPoller {
  private offset: number | undefined;
  private stopped = false;
  private status: InboundStatus;

  constructor(private readonly opts: TelegramPollerOptions) {
    this.status = {
      mode: "starting",
      detail: "connecting to Telegram",
      bot: opts.bot,
    };
  }

  getStatus(): InboundStatus {
    return { ...this.status };
  }

  /** Fire-and-forget loop. Never throws into the caller. */
  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    // Skip the backlog once, so starting the wall mid-demo doesn't replay an
    // hour of old chat as if it were arriving now.
    await this.primeOffset();

    while (!this.stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.fetchUpdates(LONG_POLL_S);
      } catch (err) {
        if (err instanceof ConflictError) {
          // Terminal on purpose. Retrying would keep stealing updates from the
          // Hermes gateway, which is exactly the harm this guard exists to stop.
          this.status = {
            mode: "conflict",
            detail:
              "another getUpdates consumer owns this bot (almost certainly `hermes gateway`). " +
              "Inbound polling stopped so it does not steal the agent's messages. " +
              "Use TELEGRAM_WALL_BOT_TOKEN with a second bot, or POST /api/telegram.",
            bot: this.opts.bot,
          };
          return;
        }
        this.status = {
          mode: "error",
          detail: err instanceof Error ? err.message : String(err),
          bot: this.opts.bot,
        };
        await delay(RETRY_MS);
        continue;
      }

      this.status = { mode: "live", detail: "long-polling getUpdates", bot: this.opts.bot };

      for (const update of updates) {
        this.offset = update.update_id + 1;
        const message = this.toInbound(update);
        if (message) this.opts.onMessage(message);
      }
    }
  }

  /**
   * `offset=-1` returns the most recent update *without* confirming the ones
   * before it, which is what makes this safe to call before we know whether we
   * are even allowed to poll: a 409 here costs the gateway nothing.
   */
  private async primeOffset(): Promise<void> {
    try {
      const updates = await this.fetchUpdates(0, -1);
      const last = updates[updates.length - 1];
      if (last) this.offset = last.update_id + 1;
      this.status = { mode: "live", detail: "long-polling getUpdates", bot: this.opts.bot };
    } catch (err) {
      if (err instanceof ConflictError) {
        this.status = {
          mode: "conflict",
          detail:
            "another getUpdates consumer owns this bot (almost certainly `hermes gateway`). " +
            "Inbound polling stopped so it does not steal the agent's messages. " +
            "Use TELEGRAM_WALL_BOT_TOKEN with a second bot, or POST /api/telegram.",
          bot: this.opts.bot,
        };
        this.stopped = true;
        return;
      }
      // Anything else is transient; the main loop will surface and retry it.
    }
  }

  private async fetchUpdates(timeoutS: number, offsetOverride?: number): Promise<TelegramUpdate[]> {
    const offset = offsetOverride ?? this.offset;
    const params = new URLSearchParams({
      timeout: String(timeoutS),
      allowed_updates: JSON.stringify(["message"]),
    });
    if (offset !== undefined) params.set("offset", String(offset));
    if (offsetOverride !== undefined) params.set("limit", "1");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const base = this.opts.apiBase ?? DEFAULT_API_BASE;
      const res = await fetch(`${base}/bot${this.opts.token}/getUpdates?${params.toString()}`, {
        signal: controller.signal,
      });
      if (res.status === 409) throw new ConflictError();
      if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
      if (!body.ok) throw new Error(body.description ?? "Telegram returned ok:false");
      return body.result ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toInbound(update: TelegramUpdate): InboundMessage | undefined {
    const message = update.message;
    if (!message?.text) return undefined;

    const fromId = message.from?.id === undefined ? undefined : String(message.from.id);
    const allowed = this.opts.allowedUsers ?? [];
    // Same allowlist Hermes applies. Without it, anyone who finds the bot can put
    // text on a display standing in front of an audience.
    if (allowed.length > 0 && (fromId === undefined || !allowed.includes(fromId))) return undefined;

    return {
      text: message.text,
      at: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
      from: message.from?.first_name ?? message.from?.username ?? fromId ?? "unknown",
    };
  }
}

class ConflictError extends Error {
  constructor() {
    super("409 Conflict: terminated by other getUpdates request");
    this.name = "ConflictError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Decide which bot, if any, the wall may poll. Returns undefined when inbound
 * polling is not configured -- the common case, and not an error.
 */
export function resolveInboundToken(
  env: NodeJS.ProcessEnv = process.env,
): { token: string; bot: "dedicated" | "shared" } | undefined {
  const dedicated = env.TELEGRAM_WALL_BOT_TOKEN?.trim();
  if (dedicated) return { token: dedicated, bot: "dedicated" };

  const shared = env.TELEGRAM_BOT_TOKEN?.trim();
  if (shared && env.TELEGRAM_POLL === "1") return { token: shared, bot: "shared" };

  return undefined;
}

export function allowedUsers(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TELEGRAM_ALLOWED_USERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
