import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../common/atomic-write.js";
import type { FaceMatch, IdentityMethod, RosterEntry } from "./types.js";

/**
 * The enrolled roster: who is allowed at the rack.
 *
 * **This file stores embeddings and never images.** That is a deliberate design
 * property, not an optimisation, and it is the reason the feature is defensible
 * at all: GDPR treats facial-recognition templates as special-category data, and
 * the recognised privacy-protective pattern -- the one a phone's secure enclave
 * uses -- is that the template never leaves the device and the source image is
 * not retained. A capture exists on disk for as long as it takes to embed it and
 * is then deleted; what survives is a vector you cannot reconstruct a face from.
 *
 * Practically it also means the roster is safe to inspect on stage. "Here is our
 * biometric database" followed by a screen of floats lands better than any claim
 * about privacy that a visitor has to take on trust.
 */

/**
 * Cosine similarity above which two embeddings are the same person.
 *
 * The default is a starting point, NOT a calibrated value. Face-embedding
 * thresholds are model- and population-specific; this project has an explicit
 * rule against numbers that imply a calibration nobody performed (see
 * assess/types.ts on ordinal confidence). So: tune this against the actual
 * enrolled faces during rehearsal, record what was measured, and treat any
 * pre-rehearsal match as provisional.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.5;

export function matchThreshold(): number {
  const raw = Number(process.env.ACCESS_MATCH_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_MATCH_THRESHOLD;
}

/** Never throws: an absent roster means "nobody is enrolled", which is a valid state. */
export async function readRoster(path: string): Promise<RosterEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RosterEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RosterEntry).name === "string" &&
        Array.isArray((e as RosterEntry).embedding),
    );
  } catch {
    return [];
  }
}

/**
 * Write atomically: temp file, then rename. Same rule as access/state.ts, and it
 * matters more here.
 *
 * `readRoster` returns `[]` for anything it cannot parse, by design -- an absent
 * roster is a valid state. That makes a torn write indistinguishable from an
 * empty enrolment: every known face silently becomes `unknown`, so the sentry
 * challenges people who are on the roster, and the `expected` verdict that
 * withholds pages can never be reached again. An enrol POST landing while the
 * dashboard's 2s tick reads the file is all it takes.
 */
export async function writeRoster(path: string, entries: RosterEntry[]): Promise<void> {
  await writeJsonAtomic(path, entries);
}

/**
 * Cosine similarity of two equal-length vectors, clamped to 0..1.
 *
 * Clamped because face embeddings are near-unit-norm and a negative cosine here
 * means "less alike than orthogonal", which is not a distinction any downstream
 * consumer should have to reason about -- it is simply "no".
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const raw = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.min(1, Math.max(0, raw));
}

/**
 * Resolve one embedding against the roster.
 *
 * Returns the best match and its score even when the score is below threshold,
 * so the record can say *how close* it got. "Unknown, best 0.48 against a 0.50
 * threshold" is a materially different fact from "unknown, best 0.11", and an
 * operator deciding whether to approve deserves to see which one they have.
 */
export function matchEmbedding(
  embedding: number[],
  roster: RosterEntry[],
  threshold = matchThreshold(),
): FaceMatch {
  let best: { name: string; score: number } | undefined;
  for (const entry of roster) {
    const score = cosineSimilarity(embedding, entry.embedding);
    if (!best || score > best.score) best = { name: entry.name, score };
  }
  if (!best) return { match: "unknown", name: null, similarity: 0 };
  return best.score >= threshold
    ? { match: "known", name: best.name, similarity: round(best.score) }
    : { match: "unknown", name: null, similarity: round(best.score) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface EnrolInput {
  name: string;
  embedding: number[];
  method: IdentityMethod;
  at?: Date;
}

/**
 * Add or replace one person.
 *
 * Replace-by-name rather than append: re-enrolling someone whose first photo was
 * poor is the common case, and silently keeping both would leave a stale vector
 * that can only ever cause a false match nobody can explain.
 */
export function upsertRoster(entries: RosterEntry[], input: EnrolInput): RosterEntry[] {
  const name = input.name.trim();
  const entry: RosterEntry = {
    name,
    embedding: input.embedding,
    enrolledAt: (input.at ?? new Date()).toISOString(),
    method: input.method,
  };
  return [...entries.filter((e) => e.name.toLowerCase() !== name.toLowerCase()), entry];
}
