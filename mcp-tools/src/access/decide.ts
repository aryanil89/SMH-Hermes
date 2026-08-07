import { isWorseThan } from "../common/alerts.js";
import type { Status } from "../common/types.js";
import type { ChannelView } from "../dashboard/types.js";
import type { AccessVerdict, FaceMatch, IdentityMethod } from "./types.js";

/**
 * The access decision matrix.
 *
 * Pure and synchronous on purpose. Every input already exists somewhere in the
 * system -- `presence` and `door` come straight off the UNO Q log via the
 * dashboard's `SensorLogView`, and the incident context comes from
 * `assessIncident()`. Nothing here reads a file, calls a model or touches a clock
 * it wasn't handed, which is what makes the whole matrix testable as a table.
 *
 * It is also computed in TypeScript rather than by the model, for the reason
 * REVIEW_3_2026-08-04.md §6 established: each agent iteration re-prefills the
 * whole prompt at ~2-4 minutes, so a verdict the model has to *derive* is a
 * verdict that arrives after the audience has stopped caring. The model narrates
 * what this function decided.
 *
 * The interesting row is `expected`. Every other outcome adds an alarm; that one
 * removes one, because a known engineer at the rack during a live incident is the
 * on-call responding and paging them again is noise. A system that only ever
 * escalates has not demonstrated judgement -- it has demonstrated a threshold.
 */

/** Presence with no capture is not an alarm immediately; a person needs time to answer. */
const DEFAULT_CAPTURE_GRACE_S = 60;

export interface IncidentContext {
  risk: string;
  cause: string;
  status: Status;
}

export interface DecideAccessInput {
  presence: ChannelView;
  door: ChannelView;
  /**
   * `door_open` edges observed during this presence episode.
   *
   * Counted by the caller against the episode, not the whole log window: the
   * tailgating test is "more people than authorised entries *this time*", and a
   * window-wide count would compare today's faces against yesterday's doors.
   */
  doorOpenCount: number;
  /** Empty until a capture has been resolved. */
  faces: FaceMatch[];
  identityMethod: IdentityMethod;
  /** False while the challenge is still waiting for someone to take the photo. */
  captured: boolean;
  concurrentIncident?: IncidentContext;
  captureGraceSeconds?: number;
}

export interface DecideAccessResult {
  verdict: AccessVerdict;
  severity: Status;
  /** Every reason that applied, not only the one that named the verdict. */
  reasons: string[];
  approvalRequired: boolean;
  /**
   * True only for `expected`. Signals that re-paging should be held back because
   * a known responder is physically present. Never true when any face is unknown.
   */
  suppressesEscalation: boolean;
  /**
   * True when presence was corroborated by a door edge, false when it was not,
   * and `undefined` when the door channel has no edge in the window at all.
   *
   * Three states rather than two, deliberately: an unobserved door is not a closed
   * door. The dashboard already refuses that collapse for the same reason -- see
   * DASHBOARD.md, "rendering an unobserved door as secure would be the display
   * inventing a fact".
   */
  doorConsistent?: boolean;
}

