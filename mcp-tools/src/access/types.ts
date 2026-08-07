import type { Status } from "../common/types.js";

/**
 * Physical access control: who is standing at the rack, and may they be there?
 *
 * This exists because the project promised something it had not built. POSITIONING.md
 * §7 answers "can it take action automatically?" with *"No, by design. Observe ->
 * explain -> recommend -> human approves -> act."* There was no approval mechanism
 * anywhere in the codebase, so "human approves" described a step that did not exist.
 *
 * The other half is that the UNO Q has been emitting `door_open`/`door_closed` and
 * `object_entered`/`object_left` for days and nothing ever read them for meaning --
 * the dashboard drew them and stopped. Those two channels are the trigger and the
 * cross-check here, so this module adds a capability without adding a sensor.
 */

/**
 * How a face was resolved to a name -- or wasn't.
 *
 * `similarity` is cosine distance against an enrolled embedding, in 0..1. It is a
 * raw model score and deliberately NOT called confidence: the project's confidence
 * vocabulary is ordinal on purpose (see assess/types.ts) because we have no
 * labelled validation set, and a face-match score is exactly the kind of number
 * that invites false precision.
 */
export interface FaceMatch {
  match: "known" | "unknown";
  name: string | null;
  similarity: number;
  /** Bounding box as [x, y, w, h] fractions of the frame, for drawing on the wall. */
  boxPct?: [number, number, number, number];
}

/**
 * Which rung of the identity ladder produced the match.
 *
 * The ladder is a risk control, not an implementation detail, so it travels with
 * the data: a skeptic asking "is that really running on the NPU?" gets an answer
 * from the record rather than from a slide. Rungs degrade without changing any
 * downstream logic -- the decision matrix, approval loop and audit trail are
 * identical whether identity came from a face embedding or a printed QR badge.
 */
export type IdentityMethod =
  | "face-npu"
  | "face-cpu"
  | "face-detect-only"
  | "qr-badge"
  | "none";

/**
 * The single worst thing true about this access event.
 *
 * One label, because the wall and the phone need something to render and the
 * agent needs something to say. Everything else that was true is preserved in
 * `reasons`, so nothing is lost by picking a headline.
 */
export type AccessVerdict =
  /** No presence detected -- nobody is at the rack. */
  | "idle"
  /** Presence detected, no capture yet. Not an alarm until the grace period lapses. */
  | "pending-capture"
  /** Known person, ordinary conditions. */
  | "clear"
  /**
   * Known person while an incident is live: this is the on-call responding.
   * The one verdict that makes the system quieter -- see decide.ts.
   */
  | "expected"
  /** Unknown person, ordinary conditions. Needs a human to approve. */
  | "challenge"
  /** Unknown person while an incident is live. Worse than either alone. */
  | "unauthorized-during-incident"
  /** At the rack without a door-open edge: they did not come in through the door. */
  | "anti-passback"
  /** More faces than authorised entries -- the canonical datacenter breach. */
  | "tailgating";

export type ApprovalDecision = "approved" | "denied";

export interface Approval {
  required: boolean;
  state: "not-required" | "pending" | ApprovalDecision;
  requestedAt?: string;
  decidedAt?: string;
  /**
   * Who decided. Free text on purpose: this is a demo rig, not an IAM system,
   * and pretending otherwise would be the kind of overclaim this project has
   * been careful to avoid elsewhere.
   */
  decidedBy?: string | null;
}

/**
 * One access event, frozen. This is the black-box record: everything known at the
 * moment of the decision, kept verbatim so the reasoning can be re-read afterwards
 * rather than reconstructed.
 *
 * It also happens to be the project's first durable history of anything. The
 * telemetry generators are stateless and seeded per call, which is why
 * REVIEW_3_2026-08-04.md §1c priced an "incident timeline" as blocked rather than
 * free. An append-only log of these records is that persistence layer.
 */
export interface AccessEvent {
  id: string;
  at: string;
  zone: string;
  /** The board event that opened this challenge, e.g. `object_entered`. */
  trigger: string;
  faces: FaceMatch[];
  identityMethod: IdentityMethod;
  /**
   * False when presence was observed without a corresponding door-open edge.
   * `undefined` when the door channel has no edge in the window at all -- that is
   * "unobserved", not "inconsistent", and the two must not collapse into one.
   */
  doorConsistent?: boolean;
  /** Authorised entries counted against face count, for the tailgating check. */
  doorOpenCount: number;
  /** Present when an incident was live at the time -- the context multiplier. */
  concurrentIncident?: {
    risk: string;
    cause: string;
    status: Status;
  };
  verdict: AccessVerdict;
  severity: Status;
  /** Every reason that contributed, not just the headline one. Safe to read aloud. */
  reasons: string[];
  approval: Approval;
  /**
   * Path to the captured frame, when one was kept. Captures live under a
   * git-ignored directory and are pruned; the roster itself holds embeddings
   * only and never an image.
   */
  capturePath?: string;
  /**
   * Set when an identity rung failed and a lower one answered for this event.
   * Carried into the audit trail so a degraded read is visible after the
   * fact, not only on the live view. Never the image itself -- see
   * `AccessSentry`'s in-memory photo buffer for why no image field exists
   * here at all.
   */
  degradedFrom?: string;
}

/** Persisted access state: what is open now, and what has happened. */
export interface AccessState {
  /** The challenge awaiting capture or approval, if any. */
  pending?: AccessEvent;
  /** Append-only, newest first, capped. The audit trail. */
  log: AccessEvent[];
  /**
   * When the sentry last wrote this file.
   *
   * Load-bearing across a process boundary: the watchdog runs in a *different*
   * process (Hermes cron) and reads this file to decide whether to withhold a
   * page. `pending.at` cannot answer that -- it is when the visit began, and it
   * stays fixed while someone stands there. Only a per-write stamp distinguishes
   * "a responder is on site right now" from "the dashboard died an hour ago
   * leaving a challenge open", and those two must never suppress alike.
   */
  updatedAt?: string;
}

/** One enrolled person. Embedding only -- see roster.ts for why. */
export interface RosterEntry {
  name: string;
  embedding: number[];
  enrolledAt: string;
  /** Which rung produced the embedding, so a mixed roster cannot silently form. */
  method: IdentityMethod;
}
