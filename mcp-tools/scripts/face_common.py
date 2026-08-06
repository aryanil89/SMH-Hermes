#!/usr/bin/env python3
"""Shared CPU face-recognition pipeline: detect -> align -> embed.

Used by both `face_vision.py` (the identify.ts child-process backend) and
`enroll.py` (the roster-building CLI), so the two paths can never drift --
whatever embedding a photo produces at enrolment is directly comparable to
whatever embedding the same face produces at the door.

MODELS (buffalo_s, verified CPUExecutionProvider-only -- opencv/insightface
are unavailable on this Windows ARM64 box, see the environment note in the
caller's task):
  det_500m.onnx   SCRFD-500MF face detector. Input `input.1` [1,3,H,W]
                  (dynamic H/W). 9 outputs grouped [score, bbox, kps] x
                  3 strides (8/16/32), 2 anchors per grid cell -- this is
                  the standard insightface SCRFD export order, confirmed
                  against this exact file via `session.get_outputs()`.
  w600k_mbf.onnx  ArcFace MobileFaceNet embedder. Input `input.1`
                  [N,3,112,112], output 512-d, NOT normalized by the model.

PREPROCESSING is load-bearing and deliberately NOT configurable:
  detector: RGB, (x - 127.5) / 128.0, letterboxed onto a 640x640 canvas
            (top-left aligned, single uniform scale, zero-padded).
  embedder: RGB, 112x112, (x - 127.5) / 127.5, output L2-normalized here
            (the model does not normalize its own output).
  alignment: skimage SimilarityTransform fit from the 5 detected landmarks
            to the canonical ArcFace 112x112 destination template, then
            skimage.transform.warp back into the original image.
"""
from __future__ import annotations

import hashlib
import io
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from skimage.transform import SimilarityTransform, warp

# --------------------------------------------------------------------------
# Paths and constants
# --------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
MODELS_DIR = SCRIPT_DIR.parent / "models" / "buffalo_s"
DET_MODEL_PATH = MODELS_DIR / "det_500m.onnx"
REC_MODEL_PATH = MODELS_DIR / "w600k_mbf.onnx"

MODEL_NAME = "buffalo_s/w600k_mbf"

# Known-good sha256 of the shipped model files, for a load-time sanity check.
# A mismatch does not stop the pipeline (the file might legitimately have been
# updated) -- it just gets logged loudly, since a silently-swapped model is
# exactly the kind of thing that produces confidently wrong embeddings.
EXPECTED_DET_SHA256 = "5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a"
EXPECTED_REC_SHA256 = "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f"

# Decoded-image pixel ceiling: reject absurd images before doing any real
# decode work (PIL's Image.open() only reads the header; the ceiling check
# below runs before .convert()/asarray() force full pixel decode).
MAX_PIXELS = 40_000_000  # ~40 megapixels

# Detector
DET_INPUT_SIZE = 640
FEAT_STRIDES = (8, 16, 32)
NUM_ANCHORS = 2
SCORE_THRESH = 0.5
NMS_THRESH = 0.4

# Shared quality gate / output shape, used identically by face_vision.py and
# enroll.py so "what counts as a usable face" cannot drift between them.
MIN_FACE_SIDE = 80.0
MAX_FACES = 4
EMBEDDING_DIM = 512