export function decideAccess(input: DecideAccessInput): DecideAccessResult {
  const graceS = input.captureGraceSeconds ?? DEFAULT_CAPTURE_GRACE_S;
  const reasons: string[] = [];

  // Nobody at the rack. Note that an *unobserved* presence channel lands here
  // too: with no edge in the window we cannot claim someone is present, and
  // inventing a challenge from missing data is the failure mode this project
  // has already decided against everywhere else.
  if (input.presence.state !== "present") {
    return {
      verdict: "idle",
      severity: "ok",
      reasons: input.presence.observed
        ? ["no presence detected at the rack"]
        : ["presence channel has no edge in the log window -- state unknown, not clear"],
      approvalRequired: false,
      suppressesEscalation: false,
    };
  }

  const heldS = input.presence.heldSeconds ?? 0;

  // Presence, but nothing captured yet. Below the grace period this is normal;
  // above it, the *silence itself* is the finding. An unanswered challenge is
  // exactly the case a real intruder produces, so it must not read as "fine".
  if (!input.captured || input.faces.length === 0) {
    const noFace = input.captured && input.faces.length === 0;
    if (noFace) reasons.push("capture contained no detectable face -- retake needed");
    else reasons.push(`presence detected ${heldS}s ago, awaiting capture`);

    const lapsed = heldS >= graceS;
    if (lapsed) reasons.push(`challenge unanswered for ${heldS}s (grace ${graceS}s)`);
    if (input.concurrentIncident) {
      reasons.push(`an incident is live in this zone: ${input.concurrentIncident.cause}`);
    }

    // The non-cooperating intruder.
    //
    // Someone who simply refuses to be photographed used to be the *cheapest*
    // way past this system: `pending-capture` capped at warning and never asked
    // for a decision, so there was literally nothing for a human to deny. But an
    // unanswered challenge is not an absence of evidence -- it is the behaviour
    // an intruder produces, and a cooperating colleague produces the opposite.
    //
    // So once the grace period lapses the challenge escalates on its own, and
    // during a live incident it goes critical: an unidentified person who will
    // not be identified, standing at a rack that is already in trouble, is the
    // worst combination available and it must be answerable.
    const unanswered = lapsed || noFace;
    const severity: Status = !unanswered
      ? "ok"
      : input.concurrentIncident
        ? "critical"
        : "warning";
    if (unanswered && input.concurrentIncident) {
      reasons.unshift(
        "unidentified person present during a live incident and not answering the challenge",
      );
    }

    return {
      verdict: "pending-capture",
      severity,
      reasons,
      approvalRequired: unanswered,
      suppressesEscalation: false,
    };
  }

  const faceCount = input.faces.length;
  const unknown = input.faces.filter((f) => f.match === "unknown");
  const known = input.faces.filter((f) => f.match === "known");

  // A door edge only counts as corroboration if the door channel was observed at
  // all. `undefined` propagates rather than defaulting to a convenient answer.
  const doorConsistent = input.door.observed ? input.doorOpenCount > 0 : undefined;

  reasons.push(
    `${faceCount} ${faceCount === 1 ? "face" : "faces"} detected` +
      (known.length > 0 ? `, ${known.length} on the roster` : "") +
      (unknown.length > 0 ? `, ${unknown.length} not on the roster` : ""),
  );
  if (doorConsistent === false) {
    reasons.push("present at the rack with no door-open edge in this episode");
  }
  if (input.concurrentIncident) {
    reasons.push(`an incident is live in this zone: ${input.concurrentIncident.cause}`);
  }
  if (input.identityMethod === "face-detect-only") {
    reasons.push("identity not resolved -- detection-only mode, everyone reads as unknown");
  }

  // Carried on every post-capture outcome. `doorConsistent` is evidence about the
  // episode, not about the verdict, so it must survive whichever branch wins --
  // dropping it on some paths and not others is how a display ends up disagreeing
  // with itself.
  const door = doorConsistent === undefined ? {} : { doorConsistent };

  // Priority order is severity order. Several of these can be true at once, which
  // is why every one of them has already pushed its reason above: picking a
  // headline must not discard the rest of what was observed.

  // Tailgating: more bodies than authorised entries. Requires at least one real
  // entry to compare against -- zero doors with people present is anti-passback,
  // a different finding, and conflating them would misname the breach.
  if (input.doorOpenCount >= 1 && faceCount > input.doorOpenCount) {
    reasons.unshift(
      `${faceCount} present against ${input.doorOpenCount} authorised ` +
        `${input.doorOpenCount === 1 ? "entry" : "entries"}`,
    );
    return {
      verdict: "tailgating",
      severity: "critical",
      reasons,
      ...door,
      approvalRequired: true,
      suppressesEscalation: false,
    };
  }

  // Unknown person while something is already wrong. Worse than either alone, and
  // the pairing is the whole argument for correlating physical access with
  // operational state instead of running them as two separate dashboards.
  if (unknown.length > 0 && input.concurrentIncident) {
    return {
      verdict: "unauthorized-during-incident",
      severity: "critical",
      reasons,
      ...door,
      approvalRequired: true,
      suppressesEscalation: false,
    };
  }

  if (doorConsistent === false) {
    return {
      verdict: "anti-passback",
      severity: "warning",
      reasons,
      ...door,
      approvalRequired: true,
      suppressesEscalation: false,
    };
  }

  if (unknown.length > 0) {
    return {
      verdict: "challenge",
      severity: "warning",
      reasons,
      ...door,
      approvalRequired: true,
      suppressesEscalation: false,
    };
  }

  // Known, and something is wrong: this is the responder, not an intruder.
  if (input.concurrentIncident) {
    reasons.unshift(
      `${known.map((f) => f.name).filter(Boolean).join(", ")} is on site and on the roster ` +
        "-- treating this as the on-call responding",
    );
    return {
      verdict: "expected",
      severity: "ok",
      reasons,
      ...door,
      approvalRequired: false,
      suppressesEscalation: true,
    };
  }

  return {
    verdict: "clear",
    severity: "ok",
    reasons,
    ...door,
    approvalRequired: false,
    suppressesEscalation: false,
  };
}

export interface SuppressionInput {
  /** What the access matrix concluded. */
  access: Pick<DecideAccessResult, "suppressesEscalation">;
  /** Status now. */
  current: Status;
  /** Worst status already acknowledged or already paged at. */
  lastPagedStatus: Status;
}

/**
 * Whether a page may be held back because a known responder is on site.
 *
 * Split out from `decideAccess` because it is the rule most likely to be wrong in
 * a way that matters: suppression exists to reduce noise, and the failure mode is
 * swallowing a genuine escalation. So the override is stated once, in one place,
 * and tested before anything that depends on it.
 *
 * Escalation always wins. Being on site means "you already know about the thing
 * you were paged for" -- it cannot mean "you already know about a thing that had
 * not happened yet when you arrived".
 */
export function shouldSuppressPage(input: SuppressionInput): boolean {
  if (!input.access.suppressesEscalation) return false;
  if (isWorseThan(input.current, input.lastPagedStatus)) return false;
  return true;
}
