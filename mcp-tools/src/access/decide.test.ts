import { describe, it, expect } from "vitest";
import { decideAccess, shouldSuppressPage, type DecideAccessInput } from "./decide.js";
import type { ChannelView } from "../dashboard/types.js";
import type { FaceMatch } from "./types.js";

const present = (heldSeconds = 5): ChannelView => ({
  state: "present",
  observed: true,
  heldSeconds,
  since: "2026-08-04T21:00:00.000Z",
});
const clear: ChannelView = { state: "clear", observed: true, heldSeconds: 300 };
const unobserved: ChannelView = { state: "unknown", observed: false };
const doorSeen: ChannelView = { state: "closed", observed: true, heldSeconds: 30 };

const known = (name: string): FaceMatch => ({ match: "known", name, similarity: 0.72 });
const stranger: FaceMatch = { match: "unknown", name: null, similarity: 0.14 };

const base: DecideAccessInput = {
  presence: present(),
  door: doorSeen,
  doorOpenCount: 1,
  faces: [],
  identityMethod: "face-npu",
  captured: false,
};

const incident = { risk: "high", cause: "rack temperature rising", status: "critical" as const };

describe("shouldSuppressPage -- escalation always wins", () => {
  // Written first, on purpose. Suppression exists to reduce noise and its failure
  // mode is swallowing a real page, so this is the test the feature is allowed to
  // exist because of.
  it("suppresses a repeat page at the same status when a known responder is on site", () => {
    expect(
      shouldSuppressPage({
        access: { suppressesEscalation: true },
        current: "warning",
        lastPagedStatus: "warning",
      }),
    ).toBe(true);
  });

  it("REFUSES to suppress when the status escalated after they arrived", () => {
    expect(
      shouldSuppressPage({
        access: { suppressesEscalation: true },
        current: "critical",
        lastPagedStatus: "warning",
      }),
    ).toBe(false);
  });

  it("never suppresses when the access verdict did not ask for it", () => {
    expect(
      shouldSuppressPage({
        access: { suppressesEscalation: false },
        current: "warning",
        lastPagedStatus: "warning",
      }),
    ).toBe(false);
  });

  it("suppresses a de-escalation (ok after a warning page) rather than re-paging", () => {
    expect(
      shouldSuppressPage({
        access: { suppressesEscalation: true },
        current: "ok",
        lastPagedStatus: "warning",
      }),
    ).toBe(true);
  });
});

describe("decideAccess -- presence gating", () => {
  it("is idle when nobody is present", () => {
    const r = decideAccess({ ...base, presence: clear });
    expect(r.verdict).toBe("idle");
    expect(r.severity).toBe("ok");
    expect(r.approvalRequired).toBe(false);
  });

  it("does not invent a challenge from an unobserved presence channel", () => {
    const r = decideAccess({ ...base, presence: unobserved });
    expect(r.verdict).toBe("idle");
    // The distinction matters: "unknown" must not render as "clear".
    expect(r.reasons.join(" ")).toMatch(/unknown, not clear/);
  });

  it("stays calm inside the capture grace period", () => {
    const r = decideAccess({ ...base, presence: present(10) });
    expect(r.verdict).toBe("pending-capture");
    expect(r.severity).toBe("ok");
  });

  it("treats an unanswered challenge as the alarm once grace lapses", () => {
    const r = decideAccess({ ...base, presence: present(120) });
    expect(r.verdict).toBe("pending-capture");
    expect(r.severity).toBe("warning");
    expect(r.reasons.join(" ")).toMatch(/unanswered for 120s/);
  });

  it("flags a capture that resolved no face at all", () => {
    const r = decideAccess({ ...base, captured: true, faces: [] });
    expect(r.verdict).toBe("pending-capture");
    expect(r.severity).toBe("warning");
    expect(r.reasons.join(" ")).toMatch(/no detectable face/);
  });

  it("escalates a non-cooperating person to CRITICAL during a live incident", () => {
    // The cheapest way past this system used to be simply refusing to be
    // photographed: pending-capture capped at warning and never asked for a
    // decision, so there was nothing for a human to deny.
    const r = decideAccess({
      ...base,
      presence: present(120),
      concurrentIncident: incident,
    });
    expect(r.verdict).toBe("pending-capture");
    expect(r.severity).toBe("critical");
    expect(r.approvalRequired).toBe(true);
    expect(r.reasons[0]).toMatch(/not answering the challenge/);
  });

  it("asks for a decision once the grace lapses, even with no incident", () => {
    const r = decideAccess({ ...base, presence: present(120) });
    expect(r.severity).toBe("warning");
    expect(r.approvalRequired).toBe(true);
  });

  it("still stays calm and asks nothing inside the grace period", () => {
    const r = decideAccess({ ...base, presence: present(5), concurrentIncident: incident });
    expect(r.severity).toBe("ok");
    expect(r.approvalRequired).toBe(false);
  });
});

