import { describe, it, expect, beforeEach } from "vitest";
import { challengeText, notifyChallenge, resetNotifications } from "./notify.js";
import type { AccessEvent } from "./types.js";

const event = (over: Partial<AccessEvent> = {}): AccessEvent => ({
  id: "acc_20260805T120000Z",
  at: "2026-08-05T12:00:00.000Z",
  zone: "zone-east",
  trigger: "object_entered",
  faces: [{ match: "unknown", name: null, similarity: 0.12 }],
  identityMethod: "qr-badge",
  doorOpenCount: 1,
  verdict: "challenge",
  severity: "warning",
  reasons: ["1 face detected, 1 not on the roster"],
  approval: { required: true, state: "pending" },
  ...over,
});

beforeEach(() => {
  resetNotifications();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe("challengeText", () => {
  it("says plainly that the message cannot authorise entry", () => {
    // The layering claim has to survive contact with the actual bytes sent: the
    // relay carries the question, never the answer.
    expect(challengeText(event())).toMatch(/cannot authorise entry/);
  });

  it("leads with severity and zone, then who", () => {
    const text = challengeText(event());
    expect(text.split("\n")[0]).toBe("ACCESS WARNING - zone-east");
    expect(text).toMatch(/1 unidentified person at the rack/);
  });

  it("names known people and counts unknown ones together", () => {
    const text = challengeText(
      event({
        faces: [
          { match: "known", name: "Lauren R", similarity: 0.8 },
          { match: "unknown", name: null, similarity: 0.1 },
        ],
        verdict: "tailgating",
        severity: "critical",
      }),
    );
    expect(text).toMatch(/ACCESS CRITICAL/);
    expect(text).toMatch(/1 unidentified person at the rack \(with Lauren R\)/);
  });

  it("describes a capture that resolved nobody without pretending it did", () => {
    expect(challengeText(event({ faces: [] }))).toMatch(/has not been identified/);
  });

  it("carries every reason, so the phone shows the same evidence as the wall", () => {
    const text = challengeText(event({ reasons: ["reason one", "reason two"] }));
    expect(text).toMatch(/- reason one/);
    expect(text).toMatch(/- reason two/);
  });
});

describe("notifyChallenge", () => {
  it("is a silent no-op when unconfigured -- the default", () => {
    // Nothing in the access loop may depend on a messaging gateway existing.
    expect(notifyChallenge(event())).toBe(false);
  });

  it("does nothing with a token but no chat id", () => {
    expect(notifyChallenge(event(), { botToken: "t" })).toBe(false);
  });

  it("sends once per challenge, not once per tick", () => {
    // The sentry calls this from a 2s render loop. Without de-duplication a
    // person standing at a rack becomes a pager.
    const config = { botToken: "t", chatId: "c" };
    const e = event();
    expect(notifyChallenge(e, config)).toBe(true);
    expect(notifyChallenge(e, config)).toBe(false);
    expect(notifyChallenge(e, config)).toBe(false);
  });

  it("treats a new challenge as a new notification", () => {
    const config = { botToken: "t", chatId: "c" };
    expect(notifyChallenge(event({ id: "acc_a" }), config)).toBe(true);
    expect(notifyChallenge(event({ id: "acc_b" }), config)).toBe(true);
  });

  it("returns synchronously and never throws, even with no network", () => {
    // The WiFi-off beat guarantees this call fails. It must be invisible.
    const config = { botToken: "not-a-real-token", chatId: "0" };
    expect(() => notifyChallenge(event(), config)).not.toThrow();
  });
});
