import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../common/atomic-write.js";
import type { AccessEvent, AccessState, Approval, ApprovalDecision } from "./types.js";

/**
 * Persistence for access events.
 *
 * Modelled on alert-skill/state-store.ts, which established the house rules the
 * hard way: a missing or corrupt file is a normal state and must never throw, and
 * a UTF-8 BOM will break `JSON.parse` silently if anyone writes these files from
 * PowerShell 5.1 (see PROGRESS.md NEXT 6 -- that trap cost an evening once).
 *
 * The log is also the project's first durable history of anything at all. The
 * telemetry generators are stateless and seeded per call, which is exactly why
 * REVIEW_3_2026-08-04.md §1c priced an "incident timeline" as blocked rather than
 * cheap. This file is that missing persistence layer, and it arrives as a
 * by-product rather than as a feature that had to be justified on its own.
 */

/** Keep the wall responsive and the file small; this is an audit trail, not a database. */
const LOG_LIMIT = 50;

const EMPTY: AccessState = { log: [] };

export function accessEventId(at: Date): string {
  // Sortable, filename-safe, second-resolution. Two events inside one second on a
  // rig with a 10s sensor cadence is not a case worth carrying a counter for.
  return `acc_${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/** Never throws: the wall must keep rendering even if this file is mid-write or absent. */
export async function readAccessState(path: string): Promise<AccessState> {
  try {
    const raw = await readFile(path, "utf8");
    // Strip a BOM before parsing rather than after failing to.
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as Partial<AccessState>;
    const log = Array.isArray(parsed.log) ? (parsed.log as AccessEvent[]) : [];
    return {
      ...(parsed.pending ? { pending: parsed.pending as AccessEvent } : {}),
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
      log,
    };
  } catch {
    return { ...EMPTY, log: [] };
  }
}

/**
 * Write atomically: temp file, then rename.
 *
 * The wall's 2s tick and an approval POST can persist to this path at the same
 * moment. A torn write leaves invalid JSON, `readAccessState` swallows it by
 * design (it must never throw), and the audit log silently becomes `[]` --
 * failure and clean slate look identical. See common/atomic-write.ts: a reader
 * sees either the old file or the new one and never a half-written one.
 */
export async function writeAccessState(path: string, state: AccessState): Promise<void> {
  const stamped: AccessState = { ...state, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path, stamped);
}

const NOT_REQUIRED: Approval = { required: false, state: "not-required" };

/**
 * Start a challenge for a presence episode.
 *
 * Idempotent per episode: re-triggering while a challenge is already open returns
 * the state untouched. The board emits `object_entered` on every ToF crossing and
 * the sketch's own threshold jitters, so without this a person shifting their
 * weight would open a queue of challenges for the same visit.
 */
export function openChallenge(
  state: AccessState,
  opts: { zone: string; trigger: string; at: Date },
): AccessState {
  if (state.pending) return state;
  const event: AccessEvent = {
    id: accessEventId(opts.at),
    at: opts.at.toISOString(),
    zone: opts.zone,
    trigger: opts.trigger,
    faces: [],
    identityMethod: "none",
    doorOpenCount: 0,
    verdict: "pending-capture",
    severity: "ok",
    reasons: ["presence detected, awaiting capture"],
    approval: { ...NOT_REQUIRED },
  };
  return { ...state, pending: event };
}

/** Fold a decided capture into the open challenge. */
export function applyDecision(
  state: AccessState,
  patch: Pick<
    AccessEvent,
    "faces" | "identityMethod" | "verdict" | "severity" | "reasons" | "doorOpenCount"
  > &
    Partial<Pick<AccessEvent, "doorConsistent" | "concurrentIncident" | "capturePath" | "degradedFrom">> & {
      approvalRequired: boolean;
      at: Date;
    },
): AccessState {
  if (!state.pending) return state;
  const { approvalRequired, at, ...rest } = patch;
  const existing = state.pending.approval;

  // A decision, once made, is not re-derived. This runs on every 2s tick, so
  // recomputing `approval` unconditionally would wipe an approval the moment
  // after a human gave it -- the verdict is still "unknown person", so the
  // requirement is still true, and the record would flip back to pending forever.
  const decided = existing.state === "approved" || existing.state === "denied";
  const approval: Approval = decided
    ? existing
    : approvalRequired
      ? {
          required: true,
          state: "pending",
          // Preserve the original ask time; a re-request every tick would make
          // "how long did this stranger wait" unanswerable.
          requestedAt: existing.requestedAt ?? at.toISOString(),
          decidedBy: null,
        }
      : { ...NOT_REQUIRED };
  return { ...state, pending: { ...state.pending, ...rest, approval } };
}

export interface ResolveApprovalResult {
  state: AccessState;
  /** False when the id did not match the open challenge -- a stale phone, usually. */
  ok: boolean;
  reason?: string;
}

/**
 * Record a human decision against the open challenge.
 *
 * The decision is stamped onto the challenge but the challenge is **not** retired
 * -- it stays open until the person actually leaves. That is not bookkeeping
 * tidiness; retiring it here re-opened a fresh challenge on the very next tick,
 * because presence was still active. On stage that reads as approving a volunteer and
 * then challenging them again two seconds later. One visit is one access event.
 *
 * The id must match. A phone left open on an old challenge is the normal way this
 * goes wrong, and silently applying yesterday's tap to today's stranger is the one
 * outcome an access system may not have.
 */
export function resolveApproval(
  state: AccessState,
  opts: { id: string; decision: ApprovalDecision; decidedBy: string; at: Date },
): ResolveApprovalResult {
  const pending = state.pending;
  if (!pending) {
    return { state, ok: false, reason: "no challenge is open" };
  }
  if (pending.id !== opts.id) {
    return {
      state,
      ok: false,
      reason: `challenge ${opts.id} is not the open one (${pending.id}) -- refusing a stale decision`,
    };
  }
  // A decision, once recorded, is final for that challenge.
  //
  // Previously this overwrote unconditionally: approve-then-deny, or two phones
  // tapping at once, kept only the last write with no trace of the first. An
  // audit record that rewrites in place is not an audit record -- it is a
  // variable. Refuse instead, so the disagreement is visible to whoever tapped
  // second rather than silently resolved by clock order.
  if (pending.approval.state === "approved" || pending.approval.state === "denied") {
    return {
      state,
      ok: false,
      reason:
        `challenge ${opts.id} was already ${pending.approval.state} by ` +
        `${pending.approval.decidedBy ?? "someone"} at ${pending.approval.decidedAt ?? "an earlier time"}` +
        ` -- refusing to overwrite a recorded decision`,
    };
  }
  const decided: AccessEvent = {
    ...pending,
    approval: {
      required: true,
      state: opts.decision,
      requestedAt: pending.approval.requestedAt ?? pending.at,
      decidedAt: opts.at.toISOString(),
      decidedBy: opts.decidedBy,
    },
  };
  return { state: { ...state, pending: decided }, ok: true };
}

/** Move the open challenge into the log, newest first, capped. */
export function retire(state: AccessState, event: AccessEvent): AccessState {
  const log = [event, ...state.log.filter((e) => e.id !== event.id)].slice(0, LOG_LIMIT);
  return { log };
}

/**
 * Close the challenge because the person left, and file it.
 *
 * An undecided challenge is annotated as such rather than quietly filed as
 * resolved: "they walked away before anyone answered" and "a human said yes" are
 * different facts about a stranger at a rack, and an audit trail that cannot tell
 * them apart is not an audit trail.
 */
export function abandonChallenge(state: AccessState, at: Date): AccessState {
  const pending = state.pending;
  if (!pending) return state;
  const undecided = pending.approval.state === "pending";
  const closed: AccessEvent = {
    ...pending,
    reasons: undecided
      ? [...pending.reasons, `presence ended at ${at.toISOString()} with no decision`]
      : pending.reasons,
    approval: undecided
      ? { ...pending.approval, decidedAt: at.toISOString(), decidedBy: null }
      : pending.approval,
  };
  return retire(state, closed);
}