describe("decideAccess -- the matrix", () => {
  it("known person, ordinary conditions -> clear and silent", () => {
    const r = decideAccess({ ...base, captured: true, faces: [known("Lauren R")] });
    expect(r.verdict).toBe("clear");
    expect(r.severity).toBe("ok");
    expect(r.approvalRequired).toBe(false);
    expect(r.suppressesEscalation).toBe(false);
  });

  it("known person DURING an incident -> expected, and it suppresses", () => {
    // The negative control. This is the row that makes the system quieter, and
    // the one that distinguishes judgement from a threshold.
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R")],
      concurrentIncident: incident,
    });
    expect(r.verdict).toBe("expected");
    expect(r.severity).toBe("ok");
    expect(r.suppressesEscalation).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/on-call responding/);
  });

  it("unknown person, ordinary conditions -> challenge, approval required", () => {
    const r = decideAccess({ ...base, captured: true, faces: [stranger] });
    expect(r.verdict).toBe("challenge");
    expect(r.severity).toBe("warning");
    expect(r.approvalRequired).toBe(true);
  });

  it("unknown person DURING an incident -> critical, worse than either alone", () => {
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [stranger],
      concurrentIncident: incident,
    });
    expect(r.verdict).toBe("unauthorized-during-incident");
    expect(r.severity).toBe("critical");
    expect(r.approvalRequired).toBe(true);
    // Both facts must survive into the narration, not just the headline.
    expect(r.reasons.join(" ")).toMatch(/not on the roster/);
    expect(r.reasons.join(" ")).toMatch(/incident is live/);
  });

  it("present with no door edge -> anti-passback", () => {
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R")],
      doorOpenCount: 0,
    });
    expect(r.verdict).toBe("anti-passback");
    expect(r.severity).toBe("warning");
    expect(r.doorConsistent).toBe(false);
  });

  it("does not claim anti-passback when the door channel was never observed", () => {
    // An unobserved door is not a closed door. Same rule the wall already applies.
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R")],
      door: unobserved,
      doorOpenCount: 0,
    });
    expect(r.verdict).toBe("clear");
    expect(r.doorConsistent).toBeUndefined();
  });

  it("reports doorConsistent TRUE on the ordinary clear path", () => {
    // This passed vacuously before: the `clear` branch was the one return that
    // dropped `...door`, so the most common good case reported `undefined` --
    // "we could not tell" -- for an episode where the door was observed and did
    // open. The test above still passed, because it only ever asserted undefined.
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R")],
      door: doorSeen,
      doorOpenCount: 1,
    });
    expect(r.verdict).toBe("clear");
    expect(r.doorConsistent).toBe(true);
  });

  it("carries doorConsistent on every post-capture verdict", () => {
    // Evidence about the episode must survive whichever branch wins; dropping it
    // on some paths and not others is how a display disagrees with itself.
    const cases: Array<[string, DecideAccessInput]> = [
      ["clear", { ...base, captured: true, faces: [known("A")], doorOpenCount: 1 }],
      ["expected", { ...base, captured: true, faces: [known("A")], doorOpenCount: 1, concurrentIncident: incident }],
      ["challenge", { ...base, captured: true, faces: [stranger], doorOpenCount: 1 }],
      ["tailgating", { ...base, captured: true, faces: [known("A"), stranger], doorOpenCount: 1 }],
    ];
    for (const [label, input] of cases) {
      const r = decideAccess(input);
      expect(r.verdict, label).toBe(label);
      expect(r.doorConsistent, label).toBe(true);
    }
  });

  it("two faces against one authorised entry -> tailgating, critical", () => {
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R"), stranger],
      doorOpenCount: 1,
    });
    expect(r.verdict).toBe("tailgating");
    expect(r.severity).toBe("critical");
    expect(r.approvalRequired).toBe(true);
    expect(r.reasons[0]).toMatch(/2 present against 1 authorised entry/);
  });

  it("two faces against two entries is not tailgating", () => {
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R"), known("Chris G")],
      doorOpenCount: 2,
    });
    expect(r.verdict).toBe("clear");
  });

  it("tailgating outranks unauthorized-during-incident when both are true", () => {
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [known("Lauren R"), stranger],
      doorOpenCount: 1,
      concurrentIncident: incident,
    });
    expect(r.verdict).toBe("tailgating");
    // ...but the incident context is not lost.
    expect(r.reasons.join(" ")).toMatch(/incident is live/);
  });

  it("never suppresses while an unknown face is present", () => {
    // Belt and braces: suppression plus a stranger would be the worst possible bug.
    for (const concurrentIncident of [undefined, incident]) {
      const r = decideAccess({
        ...base,
        captured: true,
        faces: [known("Lauren R"), stranger],
        doorOpenCount: 2,
        ...(concurrentIncident ? { concurrentIncident } : {}),
      });
      expect(r.suppressesEscalation).toBe(false);
    }
  });
});

describe("decideAccess -- identity ladder", () => {
  it("says plainly when identity was not resolved at all", () => {
    // Rung 3: detection only. Everyone reads as unknown, and the record must not
    // let that pass as a genuine non-match.
    const r = decideAccess({
      ...base,
      captured: true,
      faces: [stranger],
      identityMethod: "face-detect-only",
    });
    expect(r.verdict).toBe("challenge");
    expect(r.reasons.join(" ")).toMatch(/detection-only/);
  });

  it("produces the same verdict from a QR badge as from a face", () => {
    // The ladder is a risk control: the loop downstream must not care which rung
    // produced the identity.
    const face = decideAccess({ ...base, captured: true, faces: [stranger], identityMethod: "face-npu" });
    const badge = decideAccess({ ...base, captured: true, faces: [stranger], identityMethod: "qr-badge" });
    expect(badge.verdict).toBe(face.verdict);
    expect(badge.severity).toBe(face.severity);
    expect(badge.approvalRequired).toBe(face.approvalRequired);
  });
});