# Canonical ArcFace 5-point destination template (112x112), the standard
# insightface `arcface_dst` -- left eye, right eye, nose, left mouth corner,
# right mouth corner.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def log(msg: str) -> None:
    """All diagnostics go to stderr -- stdout is reserved for the one JSON line."""
    print(f"[face_common] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# ONNX Runtime sessions -- lazy, created at most once per process
# --------------------------------------------------------------------------

_det_session = None
_rec_session = None
_model_version_cache: str | None = None


def _check_hash(path: Path, expected: str) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        log(f"WARNING: {path.name} sha256 {digest} != expected {expected}")
    return digest


def _make_session(path: Path):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3  # errors only -- keep stderr (and stdout) quiet
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


def get_det_session():
    global _det_session
    if _det_session is None:
        t0 = time.perf_counter()
        _check_hash(DET_MODEL_PATH, EXPECTED_DET_SHA256)
        _det_session = _make_session(DET_MODEL_PATH)
        log(f"det session loaded in {time.perf_counter() - t0:.3f}s")
    return _det_session


def get_rec_session():
    global _rec_session
    if _rec_session is None:
        t0 = time.perf_counter()
        _check_hash(REC_MODEL_PATH, EXPECTED_REC_SHA256)
        _rec_session = _make_session(REC_MODEL_PATH)
        log(f"rec session loaded in {time.perf_counter() - t0:.3f}s")
    return _rec_session


def model_version() -> str:
    """First 8 hex chars of the embedder's sha256 -- the `modelVersion` field."""
    global _model_version_cache
    if _model_version_cache is None:
        digest = hashlib.sha256(REC_MODEL_PATH.read_bytes()).hexdigest()
        _model_version_cache = digest[:8]
    return _model_version_cache


# --------------------------------------------------------------------------
# Image decode
# --------------------------------------------------------------------------


def decode_image(raw: bytes) -> np.ndarray:
    """Decode arbitrary image bytes to an HxWx3 uint8 RGB array.

    Raises ValueError (message safe to log/summarize as "invalid_image") for
    anything that is not a legitimate, reasonably-sized image. The pixel
    ceiling is checked from the header alone, before PIL is asked to decode
    actual pixel data.
    """
    if not raw:
        raise ValueError("empty image data")
    try:
        im = Image.open(io.BytesIO(raw))
        width, height = im.size  # header-only; no full decode yet
    except Exception as e:  # noqa: BLE001 - any decode failure is "invalid_image"
        raise ValueError(f"cannot identify image: {e}") from e

    if width <= 0 or height <= 0:
        raise ValueError(f"zero-size image ({width}x{height})")
    if width * height > MAX_PIXELS:
        raise ValueError(f"{width}x{height} ({width * height:,}px) exceeds ceiling {MAX_PIXELS:,}px")

    try:
        # Raw files copied straight off a phone (enroll.py, probe.py) carry
        # EXIF orientation -- portrait shots are stored as landscape pixels
        # plus a rotate tag. The live capture path (phone.html -> canvas)
        # bakes orientation into pixels and strips EXIF, so this is a no-op
        # there; without it here, portrait enrollment photos arrive sideways
        # and SCRFD misses or misaligns the face, silently weakening the
        # roster. Must run after the MAX_PIXELS header check above (it forces
        # a full pixel decode) but before .convert("RGB").
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        arr = np.asarray(im, dtype=np.uint8)
    except Exception as e:  # noqa: BLE001 - truncated/corrupt pixel data
        raise ValueError(f"failed to decode pixel data: {e}") from e

    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError(f"unexpected decoded shape {arr.shape}")
    return arr


# --------------------------------------------------------------------------
# Detection (SCRFD)
# --------------------------------------------------------------------------


@dataclass
class Detection:
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 -- original image px
    score: float
    kps: np.ndarray  # (5, 2) -- original image px

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)

    @property
    def min_side(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return min(x2 - x1, y2 - y1)


def _anchor_centers(height: int, width: int, stride: int) -> np.ndarray:
    ys, xs = np.mgrid[:height, :width]
    centers = np.stack([xs, ys], axis=-1).astype(np.float32) * stride
    centers = centers.reshape(-1, 2)
    if NUM_ANCHORS > 1:
        centers = np.repeat(centers, NUM_ANCHORS, axis=0)
    return centers


def _decode_stride(
    scores: np.ndarray,
    bbox_preds: np.ndarray,
    kps_preds: np.ndarray,
    stride: int,
    height: int,
    width: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    centers = _anchor_centers(height, width, stride)
    scores = scores.reshape(-1)
    bbox_preds = bbox_preds * stride
    kps_preds = kps_preds * stride

    keep = scores >= SCORE_THRESH
    if not np.any(keep):
        return (
            np.empty((0, 4), np.float32),
            np.empty((0,), np.float32),
            np.empty((0, 5, 2), np.float32),
        )

    c = centers[keep]
    bp = bbox_preds[keep]
    kp = kps_preds[keep]

    x1 = c[:, 0] - bp[:, 0]
    y1 = c[:, 1] - bp[:, 1]
    x2 = c[:, 0] + bp[:, 2]
    y2 = c[:, 1] + bp[:, 3]
    boxes = np.stack([x1, y1, x2, y2], axis=1)

    kps = np.zeros((kp.shape[0], 5, 2), dtype=np.float32)
    for i in range(5):
        kps[:, i, 0] = c[:, 0] + kp[:, i * 2]
        kps[:, i, 1] = c[:, 1] + kp[:, i * 2 + 1]

    return boxes, scores[keep], kps


def _nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= thresh]
    return keep


def detect_faces(img_rgb: np.ndarray) -> list[Detection]:
    """Detect faces, return Detections sorted by box area, largest first."""
    session = get_det_session()
    h0, w0 = img_rgb.shape[:2]
    scale = DET_INPUT_SIZE / max(h0, w0)
    new_h, new_w = max(1, round(h0 * scale)), max(1, round(w0 * scale))

    resized = np.asarray(
        Image.fromarray(img_rgb).resize((new_w, new_h), Image.BILINEAR), dtype=np.uint8
    )
    canvas = np.zeros((DET_INPUT_SIZE, DET_INPUT_SIZE, 3), dtype=np.uint8)
    canvas[:new_h, :new_w, :] = resized

    blob = (canvas.astype(np.float32) - 127.5) / 128.0
    blob = blob.transpose(2, 0, 1)[np.newaxis, ...]  # NCHW

    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: blob})
    # Standard SCRFD export order: [score x3 strides][bbox x3][kps x3].
    scores_all, bboxes_all, kps_all = outputs[0:3], outputs[3:6], outputs[6:9]

    all_boxes, all_scores, all_kps = [], [], []
    for idx, stride in enumerate(FEAT_STRIDES):
        fh, fw = DET_INPUT_SIZE // stride, DET_INPUT_SIZE // stride
        boxes, scores, kps = _decode_stride(
            scores_all[idx], bboxes_all[idx], kps_all[idx], stride, fh, fw
        )
        all_boxes.append(boxes)
        all_scores.append(scores)
        all_kps.append(kps)

    boxes = np.concatenate(all_boxes, axis=0)
    scores = np.concatenate(all_scores, axis=0)
    kps = np.concatenate(all_kps, axis=0)

    if boxes.shape[0] == 0:
        return []

    keep = _nms(boxes, scores, NMS_THRESH)
    boxes, scores, kps = boxes[keep], scores[keep], kps[keep]

    # Map back to original image coordinates and clip.
    boxes = boxes / scale
    kps = kps / scale
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, w0)
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, h0)

    detections = [
        Detection(
            bbox=(float(boxes[i, 0]), float(boxes[i, 1]), float(boxes[i, 2]), float(boxes[i, 3])),
            score=float(scores[i]),
            kps=kps[i],
        )
        for i in range(boxes.shape[0])
    ]
    detections.sort(key=lambda d: d.area, reverse=True)
    return detections


