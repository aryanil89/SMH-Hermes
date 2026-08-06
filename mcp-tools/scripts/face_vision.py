#!/usr/bin/env python3
"""CPU face-recognition backend for `identify.ts`'s `fromPython` (rungs 1/2).

CONTRACT (read directly from mcp-tools/src/access/identify.ts, not from a
plan -- the code that parses this script's stdout is the ground truth):

  stdin:  one JSON object `{"imageBase64": "..."}` written then closed.

  stdout: EXACTLY ONE JSON line, always. `fromPython` only reads three
          fields from it -- everything else is ignored but harmless:

            embeddings: number[][]   one 512-d vector per face, L2-normalized
            boxes:      number[][4]  [x, y, w, h] as FRACTIONS of the frame
                                      (0..1), NOT pixels -- identify.ts copies
                                      this array verbatim into `FaceMatch.boxPct`
                                      (see access/types.ts:31, "Bounding box as
                                      [x, y, w, h] fractions of the frame") with
                                      no conversion of its own, so this script
                                      is the only place the pixel->percent
                                      conversion can happen.
            device:     "cpu" | "npu" checked with strict `===`
                                      (identify.ts resolveMethod) -- anything
                                      else, including a missing field, makes
                                      identify.ts THROW, which its caller turns
                                      into a dropped rung (`degradedFrom`).
                                      This script always emits "cpu" whenever
                                      `ok` is true, for exactly that reason.

          `ok`, `model`, `modelVersion`, and `reason` are extra fields
          identify.ts does not read today; kept for our own selftest/testing
          and for whatever next reads this stream.

  TWO DIFFERENT outcomes both count as "ok": true, and this distinction is
  load-bearing, not cosmetic:

    1. A face was found and embedded: `embeddings`/`boxes` non-empty.
    2. QUALITY REJECT (`no_face` / `face_too_small`): the pipeline ran fine
       and legitimately saw nothing usable. Emits `{"ok": true,
       "embeddings": [], "boxes": [], "device": "cpu", "model": ...,
       "modelVersion": ..., "reason": "no_face"|"face_too_small"}` and exits
       0. WHY exit 0 here, not a rejection: identify.ts's `fromPython` maps
       empty `embeddings` straight to `faces: []` under method `face-cpu`
       (no throw, no catch). `decide.ts:104-106` specifically tests
       `input.faces.length === 0` to reach "capture contained no detectable
       face -- retake needed" -- that retake path is the intended, correct
       outcome for a no-face photo, and it can ONLY be reached this way. If
       this script instead exited non-zero, `runWithStdin` would discard
       stdout, `identifyFaces`'s catch would fall back to `detectOnly`
       (a phantom `unknown` face) and stamp a false "face pipeline
       unavailable: ..." caption on the wall for a pipeline that actually
       worked correctly.

  invalid_image is the one GENUINE failure, and stays a rejection: exit 1,
          `{"ok": false, "error": "invalid_image"}` on stdout, reason on
          stderr. Covers: undecodable/oversized image payload, non-JSON
          stdin, missing/non-string `imageBase64`, and bad base64. Here the
          "face pipeline unavailable" degrade caption IS truthful -- nothing
          usable came out of this process at all -- so `runWithStdin`
          rejecting on the non-zero exit and identifyFaces degrading is the
          correct, intended behavior, unlike the quality-reject case above.

  exit code: 0 whenever `ok: true` (success OR quality reject). Non-zero
          (1) only for `invalid_image` or an unexpected crash. The
          identify.ts child-process wrapper (runWithStdin) discards stdout
          entirely when the process exits non-zero and instead folds stderr
          into the thrown error, which the caller (identifyFaces) catches
          and turns into a graceful degrade -- appropriate for invalid_image,
          wrong for a quality reject (see above).

  ALL diagnostics go to stderr. Never stdout.

Usage:
  python face_vision.py                    # stdin/stdout contract, as above
  python face_vision.py --selftest FILE    # run the pipeline on a file,
                                            # human summary to stderr, same
                                            # JSON to stdout, exit 0/1
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import face_common as fc  # noqa: E402


def log(msg: str) -> None:
    print(f"[face_vision] {msg}", file=sys.stderr, flush=True)


def _invalid(error: str) -> dict:
    """Genuine transport/protocol failure. ok:false, exit 1 -- see CONTRACT."""
    return {"ok": False, "error": error}


def _quality_reject(reason: str) -> dict:
    """Pipeline ran fine, found nothing usable. ok:true + empty arrays, exit
    0 -- so identify.ts produces faces: [] under face-cpu and decide.ts's
    faces.length === 0 retake path (decide.ts:104-106) actually fires,
    instead of identifyFaces catching a non-zero exit and degrading to a
    phantom detectOnly face with a false "pipeline unavailable" caption.
    """
    return {
        "ok": True,
        "embeddings": [],
        "boxes": [],
        "device": "cpu",
        "model": fc.MODEL_NAME,
        "modelVersion": fc.model_version(),
        "reason": reason,
    }


def run_on_bytes(raw: bytes) -> dict:
    """Decode -> detect -> quality-gate -> align -> embed. Never raises."""
    t0 = time.perf_counter()
    try:
        img = fc.decode_image(raw)
    except ValueError as e:
        log(f"invalid_image: {e}")
        return _invalid("invalid_image")

    h, w = img.shape[:2]
    log(f"decoded {w}x{h} image in {time.perf_counter() - t0:.3f}s")

    dets = fc.detect_faces(img)
    if not dets:
        log("no_face: zero detections (ok=true, retake path)")
        return _quality_reject("no_face")

    largest = dets[0]
    if largest.min_side < fc.MIN_FACE_SIDE:
        log(
            f"face_too_small: largest face min-side {largest.min_side:.1f}px "
            f"< {fc.MIN_FACE_SIDE}px (ok=true, retake path)"
        )
        return _quality_reject("face_too_small")

    embeddings: list[list[float]] = []
    boxes: list[list[float]] = []
    for i, det in enumerate(dets[: fc.MAX_FACES]):
        try:
            emb = fc.embed_face(img, det)
        except ValueError as e:
            log(f"skipping face[{i}]: {e}")
            continue
        x1, y1, x2, y2 = det.bbox
        boxes.append([x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h])
        embeddings.append([float(v) for v in emb])

    if not embeddings:
        log("no_face: all detections failed to embed (ok=true, retake path)")
        return _quality_reject("no_face")

    elapsed = time.perf_counter() - t0
    log(
        f"ok: {len(dets)} detected, {len(embeddings)} returned "
        f"(capped at {fc.MAX_FACES}), {elapsed:.3f}s total"
    )
    return {
        "ok": True,
        "embeddings": embeddings,
        "boxes": boxes,
        "device": "cpu",
        "model": fc.MODEL_NAME,
        "modelVersion": fc.model_version(),
    }


def run_stdin() -> int:
    raw_stdin = sys.stdin.buffer.read()
    try:
        payload = json.loads(raw_stdin.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"stdin is not valid JSON: {e}")
        print(json.dumps(_invalid("invalid_image")))
        return 1

    image_b64 = payload.get("imageBase64") if isinstance(payload, dict) else None
    if not image_b64 or not isinstance(image_b64, str):
        log("no imageBase64 string field in input")
        print(json.dumps(_invalid("invalid_image")))
        return 1

    try:
        raw = base64.b64decode(image_b64, validate=True)
    except Exception as e:  # noqa: BLE001
        log(f"base64 decode failed: {e}")
        print(json.dumps(_invalid("invalid_image")))
        return 1

    result = run_on_bytes(raw)
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


def run_selftest(path: Path) -> int:
    t0 = time.perf_counter()
    if not path.is_file():
        log(f"selftest: file not found: {path}")
        result = _invalid("invalid_image")
        print(json.dumps(result))
        return 1

    result = run_on_bytes(path.read_bytes())
    elapsed = time.perf_counter() - t0

    if result.get("ok") and result.get("embeddings"):
        log(f"selftest OK: {len(result['embeddings'])} face(s) in {elapsed:.3f}s")
        for i, (emb, box) in enumerate(zip(result["embeddings"], result["boxes"])):
            norm = sum(v * v for v in emb) ** 0.5
            log(
                f"  face[{i}] dim={len(emb)} l2norm={norm:.4f} "
                f"boxPct=[{', '.join(f'{v:.3f}' for v in box)}]"
            )
    elif result.get("ok"):
        log(
            f"selftest QUALITY REJECT: reason={result.get('reason')} in "
            f"{elapsed:.3f}s (ok=true, retake path -- exit 0)"
        )
    else:
        log(f"selftest REJECTED: {result.get('error')} in {elapsed:.3f}s (exit 1)")

    print(json.dumps(result))
    return 0 if result.get("ok") else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--selftest",
        metavar="IMAGE_PATH",
        help="run the pipeline on a local file instead of reading stdin",
    )
    args = ap.parse_args()

    if args.selftest:
        return run_selftest(Path(args.selftest))
    return run_stdin()


if __name__ == "__main__":
    sys.exit(main())
