import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cosineSimilarity,
  matchEmbedding,
  readRoster,
  upsertRoster,
  writeRoster,
  DEFAULT_MATCH_THRESHOLD,
} from "./roster.js";
import type { RosterEntry } from "./types.js";

const at = new Date("2026-08-04T21:00:00.000Z");
const vec = (...xs: number[]): number[] => xs;

const alice: RosterEntry = {
  name: "Alice",
  embedding: vec(1, 0, 0, 0),
  enrolledAt: at.toISOString(),
  method: "face-npu",
};
const bob: RosterEntry = {
  name: "Bob",
  embedding: vec(0, 1, 0, 0),
  enrolledAt: at.toISOString(),
  method: "face-npu",
};

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1);
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
  });

  it("clamps opposing vectors to 0 rather than returning -1", () => {
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBe(0);
  });

  it("refuses mismatched or empty vectors instead of guessing", () => {
    expect(cosineSimilarity(vec(1, 0, 0), vec(1, 0))).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity(vec(0, 0), vec(0, 0))).toBe(0);
  });
});

describe("matchEmbedding", () => {
  it("resolves a close vector to the right person", () => {
    const m = matchEmbedding(vec(0.99, 0.01, 0, 0), [alice, bob]);
    expect(m.match).toBe("known");
    expect(m.name).toBe("Alice");
    expect(m.similarity).toBeGreaterThan(DEFAULT_MATCH_THRESHOLD);
  });

  it("returns unknown when nobody is enrolled", () => {
    const m = matchEmbedding(vec(1, 0, 0, 0), []);
    expect(m.match).toBe("unknown");
    expect(m.name).toBeNull();
    expect(m.similarity).toBe(0);
  });

  it("reports how close a near-miss got, not just that it failed", () => {
    // An operator deciding whether to approve needs "unknown, best 0.48" to be
    // distinguishable from "unknown, best 0.02".
    const nearMiss = matchEmbedding(vec(1, 1.05, 0, 0), [alice], 0.95);
    expect(nearMiss.match).toBe("unknown");
    expect(nearMiss.name).toBeNull();
    expect(nearMiss.similarity).toBeGreaterThan(0.6);
  });

  it("honours a stricter threshold", () => {
    const loose = matchEmbedding(vec(1, 0.9, 0, 0), [alice], 0.5);
    const strict = matchEmbedding(vec(1, 0.9, 0, 0), [alice], 0.99);
    expect(loose.match).toBe("known");
    expect(strict.match).toBe("unknown");
  });
});

describe("upsertRoster", () => {
  it("replaces an existing person rather than keeping a stale vector", () => {
    const once = upsertRoster([], { name: "Alice", embedding: vec(1, 0), method: "face-npu", at });
    const twice = upsertRoster(once, { name: "alice", embedding: vec(0, 1), method: "face-npu", at });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.embedding).toEqual(vec(0, 1));
  });
});

describe("roster persistence", () => {
  it("round-trips, and the file on disk contains no image bytes", async () => {
    // The privacy property, asserted rather than asserted-about: whatever else
    // changes, an enrolled roster must never grow a picture.
    const dir = await mkdtemp(join(tmpdir(), "roster-"));
    const path = join(dir, "roster.json");
    await writeRoster(path, [alice, bob]);

    const back = await readRoster(path);
    expect(back).toHaveLength(2);
    expect(back[0]?.name).toBe("Alice");

    const raw = await readFile(path, "utf8");
    expect(raw).not.toMatch(/base64|data:image|\/9j\/|iVBORw0KGgo/);
    expect(raw).not.toMatch(/imageBase64|capturePath|photo/i);
  });

  it("treats a missing or corrupt roster as nobody enrolled, never throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roster-"));
    expect(await readRoster(join(dir, "absent.json"))).toEqual([]);

    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    expect(await readRoster(bad)).toEqual([]);
  });

  it("survives a UTF-8 BOM, which PowerShell 5.1 writes by default", async () => {
    // This exact trap silently broke the alert watchdog once (PROGRESS.md NEXT 6).
    const dir = await mkdtemp(join(tmpdir(), "roster-"));
    const path = join(dir, "bom.json");
    await writeFile(path, "﻿" + JSON.stringify([alice]), "utf8");
    expect(await readRoster(path)).toHaveLength(1);
  });

  it("drops malformed entries instead of admitting them to the roster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roster-"));
    const path = join(dir, "mixed.json");
    await writeFile(path, JSON.stringify([alice, { name: "Ghost" }, null, 7]), "utf8");
    const back = await readRoster(path);
    expect(back).toHaveLength(1);
    expect(back[0]?.name).toBe("Alice");
  });
});
