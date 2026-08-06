#!/usr/bin/env python3
"""Standalone face-embedding viability probe. ZERO Hermes involvement.

Embeds a few reference photos each for two people, prints the full N x N
cosine similarity matrix, then PASS/FAIL against fixed thresholds:

    every same-person pair    >= 0.55
    every cross-person pair   <= 0.35
    margin = min(genuine) - max(impostor) >= 0.15

`--center-crop-only` skips detection/alignment entirely and center-crops to
square -> 112x112, to sanity-check the embedder/normalization path in
isolation from the SCRFD detector.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import face_common as fc  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def log(msg: str) -> None:
    print(f"[probe] {msg}", file=sys.stderr, flush=True)


def collect(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    return [path]


def center_crop_112(img_rgb: np.ndarray) -> np.ndarray:
    h, w = img_rgb.shape[:2]
    s = min(h, w)
    top, left = (h - s) // 2, (w - s) // 2
    crop = img_rgb[top : top + s, left : left + s]
    resized = Image.fromarray(crop).resize((112, 112), Image.BILINEAR)
    return np.asarray(resized, dtype=np.float32)


def embed_photo(path: Path, center_crop_only: bool) -> np.ndarray | None:
    try:
        img = fc.decode_image(path.read_bytes())
    except (OSError, ValueError) as e:
        log(f"skip {path}: invalid_image ({e})")
        return None

    try:
        if center_crop_only:
            return fc.embed_aligned(center_crop_112(img))

        dets = fc.detect_faces(img)
        if not dets:
            log(f"skip {path}: no_face")
            return None
        largest = dets[0]
        if largest.min_side < fc.MIN_FACE_SIDE:
            log(f"skip {path}: face_too_small ({largest.min_side:.1f}px)")
            return None
        return fc.embed_face(img, largest)
    except ValueError as e:
        log(f"skip {path}: embedding failed ({e})")
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, type=Path, help="folder or file(s) for person A")
    ap.add_argument("--b", required=True, type=Path, help="folder or file(s) for person B")
    ap.add_argument("--center-crop-only", action="store_true", help="skip detection/alignment")
    args = ap.parse_args()

    a_paths, b_paths = collect(args.a), collect(args.b)
    if not a_paths or not b_paths:
        log("both --a and --b must resolve to at least one image")
        return 1

    paths = a_paths + b_paths
    labels = [f"A:{p.name}" for p in a_paths] + [f"B:{p.name}" for p in b_paths]
    na = len(a_paths)

    embeddings = []
    for p in paths:
        emb = embed_photo(p, args.center_crop_only)
        if emb is None:
            log(f"FATAL: could not embed {p} -- probe requires every photo to yield a face")
            return 1
        embeddings.append(emb)

    n = len(embeddings)
    sim = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            sim[i, j] = float(np.dot(embeddings[i], embeddings[j]))

    col_w = max(10, max(len(lbl) for lbl in labels) + 1)
    print(" " * col_w + "".join(f"{lbl:>{col_w}}" for lbl in labels))
    for i, lbl in enumerate(labels):
        print(f"{lbl:<{col_w}}" + "".join(f"{sim[i, j]:>{col_w}.4f}" for j in range(n)))

    genuine, impostor = [], []
    for i in range(n):
        for j in range(i + 1, n):
            (genuine if (i < na) == (j < na) else impostor).append(sim[i, j])

    min_genuine = min(genuine) if genuine else float("nan")
    max_impostor = max(impostor) if impostor else float("nan")
    margin = min_genuine - max_impostor

    print()
    print(f"min(genuine)  = {min_genuine:.4f}   ({len(genuine)} same-person pairs)")
    print(f"max(impostor) = {max_impostor:.4f}   ({len(impostor)} cross-person pairs)")
    print(f"margin        = {margin:.4f}")
    print()

    ok_genuine = bool(genuine) and all(g >= 0.55 for g in genuine)
    ok_impostor = bool(impostor) and all(m <= 0.35 for m in impostor)
    ok_margin = margin >= 0.15
    passed = ok_genuine and ok_impostor and ok_margin

    print(f"{'genuine >= 0.55':<20}{'PASS' if ok_genuine else 'FAIL'}")
    print(f"{'impostor <= 0.35':<20}{'PASS' if ok_impostor else 'FAIL'}")
    print(f"{'margin >= 0.15':<20}{'PASS' if ok_margin else 'FAIL'}")
    print(f"{'OVERALL':<20}{'PASS' if passed else 'FAIL'}")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
