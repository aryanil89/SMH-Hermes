import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessSentry, countDoorOpensSince, incidentContext } from "./sentry.js";
import { readAccessState } from "./state.js";
import type { SensorLogView } from "../dashboard/sensor-log.js";
import type { IncidentAssessment } from "../assess/types.js";

const T0 = new Date("2026-08-04T21:00:00.000Z");
const at = (offsetS: number): Date => new Date(T0.getTime() + offsetS * 1000);

function logView(over: Partial<SensorLogView> = {}): SensorLogView {
  return {
    ok: true,
    fileSizeBytes: 1,
    windowed: false,
    linesInWindow: 1,
    doorOpenAt: [],
    door: { state: "closed", observed: true, heldSeconds: 20 },
    light: { state: "unknown", observed: false },
    presence: { state: "clear", observed: true, heldSeconds: 60 },
    climate: [],
    events: [],
    eventCounts: {},
    ...over,
  };
}

const presentSince = (since: string, heldSeconds: number): SensorLogView["presence"] => ({
  state: "present",
  observed: true,
  since,
  heldSeconds,
});

function assessment(level: IncidentAssessment["risk"]["level"], cause = "rack temperature rising"): IncidentAssessment {
  return {
    generatedAt: T0.toISOString(),
    zone: "zone-east",
    risk: { score: 50, level, familiesInvolved: [], correlationBonus: 0 },
    confidence: { level: "medium", reasons: [] },
    evidence: [],
    likelyCause: cause,
    recommendedAction: "look at it",
    provenance: { environmental: "real", simulatedInputs: false },
    summary: "",
  };
}

async function sentry(): Promise<AccessSentry> {
  const dir = await mkdtemp(join(tmpdir(), "sentry-"));
  return new AccessSentry({
    statePath: join(dir, "access.json"),
    rosterPath: join(dir, "roster.json"),
    zone: "zone-east",
    captureUrl: "http://127.0.0.1:7788/api/access/capture",
  });
}

beforeEach(() => {
  delete process.env.ACCESS_IDENTITY_METHOD;
});

describe("countDoorOpensSince", () => {
  const stamps = [at(10).toISOString(), at(-5).toISOString(), at(-600).toISOString()];

  it("counts only entries inside the episode, not the whole window", () => {
    // The 10-minute-old edge must not be credited to this visit; the one 5s
    // before it must, because that is the walk from the door to the rack.
    expect(countDoorOpensSince(stamps, T0.toISOString())).toBe(2);
  });

  it("credits a door edge that precedes presence -- the door always comes first", () => {
    // Under-counting here is what turns a normal badge-in into a false
    // TAILGATING alarm, so it is worth its own test.
    expect(countDoorOpensSince([at(-12).toISOString()], T0.toISOString())).toBe(1);
  });

  it("still excludes an edge older than the lookback", () => {
    expect(countDoorOpensSince([at(-45).toISOString()], T0.toISOString())).toBe(0);
  });

  it("is zero without an episode start", () => {
    expect(countDoorOpensSince(stamps, undefined)).toBe(0);
  });

  it("reads a dedicated window, not the capped display feed", () => {
    // `events` is truncated to EVENT_LIMIT for the feed pane. A security count
    // fed from it can lose the real door edge to ToF chatter and then report
    // anti-passback at someone who badged in normally.
    const many = Array.from({ length: 200 }, (_, i) => at(-i / 10).toISOString());
    expect(countDoorOpensSince(many, T0.toISOString())).toBe(200);
  });
});

describe("incidentContext", () => {
  it("treats a low-risk assessment as no incident at all", () => {
    expect(incidentContext(assessment("low"))).toBeUndefined();
  });

  it("maps medium to warning and high/critical to critical", () => {
    expect(incidentContext(assessment("medium"))?.status).toBe("warning");
    expect(incidentContext(assessment("high"))?.status).toBe("critical");
    expect(incidentContext(assessment("critical"))?.status).toBe("critical");
  });
});

