"""Turn uploaded photos / videos (normal or 360°) into a clean image folder for SfM."""
from __future__ import annotations

import shutil
from pathlib import Path

import cv2
import numpy as np

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".insv", ".360", ".mts"}


def is_image(p: Path) -> bool:
    return p.suffix.lower() in IMAGE_EXT


def is_video(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXT


def looks_equirect(width: int, height: int) -> bool:
    return height > 0 and abs(width / height - 2.0) < 0.03


def sharpness(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def extract_frames(video: Path, out_dir: Path, target: int, ctx, max_side: int = 3840) -> list[Path]:
    """Pick ~`target` frames spread over the video, the sharpest one in each time bucket."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video {video.name}. Convert it to MP4 (H.264) and retry.")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ctx.log(f"{video.name}: {w}x{h}, {total} frames @ {fps:.1f} fps")
    if total <= 0:
        total = 10**9  # unknown length: read sequentially
    target = max(2, min(target, total))
    bucket = max(1, total // target)
    candidates_per_bucket = min(bucket, 6)  # look at up to 6 frames per bucket for sharpness
    stride = max(1, bucket // candidates_per_bucket)

    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    best = None
    best_score = -1.0
    idx = 0
    current_bucket = 0
    stem = video.stem.replace(" ", "_")
    while True:
        ctx.check()
        ok = cap.grab()
        if not ok:
            break
        if idx % stride == 0:
            ok, frame = cap.retrieve()
            if ok:
                small = cv2.resize(frame, (640, int(640 * frame.shape[0] / frame.shape[1])))
                score = sharpness(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
                if score > best_score:
                    best, best_score = frame, score
        idx += 1
        if idx // bucket != current_bucket:
            if best is not None:
                saved.append(_save_frame(best, out_dir, f"{stem}_{len(saved):05d}.jpg", max_side))
            best, best_score = None, -1.0
            current_bucket = idx // bucket
            if total < 10**9:
                ctx.progress(min(0.99, idx / total) * 0.15)
    if best is not None:
        saved.append(_save_frame(best, out_dir, f"{stem}_{len(saved):05d}.jpg", max_side))
    cap.release()
    ctx.log(f"Extracted {len(saved)} sharp frames from {video.name}")
    return saved


def _save_frame(frame: np.ndarray, out_dir: Path, name: str, max_side: int) -> Path:
    h, w = frame.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    p = out_dir / name
    cv2.imwrite(str(p), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return p


def collect_images(files: list[Path], out_dir: Path, ctx, frames_per_video: int) -> tuple[list[Path], bool]:
    """Copy images / extract video frames into out_dir. Returns (images, all_equirect)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    images: list[Path] = []
    for f in files:
        ctx.check()
        if is_video(f):
            images += extract_frames(f, out_dir, frames_per_video, ctx)
        elif is_image(f):
            dst = out_dir / f.name
            if f.resolve() != dst.resolve():
                shutil.copy2(f, dst)
            images.append(dst)
        else:
            ctx.log(f"Skipping unsupported file {f.name}")
    if not images:
        raise RuntimeError("No usable images or videos were provided.")
    equirect = True
    for p in images[:20]:
        img = cv2.imread(str(p), cv2.IMREAD_REDUCED_COLOR_4)
        if img is None or not looks_equirect(img.shape[1], img.shape[0]):
            equirect = False
            break
    return images, equirect


def equirect_to_perspective(img: np.ndarray, yaw_deg: float, pitch_deg: float, fov_deg: float, size: int) -> np.ndarray:
    """Rectilinear (pinhole) view out of an equirectangular panorama.

    Proper ray rotation (yaw about the vertical axis, then pitch), so straight lines stay
    straight - the fix the 360-street-view-extractor arrived at in pipeline2.py.
    """
    h, w = img.shape[:2]
    f = 0.5 * size / np.tan(np.deg2rad(fov_deg) / 2)
    xs, ys = np.meshgrid(np.arange(size) - size / 2 + 0.5, np.arange(size) - size / 2 + 0.5)
    rays = np.stack([xs, -ys, np.full_like(xs, f)], axis=-1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    p, y = np.deg2rad(pitch_deg), np.deg2rad(yaw_deg)
    rx = np.array([[1, 0, 0], [0, np.cos(p), np.sin(p)], [0, -np.sin(p), np.cos(p)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    d = rays @ (ry @ rx).T
    lon = np.arctan2(d[..., 0], d[..., 2])
    lat = np.arcsin(np.clip(d[..., 1], -1, 1))
    map_x = ((lon / np.pi + 1) / 2 * w).astype(np.float32)
    map_y = ((0.5 - lat / np.pi) * h).astype(np.float32)
    return cv2.remap(img, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)


def split_equirect_folder(src: list[Path], out_dir: Path, ctx, yaws=(0, 60, 120, 180, 240, 300), pitch=-5.0, fov=90.0, size=1600, heading_of=None) -> list[Path]:
    """Cut each panorama into overlapping perspective views (for tools without 360 support)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for i, p in enumerate(src):
        ctx.check()
        img = cv2.imread(str(p))
        if img is None:
            continue
        base = heading_of(p) if heading_of else 0.0
        for yaw in yaws:
            view = equirect_to_perspective(img, yaw - base, pitch, fov, size)
            dst = out_dir / f"{p.stem}_y{int(yaw):03d}.jpg"
            cv2.imwrite(str(dst), view, [cv2.IMWRITE_JPEG_QUALITY, 95])
            out.append(dst)
        ctx.progress(0.3 + 0.1 * (i + 1) / len(src))
    return out
