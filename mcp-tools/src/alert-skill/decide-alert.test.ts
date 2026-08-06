import { describe, it, expect } from "vitest";
import { decideAlert } from "./decide-alert.js";
import type { AlertState } from "./state-store.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("decideAlert", () => {
  it("does not alert while status stays ok", () => {
    const previous: AlertState = { lastStatus: "ok" };
    const result = decideAlert({ currentStatus: "ok", previous, now: NOW, summary: "fine" });
    expect(result.shouldAlert).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.nextState.lastStatus).toBe("ok");
  });

  it("alerts on ok -> warning (a crossing)", () => {
    const previous: AlertState = { lastStatus: "ok" };
    const result = decideAlert({ currentStatus: "warning", previous, now: NOW, summary: "getting warm" });
    expect(result.shouldAlert).toBe(true);
    expect(result.kind).toBe("threshold-crossed");
    expect(result.message).toContain("WARNING");
    expect(result.nextState).toEqual({ lastStatus: "warning", lastAlertedAt: NOW.toISOString() });
  });

  it("alerts on warning -> critical (a further crossing)", () => {
    const previous: AlertState = { lastStatus: "warning", lastAlertedAt: "2026-08-03T11:00:00.000Z" };
    const result = decideAlert({ currentStatus: "critical", previous, now: NOW, summary: "leak!" });
    expect(result.shouldAlert).toBe(true);
    expect(result.kind).toBe("threshold-crossed");
    expect(result.nextState.lastStatus).toBe("critical");
  });

  it("does not re-alert immediately while stuck at the same bad level (cooldown)", () => {
    const previous: AlertState = { lastStatus: "critical", lastAlertedAt: "2026-08-03T11:55:00.000Z" }; // 5 min ago
    const result = decideAlert({
      currentStatus: "critical",
      previous,
      now: NOW,
      summary: "still bad",
      cooldownMs: 60 * 60 * 1000,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.nextState.lastStatus).toBe("critical");
    // lastAlertedAt is preserved, not bumped, since no alert fired.
    expect(result.nextState.lastAlertedAt).toBe("2026-08-03T11:55:00.000Z");
  });

  it("re-alerts once the cooldown has elapsed while still at the same bad level", () => {
    const previous: AlertState = { lastStatus: "critical", lastAlertedAt: "2026-08-03T10:00:00.000Z" }; // 2h ago
    const result = decideAlert({
      currentStatus: "critical",
      previous,
      now: NOW,
      summary: "still bad",
      cooldownMs: 60 * 60 * 1000,
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.nextState.lastAlertedAt).toBe(NOW.toISOString());
  });

  it("emits a one-time recovered alert on critical -> ok", () => {
    const previous: AlertState = { lastStatus: "critical", lastAlertedAt: "2026-08-03T11:00:00.000Z" };
    const result = decideAlert({ currentStatus: "ok", previous, now: NOW, summary: "back to normal" });
    expect(result.shouldAlert).toBe(true);
    expect(result.kind).toBe("recovered");
    expect(result.message).toContain("recovered");
    expect(result.nextState).toEqual({ lastStatus: "ok", lastAlertedAt: undefined });
  });

  it("never alerts twice for the same recovery", () => {
    const previous: AlertState = { lastStatus: "ok", lastAlertedAt: undefined };
    const result = decideAlert({ currentStatus: "ok", previous, now: NOW, summary: "fine" });
    expect(result.shouldAlert).toBe(false);
  });

  /**
   * The regression these guard. Observed live on 2026-08-05: the sensor log was
   * locked mid-replace for a single tick, the reading fell back to the mock
   * generator (healthy by construction), and the watchdog paged "recovered to
   * OK" while the rack was at 35 C / 86% humidity.
   */
  describe("untrusted (mock) readings are inert", () => {
    it("does not page a false recovery when the reading is synthesised", () => {
      const previous: AlertState = { lastStatus: "critical", lastAlertedAt: "2026-08-03T11:00:00.000Z" };
      const result = decideAlert({
        currentStatus: "ok", // what the mock generator happened to produce
        previous,
        now: NOW,
        summary: "20.0 C, 37% (mock data)",
        readingTrusted: false,
      });
      expect(result.shouldAlert).toBe(false);
      expect(result.kind).toBe("untrusted-reading");
    });

    it("carries the previous state forward verbatim, so the real crossing is still un-notified", () => {
      const previous: AlertState = { lastStatus: "critical", lastAlertedAt: "2026-08-03T11:00:00.000Z" };
      const result = decideAlert({
        currentStatus: "ok",
        previous,
        now: NOW,
        summary: "mock",
        readingTrusted: false,
      });
      // Not advanced and not cleared: the next trusted tick still sees critical
      // as the last notified level, so an escalation is still an escalation.
      expect(result.nextState).toEqual({
        lastStatus: "critical",
        lastAlertedAt: "2026-08-03T11:00:00.000Z",
      });
    });

    it("also refuses to RAISE an alarm from a synthesised reading", () => {
      const previous: AlertState = { lastStatus: "ok" };
      const result = decideAlert({
        currentStatus: "critical",
        previous,
        now: NOW,
        summary: "mock says critical",
        readingTrusted: false,
      });
      expect(result.shouldAlert).toBe(false);
      expect(result.nextState.lastStatus).toBe("ok");
    });

    it("defaults to trusted, so callers that do not know provenance are unchanged", () => {
      const previous: AlertState = { lastStatus: "ok" };
      const result = decideAlert({ currentStatus: "warning", previous, now: NOW, summary: "warm" });
      expect(result.shouldAlert).toBe(true);
      expect(result.kind).toBe("threshold-crossed");
    });
  });
});