describe("AccessSentry lifecycle", () => {
  it("opens no challenge when nobody is present", async () => {
    const s = await sentry();
    const view = await s.update(logView(), assessment("low"), T0);
    expect(view.verdict).toBe("idle");
    expect(view.pending).toBeUndefined();
  });

  it("opens exactly one challenge across repeated presence ticks", async () => {
    // The ToF gate jitters; a person shifting their weight must not queue up
    // challenges for the same visit.
    const s = await sentry();
    const log = logView({ presence: presentSince(T0.toISOString(), 5) });
    const first = await s.update(log, assessment("low"), at(5));
    const second = await s.update(log, assessment("low"), at(7));
    expect(first.pending?.id).toBeDefined();
    expect(second.pending?.id).toBe(first.pending?.id);
  });

  it("runs the full loop: presence -> capture -> unknown -> approval -> audit", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });

    const pending = await s.update(log, assessment("low"), at(5));
    expect(pending.verdict).toBe("pending-capture");

    const cap = await s.capture({ imageBase64: "ZmFrZQ==", now: at(8) });
    expect(cap.ok).toBe(true);
    expect(cap.faces).toHaveLength(1);
    expect(cap.faces[0]?.match).toBe("unknown");

    const challenged = await s.update(log, assessment("low"), at(9));
    expect(challenged.verdict).toBe("challenge");
    expect(challenged.pending?.approval.state).toBe("pending");

    const id = challenged.pending?.id as string;
    const ok = await s.approve({ id, decision: "approved", decidedBy: "on-call", now: at(20) });
    expect(ok.ok).toBe(true);

    // Still the same event, now approved -- the visit is not over just because a
    // decision was made, and re-opening here would re-challenge the person who
    // was approved two seconds ago.
    const after = await s.update(log, assessment("low"), at(21));
    expect(after.pending?.id).toBe(id);
    expect(after.pending?.approval.state).toBe("approved");
    expect(after.severity).toBe("ok");
    expect(after.reasons[0]).toMatch(/approved by on-call/);
    expect(after.log).toHaveLength(0);

    // It files itself when they leave, and one visit leaves exactly one record.
    const gone = await s.update(logView(), assessment("low"), at(120));
    expect(gone.pending).toBeUndefined();
    expect(gone.log).toHaveLength(1);
    expect(gone.log[0]?.approval.state).toBe("approved");
    expect(gone.log[0]?.approval.decidedBy).toBe("on-call");
  });

  it("does not re-challenge an approved person who is still standing there", async () => {
    // The bug this guards: retiring on approval freed the pending slot, so the
    // next tick opened a fresh challenge against the same person.
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    const id = opened.pending?.id as string;
    await s.approve({ id, decision: "approved", decidedBy: "on-call", now: at(8) });

    for (const t of [9, 11, 13, 30]) {
      const view = await s.update(log, assessment("low"), at(t));
      expect(view.pending?.id).toBe(id);
      expect(view.pending?.approval.state).toBe("approved");
      expect(view.verdict).not.toBe("pending-capture");
    }
  });

  it("keeps a denied person loud rather than letting the 'no' quiet the alarm", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    await s.approve({
      id: opened.pending?.id as string,
      decision: "denied",
      decidedBy: "on-call",
      now: at(8),
    });

    const view = await s.update(log, assessment("low"), at(9));
    expect(view.severity).toBe("warning");
    expect(view.reasons[0]).toMatch(/DENIED/);
  });

  it("refuses a decision for a challenge that is not the open one", async () => {
    const s = await sentry();
    const log = logView({ presence: presentSince(T0.toISOString(), 5) });
    await s.update(log, assessment("low"), at(5));
    const stale = await s.approve({
      id: "acc_19700101T000000Z",
      decision: "approved",
      decidedBy: "on-call",
      now: at(6),
    });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/stale decision/);
  });

  it("retires an abandoned challenge as undecided when the person leaves", async () => {
    const s = await sentry();
    const present = logView({ presence: presentSince(T0.toISOString(), 5) });
    await s.update(present, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(present, assessment("low"), at(7));

    const gone = await s.update(logView(), assessment("low"), at(60));
    expect(gone.pending).toBeUndefined();
    expect(gone.log[0]?.approval.state).toBe("pending");
    expect(gone.log[0]?.reasons.join(" ")).toMatch(/no decision/);
  });

  it("refuses to overwrite a decision that has already been recorded", async () => {
    // Approve-then-deny, or two phones tapping at once, used to keep only the
    // last write with no trace of the first. An audit record that rewrites in
    // place is a variable, not a record.
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    const id = opened.pending?.id as string;

    expect((await s.approve({ id, decision: "approved", decidedBy: "alice", now: at(8) })).ok).toBe(true);

    const second = await s.approve({ id, decision: "denied", decidedBy: "bob", now: at(9) });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already approved by alice/);

    const view = await s.update(log, assessment("low"), at(10));
    expect(view.pending?.approval.state).toBe("approved");
    expect(view.pending?.approval.decidedBy).toBe("alice");
  });

  it("freezes instead of falsifying the audit when the feed goes stale", async () => {
    // The board dying is not the same event as a person leaving. Without the
    // freshness gate, an unreadable log filed "presence ended with no decision"
    // -- a record of a human decision nobody was ever asked for.
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    const id = opened.pending?.id as string;

    const stale = await s.update(log, assessment("low"), at(400), false);
    expect(stale.pending?.id).toBe(id);
    expect(stale.log).toHaveLength(0);
    expect(stale.severity).toBe("warning");
    expect(stale.reasons.join(" ")).toMatch(/presence unobservable/);
    expect(stale.reasons.join(" ")).toMatch(/held, not abandoned/);
    // A blind sentry must never hold back a page.
    expect(stale.suppressingEscalation).toBe(false);
  });

  it("refuses a capture when no challenge is open", async () => {
    const s = await sentry();
    const r = await s.capture({ imageBase64: "ZmFrZQ==", now: T0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no challenge is open/);
  });

  it("escalates an unknown face to critical when an incident is live", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    await s.update(log, assessment("high"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    const view = await s.update(log, assessment("high"), at(7));
    expect(view.verdict).toBe("unauthorized-during-incident");
    expect(view.severity).toBe("critical");
  });

  it("recognises an enrolled badge and suppresses during an incident", async () => {
    process.env.ACCESS_IDENTITY_METHOD = "qr-badge";
    const s = await sentry();
    await s.enrol({ name: "Lauren R", embedding: [1, 0, 0], method: "qr-badge", now: T0 });

    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    await s.update(log, assessment("high"), at(5));
    const cap = await s.capture({ badges: ["Lauren R"], now: at(6) });
    expect(cap.method).toBe("qr-badge");
    expect(cap.faces[0]?.match).toBe("known");

    const view = await s.update(log, assessment("high"), at(7));
    expect(view.verdict).toBe("expected");
    expect(view.suppressingEscalation).toBe(true);
  });

  it("never writes image bytes into the persisted access state", async () => {
    // The privacy property has to hold at the boundary, not just in the roster.
    const dir = await mkdtemp(join(tmpdir(), "sentry-"));
    const statePath = join(dir, "access.json");
    const s = new AccessSentry({
      statePath,
      rosterPath: join(dir, "roster.json"),
      zone: "zone-east",
      captureUrl: "u",
    });
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "aVZCT1J3MEtHZ29mYWtlaW1hZ2VkYXRh", now: at(6) });
    await s.update(log, assessment("low"), at(7));

    const raw = await readFile(statePath, "utf8");
    expect(raw).not.toMatch(/aVZCT1J3MEtHZ29/);
    expect(raw).not.toMatch(/imageBase64/);

    // ...and the state is still a valid, readable record.
    const back = await readAccessState(statePath);
    expect(back.pending?.verdict).toBe("challenge");
  });
});

