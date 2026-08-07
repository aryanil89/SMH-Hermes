import type { Status } from "./types.js";

/**
 * Shared vocabulary for the UNO Q's on-device activity inferences
 * (`event: "activity"` lines, see docs/ONDEVICE_ACTIVITY.md).
 *
 * One copy for the two Node-side consumers that need it -- the dashboard's
 * pipeline stream (`dashboard/snapshot.ts`) and the watchdog's Telegram push
 * (`alert-skill/tick.ts`) -- so the wording a viewer sees on the wall and the
 * wording that lands on the phone can never drift apart. `public/app.js`
 * keeps its own duplicate, the same way it already duplicates
 * `DEVICE_EVENT_LABELS` as `EVENT_LABELS`: the browser has no module system
 * to share this with.
 */

/**
 * Turns `activity-person_entered_room` into "Person entered room". Falls
 * back to the raw string on anything that doesn't match the expected shape
 * -- never throws on a malformed label.
 */
export function humanizeActivity(activity: string): string {
  const words = activity.replace(/^activity-/, "").split("_").filter(Boolean);
  if (words.length === 0) return activity;
  return words.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * A keyword heuristic, not a copy of activity.py's CANONICAL_ACTIVITIES list.
 * A label mentioning fire or a leak reads as critical even if the board
 * starts inventing labels this file has never seen.
 */
export function activityStatus(activity: string): Status {
  const lower = activity.toLowerCase();
  if (lower.includes("fire") || lower.includes("leak")) return "critical";
  if (lower.includes("risk")) return "warning";
  return "ok";
}
