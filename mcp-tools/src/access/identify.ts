import { spawn } from "node:child_process";
import { matchEmbedding, matchThreshold, readRoster } from "./roster.js";
import type { FaceMatch, IdentityMethod, RosterEntry } from "./types.js";
import { envPositive } from "../common/env.js";

/**
 * Run a child process, write `payload` to its stdin, and resolve its stdout.
 *
 * `execFile` cannot do this -- it has no stdin option, which is easy to miss
 * because passing one is silently ignored rather than rejected. A frame is
 * megabytes of base64, so it goes over a pipe rather than an argv the OS would
 * refuse anyway.
 *
 * The child is killed on timeout, and stderr is folded into the rejection: a
 * vision backend that fails needs to say why in the access record, because the
 * only alternative on stage is a shrug.
 */
async function runWithStdin(
  command: string,
  args: string[],
  payload: string,
  timeoutMs: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(out)
          : reject(new Error(`exited ${code}: ${err.trim().slice(0, 300) || "no stderr"}`)),
      ),
    );

    // EPIPE if the child died before reading; the close handler already owns that.
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload);
  });
}

/**
 * The identity ladder.
 *
 * Identification is a *swappable adapter*, exactly like the messaging gateway in
 * POSITIONING.md §3. The approval loop, the decision matrix and the audit trail
 * are byte-identical whichever rung produced the answer, so a rung that fails on
 * the morning of the demo costs a capability, not the demonstration.
 *
 *   face-npu         AI Hub model via ONNX Runtime + QNN EP on the Hexagon NPU
 *   face-cpu         the same model, CPU execution -- still entirely on-device
 *   qr-badge         printed badge, decoded on the phone; zero ML, always works
 *   face-detect-only everyone resolves as unknown; the loop still runs end to end
 *
 * Selected with `ACCESS_IDENTITY_METHOD`. The default is deliberately the *least*
 * capable one that still works, so an unconfigured machine understates what it
 * can do rather than claiming a match it never made.
 */

export type IdentityBackend = "stub" | "qr-badge" | "python";

export function configuredBackend(): IdentityBackend {
  const raw = (process.env.ACCESS_IDENTITY_METHOD ?? "stub").trim().toLowerCase();
  if (raw === "qr-badge" || raw === "badge") return "qr-badge";
  if (raw === "python" || raw === "face" || raw === "face-npu" || raw === "face-cpu") return "python";
  return "stub";
}

export interface IdentifyInput {
  /** JPEG/PNG bytes as base64, without a data: prefix. Never persisted by this module. */
  imageBase64?: string;
  /**
   * Badge strings the *client* decoded (rung 4).
   *
   * Decoded on the phone rather than here on purpose: `BarcodeDetector` is free in
   * the browser, and it keeps the server free of an image-decoding dependency --
   * which matters on Windows ARM64, where this project has already established
   * that `opencv-python` has no wheel.
   */
  badges?: string[];
  roster?: RosterEntry[];
  rosterPath?: string;
}

export interface IdentifyResult {
  faces: FaceMatch[];
  method: IdentityMethod;
  /** Present when a rung failed and a lower one answered instead. Surfaced, never hidden. */
  degradedFrom?: string;
}

export async function identifyFaces(input: IdentifyInput): Promise<IdentifyResult> {
  const roster = input.roster ?? (input.rosterPath ? await readRoster(input.rosterPath) : []);
  const backend = configuredBackend();

  if (backend === "qr-badge") return fromBadges(input.badges ?? [], roster);

  if (backend === "python") {
    try {
      return await fromPython(input, roster);
    } catch (err) {
      // A vision backend that fails must not take the access loop with it. Drop a
      // rung, say so in the record, and let a human decide -- which is the same
      // outcome the system would reach for a genuine stranger anyway.
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = input.badges?.length ? fromBadges(input.badges, roster) : detectOnly(input);
      return { ...fallback, degradedFrom: `face pipeline unavailable: ${reason}` };
    }
  }

  return input.badges?.length ? fromBadges(input.badges, roster) : detectOnly(input);
}

/**
 * Rung 3. One unresolved person per capture.
 *
 * Reported as `face-detect-only` so the record never implies a match was
 * attempted and refused. `decideAccess` reads this method and says out loud that
 * identity was not resolved, which stops "unknown" being mistaken for "checked
 * and not on the roster".
 */
