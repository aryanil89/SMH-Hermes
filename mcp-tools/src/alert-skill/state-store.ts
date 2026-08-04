import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Status } from "../common/types.js";

export interface AlertState {
  lastStatus: Status;
  /** ISO timestamp of the last time an alert was actually emitted (for cooldown re-notify). */
  lastAlertedAt?: string;
}

const DEFAULT_STATE: AlertState = { lastStatus: "ok" };

/** Reads persisted state; missing/corrupt file is treated as a fresh "ok" baseline, never throws. */
export async function readState(path: string): Promise<AlertState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertState>;
    if (parsed && (parsed.lastStatus === "ok" || parsed.lastStatus === "warning" || parsed.lastStatus === "critical")) {
      return { lastStatus: parsed.lastStatus, lastAlertedAt: parsed.lastAlertedAt };
    }
    return { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeState(path: string, state: AlertState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
