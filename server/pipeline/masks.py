"""Masks for SfM/training: white = keep, black = ignore (Spirula / COLMAP convention).

* Nadir mask for Street View panoramas (the car + blurred tripod area).
* Optional YOLO segmentation of moving objects (cars, people…), as in
  360-street-view-extractor/2_mask_panos.py (ultralytics YOLO11 segmentation; runs on the CPU so
  it never competes with Spirula for the GPU).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

MOVING_CLASSES = {"person", "car", "motorcycle", "bus", "truck", "bicycle"}
MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
WEIGHTS = ["yolo11n-seg.pt", "yolov8n-seg.pt"]


def yolo_available() -> bool:
    try:
        import ultralytics  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


_model = None


def _yolo():
    global _model
    if _model is None:
        from ultralytics import YOLO

        local = next((MODELS_DIR / w for w in WEIGHTS if (MODELS_DIR / w).exists()), None)
        if local is None:  # first use: download the 6 MB weights next to the server
            import os

            MODELS_DIR.mkdir(exist_ok=True)
            cwd = os.getcwd()
            os.chdir(MODELS_DIR)
            try:
                _model = YOLO(WEIGHTS[0])
            finally:
                os.chdir(cwd)
        else:
            _model = YOLO(str(local))
    return _model


def make_masks(images: list[Path], mask_dir: Path, ctx, nadir_fraction: float = 0.0, use_yolo: bool = False) -> int:
    if nadir_fraction <= 0 and not use_yolo:
        return 0
    if use_yolo and not yolo_available():
        ctx.log("ultralytics not installed - skipping AI masking (run: npm run setup).")
        use_yolo = False
        if nadir_fraction <= 0:
            return 0
    mask_dir.mkdir(parents=True, exist_ok=True)
    model = _yolo() if use_yolo else None
    count = 0
    for i, p in enumerate(images):
        ctx.check()
        img = cv2.imread(str(p))
        if img is None:
            continue
        h, w = img.shape[:2]
        mask = np.full((h, w), 255, np.uint8)
        if nadir_fraction > 0:
            mask[int(h * (1 - nadir_fraction)):, :] = 0
        if model is not None:
            res = model.predict(img, verbose=False, imgsz=1280, device="cpu")[0]
            if res.masks is not None:
                names = res.names
                for cls, m in zip(res.boxes.cls.tolist(), res.masks.data.cpu().numpy()):
                    if names[int(cls)] in MOVING_CLASSES:
                        m = cv2.resize((m > 0.5).astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_NEAREST)
                        m = cv2.dilate(m, np.ones((15, 15), np.uint8))
                        mask[m > 0] = 0
        cv2.imwrite(str(mask_dir / (p.name + ".png")), mask)
        count += 1
        if i % 10 == 0:
            ctx.log(f"masks {i + 1}/{len(images)}")
    ctx.log(f"Wrote {count} masks")
    return count
