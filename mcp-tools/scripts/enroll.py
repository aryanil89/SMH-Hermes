#!/usr/bin/env python3
"""Build/update one roster.json entry from a folder of reference photos.

Runs the IDENTICAL detect->align->embed pipeline as `face_vision.py` (shared
via `face_common.py`), so an enrolled embedding is directly comparable to
whatever the door produces later -- there is exactly one implementation of
"what a face embedding is" in this project.

Roster shape (read from mcp-tools/src/access/roster.ts and types.ts, not
assumed): a JSON array of

    { "name": str, "embedding": number[], "enrolledAt": ISO-8601 str,
      "method": IdentityMethod }

written atomically (temp file + rename, matching `writeRoster`'s own
atomic-write discipline in roster.ts) and upserted by name
(case-insensitive), matching `upsertRoster`'s replace-by-name semantics: a
re-enrolment replaces the old vector rather than accumulating a second one.
`method` is always "face-cpu" here, since this script only ever runs the CPU
pipeline.

Per-photo quality gates, identical thresholds to face_vision.py:
  - no detected face                              -> reject, log why
  - largest face's min-side < MIN_FACE_SIDE (80px) -> reject, log why
  - only the largest face in a photo is used (one person per reference photo)

All diagnostics/per-photo decisions go to stderr; the final summary goes to
stdout, since (unlike face_vision.py) this is a standalone admin CLI with no
downstream JSON parser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import face_common as fc  # noqa: E402

DEFAULT_ROSTER = Path(__file__).resolve().parent.parent / ".state" / "roster.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def log(msg: str) -> None:
    print(f"[enroll] {msg}", file=sys.stderr, flush=True)


def iter_images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)


def embed_photo(path: Path) -> np.ndarray | None:
    """Return the embedding for the largest face in `path`, or None (logged) if rejected."""
    try:
        raw = path.read_bytes()
        img = fc.decode_image(raw)
    except (OSError, ValueError) as e:
        log(f"reject {path.name}: invalid_image ({e})")
        return None

    dets = fc.detect_faces(img)
    if not dets:
        log(f"reject {path.name}: no_face")
        return None

    largest = dets[0]
    if largest.min_side < fc.MIN_FACE_SIDE:
        log(f"reject {path.name}: face_too_small ({largest.min_side:.1f}px < {fc.MIN_FACE_SIDE}px)")
        return None

    try:
        emb = fc.embed_face(img, largest)
    except ValueError as e:
        log(f"reject {path.name}: embedding failed ({e})")
        return None

    log(f"accept {path.name}: min-side {largest.min_side:.1f}px, det score {largest.score:.3f}")
    return emb


def load_roster(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"warning: could not parse existing roster {path} ({e}); starting fresh")
        return []
    if not isinstance(data, list):
        log(f"warning: {path} did not contain a JSON array; starting fresh")
        return []
    return data


def upsert_roster(entries: list[dict], name: str, embedding: list[float]) -> list[dict]:
    """Replace-by-name (case-insensitive), preserving every other entry untouched."""
    entry = {
        "name": name,
        "embedding": embedding,
        "enrolledAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "method": "face-cpu",
    }
    kept = [
        e
        for e in entries
        if not (isinstance(e, dict) and str(e.get("name", "")).strip().lower() == name.lower())
    ]
    return [*kept, entry]


def write_roster_atomic(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="person to enroll")
    ap.add_argument("--dir", required=True, type=Path, help="folder of reference photos")
    ap.add_argument("--out", type=Path, default=DEFAULT_ROSTER, help=f"roster.json path (default: {DEFAULT_ROSTER})")
    args = ap.parse_args()

    name = args.name.strip()
    if not name:
        log("--name must not be empty")
        return 1
    if not args.dir.is_dir():
        log(f"not a directory: {args.dir}")
        return 1

    photos = iter_images(args.dir)
    if not photos:
        log(f"no image files ({', '.join(sorted(IMAGE_EXTS))}) found in {args.dir}")
        return 1

    accepted: list[np.ndarray] = []
    for photo in photos:
        emb = embed_photo(photo)
        if emb is not None:
            accepted.append(emb)

    rejected = len(photos) - len(accepted)
    if not accepted:
        log("no photos accepted; roster not updated")
        print(f"photos: {len(photos)} total, 0 accepted, {rejected} rejected")
        print("enrollment FAILED: no usable face in any photo")
        return 1

    mean = np.mean(np.stack(accepted, axis=0), axis=0)
    mean = fc.l2_normalize(mean)

    roster = load_roster(args.out)
    roster = upsert_roster(roster, name, [float(v) for v in mean])
    write_roster_atomic(args.out, roster)

    print(f"photos: {len(photos)} total, {len(accepted)} accepted, {rejected} rejected")
    print(f"enrolled: {name}")
    print(f"embedding dim: {mean.shape[0]}")
    print(f"roster written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