describe("AccessSentry pendingPhoto", () => {
  it("is absent when nothing is pending", async () => {
    const s = await sentry();
    expect(s.pendingPhoto()).toBeUndefined();
  });

  it("is absent before a capture, even with a challenge open", async () => {
    const s = await sentry();
    const log = logView({ presence: presentSince(T0.toISOString(), 5) });
    await s.update(log, assessment("low"), at(5));
    expect(s.pendingPhoto()).toBeUndefined();
  });

  it("is retrievable while approval is pending", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    const challenged = await s.update(log, assessment("low"), at(7));
    expect(challenged.verdict).toBe("challenge");
    expect(challenged.pending?.approval.state).toBe("pending");

    const photo = s.pendingPhoto();
    expect(photo?.imageBase64).toBe("ZmFrZQ==");
    expect(photo?.mime).toBe("image/jpeg");
  });

  it("carries the caller-supplied mime through to pendingPhoto", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", imageMime: "image/png", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    expect(s.pendingPhoto()?.mime).toBe("image/png");
  });

  it("is absent once approval is resolved, even though the challenge is still open", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    expect(s.pendingPhoto()).toBeDefined();

    const id = opened.pending?.id as string;
    const approved = await s.approve({ id, decision: "approved", decidedBy: "on-call", now: at(8) });
    expect(approved.ok).toBe(true);

    // The visit is not over -- the person is still standing there -- but the
    // decision is made, so the photo must be gone regardless.
    expect(s.pendingPhoto()).toBeUndefined();
    const after = await s.update(log, assessment("low"), at(9));
    expect(after.pending?.id).toBe(id);
    expect(s.pendingPhoto()).toBeUndefined();
  });

  it("is absent after a denial too, not only an approval", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    await s.approve({
      id: opened.pending?.id as string,
      decision: "denied",
      decidedBy: "on-call",
      now: at(8),
    });
    expect(s.pendingPhoto()).toBeUndefined();
  });

  it("is dropped when the challenge closes without a decision", async () => {
    const s = await sentry();
    const present = logView({ presence: presentSince(T0.toISOString(), 5) });
    await s.update(present, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(present, assessment("low"), at(7));
    expect(s.pendingPhoto()).toBeDefined();

    const gone = await s.update(logView(), assessment("low"), at(60));
    expect(gone.pending).toBeUndefined();
    expect(s.pendingPhoto()).toBeUndefined();
  });

  it("never appears on the retired audit entry", async () => {
    const s = await sentry();
    const log = logView({
      presence: presentSince(T0.toISOString(), 5),
      doorOpenAt: [T0.toISOString()],
    });
    const opened = await s.update(log, assessment("low"), at(5));
    await s.capture({ imageBase64: "ZmFrZQ==", now: at(6) });
    await s.update(log, assessment("low"), at(7));
    const id = opened.pending?.id as string;
    await s.approve({ id, decision: "approved", decidedBy: "on-call", now: at(8) });

    const goneAt = at(120);
    const gone = await s.update(logView(), assessment("low"), goneAt);
    const entry = gone.log[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {})).not.toContain("photo");
    expect(Object.keys(entry ?? {})).not.toContain("imageBase64");
    expect(JSON.stringify(entry)).not.toMatch(/imageBase64|"photo"|"image"/i);
  });
});
