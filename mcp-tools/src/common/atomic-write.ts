/**
 * Replace a file's contents in one indivisible step.
 *
 * Four state files on this rig are written by one process and read by another
 * while it writes: `environmental-watch.json` (watchdog writes every 15s, the
 * wall reads every 2s), `access.json`, `roster.json`, `rules.json`. Every one of
 * their readers is required never to throw -- a missing or corrupt file has to
 * come back as a safe default -- which means a torn read is *indistinguishable
 * from a healthy empty state*: `{lastStatus:"ok"}`, or a roster with nobody on
 * it. Writing in place turns a 2ms window into a silent false all-clear.
 *
 * So: write a temp file, then rename it over the target. `rename` is atomic on
 * NTFS and POSIX alike; a reader sees either the old file or the new one.
 *
 * ## Why the rename retries
 *
 * The reader side already retries the sharing-violation family (see
 * read-retry.ts, and the false "recovered to OK" that motivated it). The writer
 * side has the mirror-image problem, and it is specific to Windows: `rename`
 * over a target another process currently has open fails with EPERM or EBUSY
 * rather than waiting. At a 15s write cadence against a 2s read cadence that is
 * a collision worth expecting, and the consequence -- a watchdog tick whose
 * decision was computed and then not persisted -- is exactly the kind of quiet
 * that this project keeps having to design out.
 *
 * The temp name carries the pid so two processes cannot land on the same one.
 * That is belt-and-braces: everything here is single-writer by design, and if
 * two watchdogs are running the duplicate pages will be the visible problem long
 * before the temp file is.
 */
import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { withReadRetry } from "./read-retry.js";

/**
 * Write `contents` to `path` atomically, creating the directory if needed.
 *
 * Throws only if the write genuinely failed -- callers persisting alert state
 * should let that propagate rather than continue as if it had been saved.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, "utf8");
  // Same transient-code set as the reader; see read-retry.ts for why EBUSY,
  // EPERM, EACCES and UNKNOWN all mean "someone has it open, try again".
  await withReadRetry(() => rename(tmp, path));
}

/** `writeFileAtomic` with the project's JSON formatting. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  opts: { trailingNewline?: boolean } = {},
): Promise<void> {
  const body = JSON.stringify(value, null, 2) + (opts.trailingNewline ? "\n" : "");
  await writeFileAtomic(path, body);
}
