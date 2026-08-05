import type { AccessEvent } from "./types.js";

/**
 * Push an access challenge to the on-call phone over the messaging gateway.
 *
 * **Notification only. This never carries the authorisation.** The photo and the
 * question go out over the relay; the decision is taken on the local page over
 * the tailnet, because a third-party messaging service is not somewhere physical
 * datacenter access should be granted from. Same layering argument as the
 * swappable notifier in POSITIONING.md §3, applied to consent.
 *
 * ## Fire and forget, and why that is not laziness
 *
 * This runs off the dashboard's 2s tick, and the watchdog on this project has
 * already been killed once by a blocking call it trusted (PROGRESS.md NEXT 6 --
 * nine dead ticks over ~50 minutes). So:
 *
 *   - `notifyChallenge` returns immediately and is never awaited by a render path.
 *   - The request is bounded by an AbortController, not by hope.
 *   - Every failure is swallowed after being logged. **A dead network must look
 *     exactly like a quiet one**, because during the WiFi-off demo beat it will
 *     be a dead network, and an error toast on the wall at that moment would
 *     undo the point the beat exists to make.
 *
 * Silent no-op when the token or chat id is unset, which is the default. Nothing
 * about the access loop depends on this working.
 */

const TIMEOUT_MS = 5000;
/** One notification per challenge id -- a 2s tick must not become a 2s pager. */
const notified = new Set<string>();

export interface NotifyConfig {
  botToken?: string;
  chatId?: string;
}

export function notifyConfig(): NotifyConfig {
  return {
    ...(process.env.TELEGRAM_BOT_TOKEN ? { botToken: process.env.TELEGRAM_BOT_TOKEN } : {}),
    ...(process.env.TELEGRAM_CHAT_ID ? { chatId: process.env.TELEGRAM_CHAT_ID } : {}),
  };
}

/** The message text. Exported so a test can assert wording without a network. */
export function challengeText(event: AccessEvent): string {
  const unknown = event.faces.filter((f) => f.match === "unknown").length;
  const known = event.faces.filter((f) => f.match === "known").map((f) => f.name).filter(Boolean);

  const who =
    event.faces.length === 0
      ? "Someone is at the rack and has not been identified"
      : unknown > 0
        ? `${unknown} unidentified ${unknown === 1 ? "person" : "people"} at the rack` +
          (known.length > 0 ? ` (with ${known.join(", ")})` : "")
        : `${known.join(", ")} at the rack`;

  return [
    `ACCESS ${event.severity.toUpperCase()} - ${event.zone}`,
    who,
    ...event.reasons.map((r) => `- ${r}`),
    "",
    "Approve or deny on the access terminal. This message cannot authorise entry.",
  ].join("\n");
}

/**
 * Send, if configured. Returns immediately; resolves to whether a send was
 * attempted, which is only ever used by tests.
 */
export function notifyChallenge(event: AccessEvent, config = notifyConfig()): boolean {
  if (!config.botToken || !config.chatId) return false;
  if (notified.has(event.id)) return false;
  notified.add(event.id);
  // Bound the set: one entry per visit, and the audit log is capped at 50 anyway.
  if (notified.size > 200) notified.clear();

  void send(config.botToken, config.chatId, challengeText(event)).catch((err: unknown) => {
    // Logged to stderr and then dropped. See the note above: during the
    // WiFi-off beat this WILL fail, and it must be invisible.
    console.error("[access] telegram notify failed (ignored):", err);
  });
  return true;
}

async function send(token: string, chatId: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`telegram responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: forget which challenges have been notified. */
export function resetNotifications(): void {
  notified.clear();
}
