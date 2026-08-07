import { describe, it, expect } from "vitest";
import { evaluateSuppression } from "./suppress.js";
import type { AccessEvent, AccessState } from "../access/types.js";

/**
 * These tests exist because the rule they cover was dead code.
 *
 * `shouldSuppressPage` was written, tested first, and never called: nothing in
 * the paging chain imported `access/`. The guard was correct and inert. What is
 * tested here is the *connection* -- that a held page is genuinely held, that it
 * is only ever deferred, and above all that it fails open.
 */

const T0 = new Date("2026-08-05T12:00:00.000Z");
const at = (offsetS: number): Date => new Date(T0.getTime() + offsetS * 1000);

function accessState(over: {
  verdict?: AccessEvent["verdict"];
  updatedAt?: string | undefined;
  pending?: boolean;
  name?: string;
} = {}): AccessState {
  const pending: AccessEvent = {
    id: "acc_20260805T120000Z",
    at: T0.toISOString(),
    zone: "zone-east",
    trigger: "object_entered",
    faces: [{ match: "known", name: over.name ?? "Lauren R", similarity: 0.81 }],
    identityMethod: "qr-badge",
    doorOpenCount: 1,
    verdict: over.verdict ?? "expected",
    severity: "ok",
    reasons: [],
    approval: { required: false, state: "not-required" },
  };
  return {
    ...(over.pending === false ? {} : { pending }),
    log: [],
    ...("updatedAt" in over ? { updatedAt: over.updatedAt } : { updatedAt: T0.toISOString() }),
  } as AccessState;
}

describe("evaluateSuppression -- fail open", () => {
  // Every branch here answers the same question: when in doubt, does it page?
  // The failure mode of this feature is silence, so "no" is never acceptable.

  it("pages when there is no access state at all", () => {
    const r = evaluateSuppression({
      access: undefined,
      currentStatus: "critical",
      now: at(5),
    });
    expect(r.hold).toBe(false);
    expect(r.reason).toMatch(/no access state/);
  });

  it("pages when the access state is stale -- the dashboard may be dead", () => {
    // This is the important one. Suppression depends on a different process
    // staying alive; a stale file means the sentry stopped, not that all is calm.
    const r = evaluateSuppression({
      access: accessState(),
      currentStatus: "critical",
      now: at(600),
    });
    expect(r.hold).toBe(false);
    expect(r.reason).toMatch(/600s old/);
    expect(r.reason).toMatch(/dashboard may be down/);
  });

  it("pages when the state carries no update stamp", () => {
    const r = evaluateSuppression({
      access: accessState({ updatedAt: undefined }),
      currentStatus: "critical",
      now: at(5),
    });
    expect(r.hold).toBe(false);
    expect(r.reason).toMatch(/no update stamp/);
  });

  it("pages when nobody is at the rack", () => {
    const r = evaluateSuppression({
      access: accessState({ pending: false }),
      currentStatus: "critical",
      now: at(5),
    });
    expect(r.hold).toBe(false);
    expect(r.reason).toMatch(/nobody at the rack/);
  });

  it.each(["challenge", "tailgating", "unauthorized-during-incident", "anti-passback", "clear", "pending-capture"] as const)(
    "pages when the verdict is %s, not 'expected'",
    (verdict) => {
      const r = evaluateSuppression({
        access: accessState({ verdict }),
        currentStatus: "critical",
          now: at(5),
      });
      expect(r.hold).toBe(false);
    },
  );
});

describe("evaluateSuppression -- holding", () => {
  it("holds when a known responder is on site at the same status", () => {
    const r = evaluateSuppression({
      access: accessState(),
      currentStatus: "critical",
      now: at(30),
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toMatch(/Lauren R is on site/);
    expect(r.reason).toMatch(/already responding/);
  });

  it("REFUSES to hold when the status escalated after they arrived", () => {
    // The rule the whole feature is allowed to exist because of. Being on site
    // means you know about what you were paged for -- not about something that
    // had not happened yet when you got there.
    const r = evaluateSuppression({
      access: accessState(),
      currentStatus: "critical",
      heldStatus: "warning",
      now: at(30),
    });
    expect(r.hold).toBe(false);
    expect(r.reason).toMatch(/escalated from warning to critical/);
    // Flagged, not just described. tick.ts has to tell this apart from "the
    // responder left" to word the page correctly, and matching on prose would
    // make the wording of a reason string load-bearing.
    expect(r.escalatedPastResponder).toBe(true);
  });

  it("does not flag an escalation when the hold simply was not earned", () => {
    // Every other no-hold path -- stale state, wrong verdict, nobody there --
    // must leave the flag unset, or a page released because the responder walked
    // away would be announced as a deterioration that never happened.
    for (const r of [
      evaluateSuppression({ access: undefined, currentStatus: "critical", now: at(5) }),
      evaluateSuppression({ access: accessState(), currentStatus: "critical", now: at(600) }),
      evaluateSuppression({ access: accessState({ verdict: "challenge" }), currentStatus: "critical", now: at(30) }),
      evaluateSuppression({ access: accessState({ pending: false }), currentStatus: "critical", now: at(30) }),
    ]) {
      expect(r.hold).toBe(false);
      expect(r.escalatedPastResponder).toBeUndefined();
    }
  });

  it("holds right up to the staleness boundary and pages past it", () => {
    const args = {
      access: accessState(),
      currentStatus: "critical" as const,
      maxAgeSeconds: 180,
    };
    expect(evaluateSuppression({ ...args, now: at(179) }).hold).toBe(true);
    expect(evaluateSuppression({ ...args, now: at(181) }).hold).toBe(false);
  });

  it("names the responder from the roster match, not a placeholder", () => {
    const r = evaluateSuppression({
      access: accessState({ name: "Chris G" }),
      currentStatus: "warning",
      now: at(10),
    });
    expect(r.reason).toMatch(/Chris G/);
  });
});
