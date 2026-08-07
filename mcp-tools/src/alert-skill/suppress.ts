import { shouldSuppressPage } from "../access/decide.js";
import type { AccessState } from "../access/types.js";
import type { Status } from "../common/types.js";

/**
 * Should this page be withheld because a known responder is at the rack?
 *
 * This is the adapter that was missing. `shouldSuppressPage` (access/decide.ts)
 * encoded the rule and was tested first, but nothing ever called it: the paging
 * chain -- Hermes cron -> environmental-watch.py -> check-environmental.js ->
 * decideAlert -- imported nothing from `access/`. The rule changed a caption on
 * the wall and pages went out regardless. This file connects the two.
 *
 * Three properties, in order of how badly each would hurt if wrong:
 *
 * 1. **Escalation always wins.** Delegated to `shouldSuppressPage`, unchanged.
 *    Being on site means "you know about the thing you were paged for", never
 *    "you know about a thing that had not happened when you arrived".
 *
 * 2. **Held, not cancelled.** The caller must not advance `lastStatus` while a
 *    page is held, so the crossing re-fires the moment the responder leaves.
 *
 * 3. **Fail open.** Suppression depends on a *different process* -- the dashboard
 *    drives the sentry that writes access.json. If the wall is down, that file
 *    goes stale, and a stale file must page rather than stay quiet. A watchdog
 *    that is silent because its input died is indistinguishable from one that is
 *    silent because all is well, and only one of those is acceptable.
 */

/** Matches the sensor-log staleness convention used everywhere else on this rig. */
export const DEFAULT_SUPPRESS_MAX_AGE_S = 180;

export function suppressMaxAgeSeconds(): number {
  const raw = Number(process.env.ACCESS_SUPPRESS_MAX_AGE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SUPPRESS_MAX_AGE_S;
}

export interface SuppressionDecision {
  hold: boolean;
  /** Always populated -- the reason a page went out matters as much as why one didn't. */
  reason: string;
  /**
   * Set only for property 1 above: a known responder IS on site and would have
   * earned a hold, but the status got worse than it was when they arrived.
   *
   * A flag rather than the caller matching on `reason`, because the two ways a
   * hold ends have to be told apart in the message and prose is the wrong seam
   * for that. The other way -- the responder walked away -- leaves this unset.
   */
  escalatedPastResponder?: boolean;
}

export interface EvaluateSuppressionInput {
  /** Undefined when the file is absent or unreadable. */
  access: AccessState | undefined;
  currentStatus: Status;
  /**
   * The status at which an existing hold began, if a page is already held.
   *
   * This is the escalation baseline, and getting it wrong made the whole feature
   * inert. The obvious choice -- "the status we last paged at" -- fails on a cold
   * start, where the last paged status is `ok` and therefore *every* first alert
   * counts as an escalation and goes out. Suppression then only ever engaged an
   * hour later, on the cooldown re-notify, which is not a behaviour anyone would
   * notice or demo.
   *
   * The semantically right baseline is what was true **when the responder
   * arrived**: you know about the situation you walked into, and you do not know
   * about anything that got worse afterwards. Undefined on the first hold, in
   * which case the current status becomes the baseline and the page is held.
   */
  heldStatus?: Status;
  now: Date;
  maxAgeSeconds?: number;
}

export function evaluateSuppression(input: EvaluateSuppressionInput): SuppressionDecision {
  const { access, currentStatus, now } = input;
  const baseline: Status = input.heldStatus ?? currentStatus;
  const maxAgeS = input.maxAgeSeconds ?? suppressMaxAgeSeconds();

  if (!access) return { hold: false, reason: "no access state -- paging normally" };

  // Freshness first, before anything is read from the record. `pending.at` is
  // when the visit began and stays fixed while someone stands there, so it
  // cannot answer "is the sentry alive?". Only the per-write stamp can.
  const stampedAt = access.updatedAt ? Date.parse(access.updatedAt) : Number.NaN;
  if (Number.isNaN(stampedAt)) {
    return { hold: false, reason: "access state has no update stamp -- paging normally" };
  }
  const ageS = Math.round((now.getTime() - stampedAt) / 1000);
  if (ageS > maxAgeS) {
    return {
      hold: false,
      reason: `access state is ${ageS}s old (max ${maxAgeS}s) -- dashboard may be down, paging normally`,
    };
  }

  const pending = access.pending;
  if (!pending) return { hold: false, reason: "nobody at the rack -- paging normally" };

  // `expected` is the only verdict that earns a hold: a person who IS on the
  // roster, present while an incident is live. Every other verdict either has an
  // unknown face in it or has no incident to be responding to.
  if (pending.verdict !== "expected") {
    return { hold: false, reason: `access verdict is ${pending.verdict} -- paging normally` };
  }

  const suppress = shouldSuppressPage({
    access: { suppressesEscalation: true },
    current: currentStatus,
    lastPagedStatus: baseline,
  });
  if (!suppress) {
    return {
      hold: false,
      escalatedPastResponder: true,
      reason: `status escalated from ${baseline} to ${currentStatus} after the responder arrived -- paging anyway`,
    };
  }

  const who = pending.faces.find((f) => f.match === "known")?.name ?? "a known responder";
  return {
    hold: true,
    reason: `${who} is on site at ${pending.zone} and already responding (since ${pending.at})`,
  };
}
