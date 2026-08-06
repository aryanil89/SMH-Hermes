import { decideAccess, type IncidentContext } from "./decide.js";
import { identifyFaces } from "./identify.js";
import { notifyChallenge } from "./notify.js";
import { readRoster, upsertRoster, writeRoster } from "./roster.js";
import {
  abandonChallenge,
  applyDecision,
  openChallenge,
  readAccessState,
  resolveApproval,
  writeAccessState,
} from "./state.js";
import type { EventChannelSpec } from "../rules/channels.js";
import { EVENT_CHANNELS } from "../rules/channels.js";
import type { Status } from "../common/types.js";
import type { IncidentAssessment } from "../assess/types.js";
import type { SensorLogView } from "../dashboard/sensor-log.js";
import type {
  AccessEvent,
  AccessState,
  ApprovalDecision,
  FaceMatch,
  IdentityMethod,
  RosterEntry,
} from "./types.js";

/**
 * Drives the access loop: presence in, verdict out, approval recorded.
 *
 * Shaped like TelegramFeed -- the snapshot builder hands it the log view and the
 * assessment it already computed, and gets back something to render. Nothing here
 * re-reads the sensor log; the wall and the sentry see the same bytes, so they
 * cannot disagree about who is at the rack.
 *
 * Board event names come from `rules/channels.ts` rather than being written out
 * again here -- as does `dashboard/sensor-log.ts`, which is what makes that table
 * an actual single declaration rather than a claimed one. A second copy of the
 * string "object_entered" is precisely how a firmware rename becomes a silent
 * no-op six months later.
 */

const PRESENCE: EventChannelSpec = EVENT_CHANNELS.presence;

export interface AccessSentryOptions {
  statePath: string;
  rosterPath: string;
  zone: string;
  captureUrl: string;
}

export interface AccessView {
  zone: string;
  verdict: AccessEvent["verdict"];
  severity: Status;
  reasons: string[];
  identityMethod: IdentityMethod;
  faces: FaceMatch[];
  doorConsistent?: boolean;
  doorOpenCount: number;
  /** The open challenge, if one is. */
  pending?: AccessEvent;
  /** Newest first. The audit trail. */
  log: AccessEvent[];
  enrolled: string[];
  captureUrl: string;
  /** True when a known responder on site is holding back a repeat page. */
  suppressingEscalation: boolean;
  /** Set when an identity rung failed and a lower one answered. */
  degradedFrom?: string;
}

/**
 * How far *before* a presence edge a door-open still counts as the same entry.
 *
 * The door always precedes the rack: you open the door, then walk to the
 * cabinet and trip the ToF gate some seconds later. So the lookback is not a
 * rounding allowance -- it is the walk.
 *
 * Getting this wrong is not cosmetic. Too short and a genuine entry is not
 * credited, faces then outnumber doors, and the system reports **tailgating** at
 * someone who badged in normally. A physical-security alarm that cries wolf is
 * worse than none, so this errs long: the cost of missing a real tailgate is a
 * challenge the operator still has to answer, while the cost of inventing one is
 * the feature's credibility.
 */
const DOOR_LOOKBACK_MS = 30_000;