# --------------------------------------------------------------------------
# Alignment + embedding (ArcFace)
# --------------------------------------------------------------------------


def align_face(img_rgb: np.ndarray, kps: np.ndarray) -> np.ndarray:
    """Similarity-warp the 5 landmarks onto the ArcFace template -> 112x112 RGB."""
    tform = SimilarityTransform.from_estimate(kps.astype(np.float32), ARCFACE_DST)
    if not tform:
        raise ValueError(f"landmark alignment failed to converge: {tform}")
    warped = warp(
        img_rgb,
        tform.inverse,
        output_shape=(112, 112),
        preserve_range=True,
    )
    return warped.astype(np.float32)


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if norm < 1e-12:
        raise ValueError("zero-norm embedding")
    return vec / norm


def embed_aligned(aligned_rgb_112: np.ndarray) -> np.ndarray:
    """Run the embedder on an already-aligned 112x112 RGB array -> L2-normalized 512-d."""
    session = get_rec_session()
    blob = (aligned_rgb_112.astype(np.float32) - 127.5) / 127.5
    blob = blob.transpose(2, 0, 1)[np.newaxis, ...]  # NCHW
    input_name = session.get_inputs()[0].name
    out = session.run(None, {input_name: blob})[0]
    emb = out[0].astype(np.float64)
    if not np.all(np.isfinite(emb)):
        raise ValueError("embedder produced non-finite values")
    return l2_normalize(emb)


def embed_face(img_rgb: np.ndarray, det: Detection) -> np.ndarray:
    aligned = align_face(img_rgb, det.kps)
    return embed_aligned(aligned)
