import { describe, expect, it } from "vitest";
import { assessIncident } from "./assess.js";
import { scoreRisk, levelFor } from "./risk.js";
import { assessConfidence } from "./confidence.js";
import type { Evidence } from "./types.js";
import type { EnvironmentalResult } from "../environmental/types.js";

function reading(over: Partial<EnvironmentalResult> = {}): EnvironmentalResult {
  return {
    temperatureC: 22,
    humidityPct: 45,
    leakDetected: false,
    status: "ok",
    source: "real",
    via: "file",
    ageSeconds: 5,
    generatedAt: new Date().toISOString(),
    ...over,
  } as EnvironmentalResult;
}

const ev = (family: Evidence["family"], status: Evidence["status"], points: number): Evidence => ({
  family,
  signal: "s",
  value: "v",
  status,
  detail: "d",
  points,
});

describe("risk scoring", () => {
  it("does not double-count correlated signals inside one family", () => {
    const one = scoreRisk([ev("storage", "critical", 25)]);
    const three = scoreRisk([
      ev("storage", "critical", 25),
      ev("storage", "warning", 12),
      ev("storage", "warning", 12),
    ]);
    // Three symptoms of one root cause must not score 3x one symptom.
    expect(three.score).toBeLessThan(one.score * 2);
    expect(three.familiesInvolved).toEqual(["storage"]);
  });

  it("rewards agreement across independent families more than volume within one", () => {
    const oneFamily = scoreRisk([
      ev("storage", "critical", 25),
      ev("storage", "critical", 25),
      ev("storage", "critical", 25),
    ]);
    const twoFamilies = scoreRisk([ev("storage", "critical", 25), ev("physical", "critical", 45)]);
    expect(twoFamilies.score).toBeGreaterThan(oneFamily.score);
    expect(twoFamilies.correlationBonus).toBeGreaterThan(0);
    expect(oneFamily.correlationBonus).toBe(0);
  });

  it("is bounded to 0-100 and maps to the documented bands", () => {
    const huge = scoreRisk([
      ev("physical", "critical", 50),
      ev("storage", "critical", 25),
      ev("network", "critical", 20),
      ev("compute", "critical", 15),
    ]);
    expect(huge.score).toBeLessThanOrEqual(100);
    expect(levelFor(0)).toBe("low");
    expect(levelFor(31)).toBe("medium");
    expect(levelFor(61)).toBe("high");
    expect(levelFor(81)).toBe("critical");
  });

  it("scores an all-clear system at zero", () => {
    expect(scoreRisk([]).score).toBe(0);
    expect(scoreRisk([]).level).toBe("low");
  });
});

describe("confidence is about provenance, not severity", () => {
  it("is NONE whenever the physical input is simulated", () => {
    const c = assessConfidence({
      provenance: {
        environmental: "mock",
        simulatedInputs: true,
        fallbackReason: "sensor log is stale",
      },
      familiesInvolved: ["physical", "storage"],
      familiesClean: [],
    });
    // This is the 2026-08-04 failure: a CRITICAL alert built on invented numbers.
    expect(c.level).toBe("none");
    expect(c.reasons.join(" ")).toMatch(/SIMULATED/);
  });

  it("is HIGH when the reading is live, fresh and corroborated", () => {
    const c = assessConfidence({
      provenance: { environmental: "real", ageSeconds: 4, simulatedInputs: true },
      familiesInvolved: ["physical", "storage"],
      familiesClean: ["network", "compute"],
    });
    expect(c.level).toBe("high");
  });

  it("drops to LOW when real data is going stale", () => {
    const c = assessConfidence({
      provenance: { environmental: "real", ageSeconds: 120, simulatedInputs: true },
      familiesInvolved: ["physical", "storage"],
      familiesClean: [],
    });
    expect(c.level).toBe("low");
  });

  it("downgrades a physical-only signal nothing downstream reflects", () => {
    const corroborated = assessConfidence({
      provenance: { environmental: "real", ageSeconds: 3, simulatedInputs: true },
      familiesInvolved: ["physical", "storage"],
      familiesClean: ["network"],
    });
    const alone = assessConfidence({
      provenance: { environmental: "real", ageSeconds: 3, simulatedInputs: true },
      familiesInvolved: ["physical"],
      familiesClean: ["storage", "network", "compute"],
    });
    expect(alone.level).not.toBe("high");
    expect(corroborated.level).toBe("high");
    expect(alone.reasons.join(" ")).toMatch(/sensor artefact|not yet reflected/);
  });
});