function doorLookbackMs(): number {
  const raw = Number(process.env.ACCESS_DOOR_LOOKBACK_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DOOR_LOOKBACK_MS;
}

/**
 * Count authorised entries belonging to the current presence episode.
 *
 * Scoped to the episode rather than the whole log window on purpose: the
 * tailgating test is "more people than entries *this time*". A window-wide count
 * would weigh today's faces against every door edge in the last 256KB of log and
 * conclude, reliably, that nothing is ever wrong.
 */
export function countDoorOpensSince(
  doorOpenAt: string[],
  sinceIso: string | undefined,
): number {
  if (!sinceIso) return 0;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  const floor = since - doorLookbackMs();
  let count = 0;
  for (const stamp of doorOpenAt) {
    const at = Date.parse(stamp);
    if (!Number.isNaN(at) && at >= floor) count += 1;
  }
  return count;
}

/** Only a live, non-ok assessment is context. An `ok` assessment is not an incident. */
export function incidentContext(assessment: IncidentAssessment): IncidentContext | undefined {
  const level = assessment.risk.level;
  if (level === "low") return undefined;
  const status: Status = level === "medium" ? "warning" : "critical";
  return { risk: level, cause: assessment.likelyCause, status };
}

export class AccessSentry {
  private state: AccessState = { log: [] };
  private roster: RosterEntry[] = [];
  private loaded = false;
  /** Identity for the open challenge, held until presence ends. */
  private captured:
    | { faces: FaceMatch[]; method: IdentityMethod; degradedFrom?: string; capturePath?: string }
    | undefined;
  /**
   * The captured photo for the open challenge -- in memory only, never in
   * `AccessState`, so it can never reach access.json.
   *
   * Keyed to the challenge id it belongs to and read only through
   * `pendingPhoto()`, which additionally gates on the approval still being
   * `"pending"`. Dropped explicitly in two places: `approve()` the moment a
   * decision is recorded, and the abandon branch of `update()` when the
   * person leaves without one. It is not cleared on every tick the way a
   * naive TTL would be -- the whole point is that it outlives nothing beyond
   * the decision it was captured for.
   */
  private photo: { challengeId: string; imageBase64: string; mime: string } | undefined;

  constructor(private readonly opts: AccessSentryOptions) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.state = await readAccessState(this.opts.statePath);
    this.roster = await readRoster(this.opts.rosterPath);
    this.loaded = true;
  }

  /**
   * Called once per wall tick with data the builder already has in hand.
   *
   * `feedFresh` is not optional politeness. The board dying is not the same event
   * as a person leaving, and without this the two were indistinguishable:
   *
   *   - Board dies while someone is present -> the log's newest edge stays
   *     `object_entered` forever, so presence reads "present" for the rest of the
   *     demo and the challenge never closes.
   *   - Log becomes unreadable -> presence reads unobserved -> the old code filed
   *     "presence ended with no decision", **a record of a human decision that was
   *     never asked for, caused by a dead cable.** An audit trail that invents
   *     entries is worse than no audit trail.
   *
   * So a stale feed freezes the loop instead of driving it: no new challenge, no
   * abandonment, and the view says plainly that the feed is down.
   */
  async update(
    log: SensorLogView,
    assessment: IncidentAssessment,
    now: Date,
    feedFresh = true,
  ): Promise<AccessView> {
    await this.load();

    if (!feedFresh) return this.staleView(log);

    const presence = log.presence;
    const wasOpen = this.state.pending !== undefined;

    if (presence.state === "present") {
      const before = this.state;
      this.state = openChallenge(this.state, {
        zone: this.opts.zone,
        trigger: PRESENCE.enter,
        at: now,
      });
      if (this.state !== before) await this.persist();
    } else if (wasOpen) {
      // They left without a decision. Retire the challenge as abandoned rather
      // than as approved -- "walked away" and "a human said yes" are different
      // facts about a stranger at a rack.
      this.state = abandonChallenge(this.state, now);
      this.captured = undefined;
      // The challenge closed, so the photo goes with it -- see `photo` above.
      this.photo = undefined;
      await this.persist();
    }

    const doorOpenCount = countDoorOpensSince(log.doorOpenAt, presence.since);
    const concurrentIncident = incidentContext(assessment);
    const decision = decideAccess({

      presence,
      door: log.door,
      doorOpenCount,
      faces: this.captured?.faces ?? [],
      identityMethod: this.captured?.method ?? "none",
      captured: this.captured !== undefined,
      ...(concurrentIncident ? { concurrentIncident } : {}),
    });

    // A recorded decision changes the *disposition*, not the finding. The person
    // is still whoever the capture said they were -- what changed is that a human
    // took responsibility. So the verdict stands and the severity relaxes, rather
    // than the event quietly rewriting itself as if nothing had been flagged.
    const settled = this.settle(decision, now);

    if (this.state.pending) {
      this.state = applyDecision(this.state, {
        faces: decision.verdict === "pending-capture" ? [] : (this.captured?.faces ?? []),
        identityMethod: this.captured?.method ?? "none",
        verdict: decision.verdict,
        severity: settled.severity,
        reasons: settled.reasons,
        doorOpenCount,
        ...(decision.doorConsistent !== undefined ? { doorConsistent: decision.doorConsistent } : {}),
        ...(concurrentIncident ? { concurrentIncident } : {}),
        ...(this.captured?.capturePath ? { capturePath: this.captured.capturePath } : {}),
        ...(this.captured?.degradedFrom ? { degradedFrom: this.captured.degradedFrom } : {}),
        approvalRequired: decision.approvalRequired,
        at: now,
      });
      await this.persist();

      // Notification only, and never awaited: `notifyChallenge` returns
      // synchronously and drops its own failures. This is on the wall's 2s tick,
      // and a blocking network call here is exactly how the watchdog died once
      // before. It de-duplicates by challenge id, so a person standing still
      // produces one push, not one every two seconds.
      const pending = this.state.pending;
      if (pending && pending.approval.state === "pending") notifyChallenge(pending);
    }

    return this.view(decision.verdict, settled.severity, settled.reasons, {
      doorOpenCount,
      suppressingEscalation: decision.suppressesEscalation,
      ...(decision.doorConsistent !== undefined ? { doorConsistent: decision.doorConsistent } : {}),
    });
  }

  /**
   * What the sentry reports when the sensor feed cannot be trusted.
   *
   * Deliberately does not touch persisted state: an open challenge stays open
   * (the person may well still be there -- we simply cannot see), and no
   * abandonment is filed. Severity is `warning` rather than `ok`, because "the
   * camera trigger for the access system is blind" is a fact the on-call should
   * be told, not one to render as calm.
   */
  private staleView(log: SensorLogView): AccessView {
    const reason = log.reason ?? "sensor feed is stale -- presence cannot be observed";
    return {
      zone: this.opts.zone,
      verdict: this.state.pending ? this.state.pending.verdict : "idle",
      severity: "warning",
      reasons: [
        `presence unobservable: ${reason}`,
        ...(this.state.pending
          ? ["a challenge is open and is being held, not abandoned, while the feed is down"]
          : []),
      ],
      identityMethod: this.captured?.method ?? "none",
      faces: this.captured?.faces ?? [],
      doorOpenCount: 0,
      ...(this.state.pending ? { pending: this.state.pending } : {}),
      log: this.state.log,
      enrolled: this.enrolledNames(),
      captureUrl: this.opts.captureUrl,
      // A blind sentry must never hold back a page.
      suppressingEscalation: false,
      degradedFrom: reason,
    };
  }

  /**
   * Fold a human decision into the rendered severity.
   *
   * Approved: relax to ok, and say who allowed it. Denied stays at whatever the
   * matrix said -- a refused stranger who is still standing at the rack is not a
   * resolved situation, and letting a "no" quiet the alarm would invert what the
   * approval loop is for.
   */
  private settle(
    decision: { severity: Status; reasons: string[] },
    now: Date,
  ): { severity: Status; reasons: string[] } {
    const approval = this.state.pending?.approval;
    if (!approval) return decision;

    if (approval.state === "approved") {
      const who = approval.decidedBy ?? "a human";
      const when = approval.decidedAt ?? now.toISOString();
      return {
        severity: "ok",
        reasons: [`access approved by ${who} at ${when}`, ...decision.reasons],
      };
    }
    if (approval.state === "denied") {
      const who = approval.decidedBy ?? "a human";
      return {
        severity: decision.severity,
        reasons: [`access DENIED by ${who} -- person is still at the rack`, ...decision.reasons],
      };
    }
    return decision;
  }

  /**
   * A capture arrived from the phone.
   *
   * The image is resolved to faces and then dropped. Nothing in this method
   * writes image bytes anywhere: what persists is a verdict and, at most, a
   * vector. See roster.ts for why that is the whole point.
   */
  async capture(input: {
    imageBase64?: string;
    /** MIME of the decoded image, for the pending-photo GET's content-type. Defaults to JPEG -- what the phone actually sends. */
    imageMime?: string;
    badges?: string[];
    now: Date;
  }): Promise<{ ok: boolean; reason?: string; faces: FaceMatch[]; method: IdentityMethod }> {
    await this.load();
    if (!this.state.pending) {
      return {
        ok: false,
        reason: "no challenge is open -- nobody is at the rack",
        faces: [],
        method: "none",
      };
    }
    const result = await identifyFaces({
      ...(input.imageBase64 ? { imageBase64: input.imageBase64 } : {}),
      ...(input.badges ? { badges: input.badges } : {}),
      roster: this.roster,
    });
    this.captured = {
      faces: result.faces,
      method: result.method,
      ...(result.degradedFrom ? { degradedFrom: result.degradedFrom } : {}),
    };
    // Held in memory only, keyed to this challenge -- see `photo` above. Never
    // folded into `this.state`, so `persist()` can never write it to disk.
    if (input.imageBase64) {
      this.photo = {
        challengeId: this.state.pending.id,
        imageBase64: input.imageBase64,
        mime: input.imageMime ?? "image/jpeg",
      };
    }
    return { ok: true, faces: result.faces, method: result.method };
  }

  /**
   * The captured photo for the currently open challenge, but only while a
   * human decision is actually pending on it.
   *
   * Gated on live state rather than trusting a stale flag: if the challenge
   * id has moved on (a new visit started) or the approval already resolved,
   * this answers undefined even before `this.photo` itself gets overwritten
   * or cleared, so the GET route never has to reason about staleness itself.
   */
  pendingPhoto(): { imageBase64: string; mime: string } | undefined {
    const pending = this.state.pending;
    if (!pending || !this.photo || this.photo.challengeId !== pending.id) return undefined;
    if (pending.approval.state !== "pending") return undefined;
    return { imageBase64: this.photo.imageBase64, mime: this.photo.mime };
  }

  /**
   * Record a human decision.
   *
   * Deliberately reachable only over the local page, never over the messaging
   * gateway. Telegram carries the notification; it does not carry the
   * authorisation, because a third-party relay is not somewhere physical
   * datacenter access should be granted from. See POSITIONING.md §3 -- this is
   * the same layering argument as the swappable notifier, applied to consent.
   */
  async approve(input: {
    id: string;
    decision: ApprovalDecision;
    decidedBy: string;
    now: Date;
  }): Promise<{ ok: boolean; reason?: string }> {
    await this.load();
    const result = resolveApproval(this.state, {
      id: input.id,
      decision: input.decision,
      decidedBy: input.decidedBy,
      at: input.now,
    });
    if (!result.ok) return { ok: false, ...(result.reason ? { reason: result.reason } : {}) };
    this.state = result.state;
    // `captured` deliberately survives: the person has not moved, so their
    // identity is still the identity of whoever is at the rack. Clearing it here
    // would drop the verdict back to "awaiting capture" on the next tick.
    //
    // `photo` does not get the same treatment: a decision, once made, is the
    // point at which the image must stop being shown to anyone -- see `photo`
    // above.
    if (this.photo?.challengeId === input.id) this.photo = undefined;
    await this.persist();
    return { ok: true };
  }

  async enrol(input: {
    name: string;
    embedding: number[];
    method: IdentityMethod;
    now: Date;
  }): Promise<{ ok: boolean; reason?: string; enrolled: string[] }> {
    await this.load();
    if (input.name.trim() === "") {
      return { ok: false, reason: "a name is required", enrolled: this.enrolledNames() };
    }
    if (input.embedding.length === 0) {
      return { ok: false, reason: "an embedding is required", enrolled: this.enrolledNames() };
    }
    this.roster = upsertRoster(this.roster, {
      name: input.name,
      embedding: input.embedding,
      method: input.method,
      at: input.now,
    });
    await writeRoster(this.opts.rosterPath, this.roster);
    return { ok: true, enrolled: this.enrolledNames() };
  }

  private enrolledNames(): string[] {
    return this.roster.map((e) => e.name);
  }

  private async persist(): Promise<void> {
    await writeAccessState(this.opts.statePath, this.state);
  }

  private view(
    verdict: AccessEvent["verdict"],
    severity: Status,
    reasons: string[],
    extra: {
      doorOpenCount: number;
      suppressingEscalation: boolean;
      doorConsistent?: boolean;
    },
  ): AccessView {
    return {
      zone: this.opts.zone,
      verdict,
      severity,
      reasons,
      identityMethod: this.captured?.method ?? "none",
      faces: this.captured?.faces ?? [],
      doorOpenCount: extra.doorOpenCount,
      ...(extra.doorConsistent !== undefined ? { doorConsistent: extra.doorConsistent } : {}),
      ...(this.state.pending ? { pending: this.state.pending } : {}),
      log: this.state.log,
      enrolled: this.enrolledNames(),
      captureUrl: this.opts.captureUrl,
      suppressingEscalation: extra.suppressingEscalation,
      ...(this.captured?.degradedFrom ? { degradedFrom: this.captured.degradedFrom } : {}),
    };
  }
}
