/**
 * The one place this project talks to Telegram's send API.
 *
 * Extracted from access/notify.ts when the watchdog loop needed to deliver its
 * own pages: the access sentry and the watchdog now send from two different
 * processes, and two copies of "post to sendMessage with a timeout" would drift
 * -- most likely in the error handling, which is the part that has to be right
 * during the WiFi-off beat.
 *
 * Deliberately NOT a client object: there is no connection to pool, no state to
 * keep, and a bare function is what makes it safe to call from a fire-and-forget
 * path that must never be awaited by a render loop.
 */

/** A send that hangs is a tick that never finishes. Bound it. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

/**
 * Credentials, or undefined when this deployment has none.
 *
 * Undefined is a supported, documented state -- not a misconfiguration. Anyone
 * who clones the repo has no bot, and every caller here degrades to a silent
 * no-op rather than an error, exactly as access/notify.ts always has.
 */
export function telegramCredentials(env: NodeJS.ProcessEnv = process.env): TelegramCredentials | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId };
}

export interface SendOptions {
  timeoutMs?: number;
  /** Test injection point; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the API origin, for a stub server in tests. */
  apiBase?: string;
}

/**
 * Post one message. Rejects on any failure -- transport, timeout, or a non-2xx
 * from Telegram.
 *
 * Rejecting rather than swallowing is deliberate even though every current
 * caller catches: the caller is the only layer that knows whether a failed send
 * should be recorded as undelivered (the wall), retried, or ignored. A helper
 * that quietly returned success on failure would make an undelivered page
 * indistinguishable from a delivered one, which is the single property the
 * phone panel's honesty rules depend on.
 */
export async function sendTelegramMessage(
  credentials: TelegramCredentials,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? "https://api.telegram.org";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/bot${credentials.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: credentials.chatId, text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`telegram responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