function detectOnly(input: IdentifyInput): IdentifyResult {
  if (!input.imageBase64) return { faces: [], method: "none" };
  return {
    faces: [{ match: "unknown", name: null, similarity: 0 }],
    method: "face-detect-only",
  };
}

/** Rung 4. The badge text is the claim; the roster decides whether to believe it. */
function fromBadges(badges: string[], roster: RosterEntry[]): IdentifyResult {
  const names = new Set(roster.map((e) => e.name.trim().toLowerCase()));
  const faces: FaceMatch[] = badges.map((badge) => {
    const claim = badge.trim();
    return names.has(claim.toLowerCase())
      ? { match: "known", name: claim, similarity: 1 }
      : { match: "unknown", name: null, similarity: 0 };
  });
  return { faces, method: "qr-badge" };
}

/**
 * Rungs 1 and 2. Hand the frame to a short-lived Python process.
 *
 * A separate process rather than an in-process binding, because the QNN execution
 * provider is the least stable thing in this stack: a native crash inside the
 * dashboard would take the wall down mid-demo, and the wall is what the room is
 * looking at. Out here the worst case is a non-zero exit and a dropped rung.
 *
 * Contract -- stdin: `{"imageBase64": "..."}`; stdout: `{"embeddings": [[...]],
 * "boxes": [[x,y,w,h]], "device": "npu"|"cpu"}`. Matching stays here in
 * TypeScript so there is exactly one implementation of the threshold rule.
 */
async function fromPython(input: IdentifyInput, roster: RosterEntry[]): Promise<IdentifyResult> {
  const python = process.env.ACCESS_PYTHON ?? "python";
  const script = process.env.ACCESS_VISION_SCRIPT;
  if (!script) throw new Error("ACCESS_VISION_SCRIPT is not set");
  if (!input.imageBase64) throw new Error("no image supplied");

  const timeoutMs = envPositive("ACCESS_VISION_TIMEOUT_MS", 8000);
  const stdout = await runWithStdin(
    python,
    [script],
    JSON.stringify({ imageBase64: input.imageBase64 }),
    timeoutMs,
  );

  const parsed = JSON.parse(stdout) as {
    embeddings?: number[][];
    boxes?: [number, number, number, number][];
    device?: string;
  };
  const method = resolveMethod(parsed.device);
  const embeddings = parsed.embeddings ?? [];
  const threshold = matchThreshold();
  const faces: FaceMatch[] = embeddings.map((embedding, i) => {
    assertValidEmbedding(embedding);
    // The roster can carry entries of the wrong dimension -- the phone UI has
    // no way to enforce the model's output shape, so a hand-typed enrolment
    // like `embedding: [1]` is possible. cosineSimilarity would silently
    // return 0 for that mismatch today, but relying on that is fragile: this
    // filter makes the dimension check the caller's responsibility instead of
    // an accident of the scoring function's guard clause.
    const compatibleRoster = roster.filter((entry) => entry.embedding.length === embedding.length);
    const match = matchEmbedding(embedding, compatibleRoster, threshold);
    const box = parsed.boxes?.[i];
    return box ? { ...match, boxPct: box } : match;
  });
  return { faces, method };
}

/**
 * Map the backend's self-reported device to the audit-trail method.
 *
 * Deliberately strict: only the two literal values the contract promises are
 * accepted. Anything else -- a typo, a future device string, a stub that
 * forgot the field entirely -- must not be quietly upgraded to "face-npu".
 * The caller's catch block turns this into a clean degrade, same as any
 * other backend failure.
 */
function resolveMethod(device: string | undefined): IdentityMethod {
  if (device === "cpu") return "face-cpu";
  if (device === "npu") return "face-npu";
  throw new Error(`vision backend reported unrecognized device: ${JSON.stringify(device)}`);
}

/** The embedding width the vision model contract promises. */
const EMBEDDING_DIM = 512;

/**
 * Reject a malformed embedding before it reaches the matcher.
 *
 * A wrong-length or non-finite vector is not a face the model actually saw --
 * it is a protocol violation from the child process (truncated JSON, a stub
 * that emits a placeholder, a future model with a different output width).
 * Scoring it anyway would produce a match or non-match that means nothing, so
 * this throws and lets the same degrade path used for every other backend
 * failure take over.
 */
function assertValidEmbedding(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIM || !embedding.every((v) => Number.isFinite(v))) {
    throw new Error(
      `invalid embedding from vision backend: expected ${EMBEDDING_DIM} finite values, got length ${embedding.length}`,
    );
  }
}