describe("end-to-end scenarios", () => {
  it("healthy rack: low risk, no incident, action not required", async () => {
    const a = await assessIncident({ seed: 11, environmentalOverride: reading() });
    expect(a.risk.level).toBe("low");
    expect(a.likelyCause).toMatch(/No incident/i);
    expect(a.recommendedAction).toMatch(/No action/i);
  });

  it("cooling degradation: hot rack + slow storage, network explicitly cleared", async () => {
    const a = await assessIncident({
      seed: 11,
      environmentalOverride: reading({ temperatureC: 38, status: "critical" }),
    });
    expect(a.risk.familiesInvolved).toContain("physical");
    expect(a.risk.familiesInvolved).toContain("storage");
    expect(a.risk.familiesInvolved).not.toContain("network");
    expect(a.likelyCause).toMatch(/[Cc]ooling degradation/);
    expect(a.recommendedAction).toMatch(/Network needs no action/);
    expect(a.confidence.level).toBe("high");
  });

  it("leak: escalates to critical and recommends dispatch", async () => {
    const a = await assessIncident({
      seed: 11,
      environmentalOverride: reading({ leakDetected: true, leakVia: "event", status: "critical" }),
    });
    expect(a.risk.level).toBe("critical");
    expect(a.likelyCause).toMatch(/leak/i);
    expect(a.recommendedAction).toMatch(/technician/i);
  });

  it("simulated sensor: severity may be high, but confidence is none and the summary says so", async () => {
    const a = await assessIncident({
      seed: 11,
      environmentalOverride: reading({
        temperatureC: 39,
        source: "mock",
        fallbackReason: "sensor log is stale: newest line is 34797s old",
        status: "critical",
      }),
    });
    expect(a.provenance.environmental).toBe("mock");
    expect(a.confidence.level).toBe("none");
    expect(a.summary).toMatch(/simulated/i);
  });

  it("does not feed a mock temperature into the telemetry coupling", async () => {
    // A fabricated 39C must not manufacture a storage correlation.
    const a = await assessIncident({
      seed: 11,
      environmentalOverride: reading({ temperatureC: 39, source: "mock", status: "critical" }),
    });
    expect(a.risk.familiesInvolved).not.toContain("storage");
  });

  it("is reproducible for the same seed and reading", async () => {
    const input = { seed: 5, environmentalOverride: reading({ temperatureC: 36 }) };
    const a = await assessIncident(input);
    const b = await assessIncident(input);
    expect(a.risk.score).toBe(b.risk.score);
  });
});

describe("on-device activity is reported without being scored", () => {
  // The whole point of the field. Activity is a 1.5B model's qualitative
  // guess about a room; risk is a reproducible function of measurements. If
  // one can move the other, "ask twice, get the same score" stops being true
  // the moment the board narrates something, and a reviewer checking the
  // arithmetic against the evidence list would find points they cannot source.
  const withActivity = {
    seed: 11,
    environmentalOverride: reading({
      temperatureC: 38,
      status: "critical",
      activity: {
        activity: "activity-person_entered_room",
        trigger: "motion",
        at: new Date().toISOString(),
        ageSeconds: 42,
      },
    }),
  };
  const withoutActivity = {
    seed: 11,
    environmentalOverride: reading({ temperatureC: 38, status: "critical" }),
  };

  it("leaves risk, confidence and evidence bit-for-bit identical", async () => {
    const withA = await assessIncident(withActivity);
    const without = await assessIncident(withoutActivity);
    expect(withA.risk).toEqual(without.risk);
    expect(withA.confidence).toEqual(without.confidence);
    expect(withA.evidence).toEqual(without.evidence);
    expect(withA.likelyCause).toBe(without.likelyCause);
    expect(withA.recommendedAction).toBe(without.recommendedAction);
    // and specifically: it did not smuggle itself into the evidence list
    expect(withA.evidence.some((e) => /activity|person/i.test(e.signal))).toBe(false);
  });

  it("surfaces it humanized, with its age, on the assessment", async () => {
    const a = await assessIncident(withActivity);
    expect(a.observedActivity?.humanized).toBe("Person entered room");
    expect(a.observedActivity?.activity).toBe("activity-person_entered_room");
    expect(a.observedActivity?.ageSeconds).toBe(42);
  });

  it("labels it 'not scored' in the summary the model reads out", async () => {
    const a = await assessIncident(withActivity);
    // The model is told to relay `summary` verbatim, so the disclaimer has to
    // live in the sentence itself -- not in a sibling field it may never read.
    expect(a.summary).toContain('Also observed (not scored): the board\'s own model inferred "Person entered room" 42s ago.');
    // ...and after the measured evidence, so it cannot be mistaken for it.
    expect(a.summary.indexOf("Also observed")).toBeGreaterThan(a.summary.indexOf("Evidence:"));
  });

  it("says nothing at all when the board has inferred nothing", async () => {
    const a = await assessIncident(withoutActivity);
    expect(a.observedActivity).toBeUndefined();
    expect(a.summary).not.toContain("Also observed");
  });
});

describe("activity age is phrased for a person, not a log", () => {
  const withAge = (ageSeconds: number) => ({
    seed: 11,
    environmentalOverride: reading({
      activity: {
        activity: "activity-person_left_room",
        at: new Date().toISOString(),
        ageSeconds,
      },
    }),
  });

  it("keeps exact seconds while the exact number is the point", async () => {
    const a = await assessIncident(withAge(12));
    expect(a.summary).toContain("12s ago");
  });

  it("rounds to minutes past a minute and a half", async () => {
    const a = await assessIncident(withAge(1731));
    expect(a.summary).toContain("29 minutes ago");
    expect(a.summary).not.toContain("1731");
  });

  it("falls back to hours rather than reading out three digits of minutes", async () => {
    const a = await assessIncident(withAge(7200));
    expect(a.summary).toContain("about 2 hours ago");
    // The minutes band deliberately runs to 90, so a flat hour is still spoken
    // as minutes -- which is why the hours band never needs a singular form.
    const anHour = await assessIncident(withAge(3600));
    expect(anHour.summary).toContain("60 minutes ago");
  });

  it("says the inference without an age when the timestamp did not parse", async () => {
    const a = await assessIncident({
      seed: 11,
      environmentalOverride: reading({
        activity: { activity: "activity-person_left_room", at: "not-a-date" },
      }),
    });
    expect(a.summary).toContain('inferred "Person left room".');
    expect(a.summary).not.toMatch(/ago/);
  });
});
