"""One photo -> 3D: monocular depth (Spirula `geometry`, MoGe) -> textured relief mesh (GLB).

This is a 2.5D model: the side the camera saw, at metric scale, with the photo as texture.
Good for facades, banners, signs, walls, barriers and backgrounds; for a full 360° object
use several photos (photogrammetry job) instead.
"""
from __future__ import annotations

import json
import math
import shutil
import struct
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import spirula


def focal_px(img_path: Path, width: int, default_hfov: float = 63.0) -> float:
    """Focal length in pixels from EXIF (35 mm equivalent) or a typical phone field of view."""
    try:
        exif = Image.open(img_path).getexif()
        sub = exif.get_ifd(0x8769)
        f35 = sub.get(0xA405)  # FocalLengthIn35mmFilm
        if f35:
            return width * float(f35) / 36.0
    except Exception:  # noqa: BLE001
        pass
    return width / 2 / math.tan(math.radians(default_hfov) / 2)


def make_dataset(img_path: Path, ds: Path, max_side: int = 1600) -> dict:
    (ds / "images").mkdir(parents=True, exist_ok=True)
    img = cv2.imread(str(img_path))
    if img is None:
        raise RuntimeError(f"Cannot read image {img_path.name}")
    h, w = img.shape[:2]
    f = focal_px(img_path, w)
    s = min(1.0, max_side / max(w, h))
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        f *= s
    h, w = img.shape[:2]
    name = img_path.stem.replace(" ", "_") + ".jpg"
    cv2.imwrite(str(ds / "images" / name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cam = {"camera_model": "OPENCV", "fl_x": f, "fl_y": f, "cx": w / 2, "cy": h / 2, "w": w, "h": h,
           "frames": [{"file_path": f"images/{name}", "transform_matrix": np.eye(4).tolist()}]}
    (ds / "transforms.json").write_text(json.dumps(cam, indent=1), encoding="utf-8")
    return {"name": name, "f": f, "w": w, "h": h}


def read_depth(ds: Path, name: str) -> np.ndarray:
    stem = Path(name).stem
    cands = [p for p in (ds / "depths").glob(f"{stem}*") if p.suffix.lower() in (".png", ".exr", ".tif", ".tiff", ".npy")]
    if not cands:
        raise RuntimeError(f"Depth model wrote no map for {name} (looked in {ds / 'depths'}).")
    p = cands[0]
    if p.suffix == ".npy":
        return np.load(p).astype(np.float32)
    d = cv2.imread(str(p), cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if d is None:
        raise RuntimeError(f"Cannot read depth map {p.name}")
    if d.ndim == 3:
        d = d[..., 0]
    if p.suffix.lower() == ".png":  # millimetres; 65535 = clipped (sky / beyond 65.5 m)
        valid = d < 65535
        d = d.astype(np.float32) / 1000.0
        d[~valid] = 0
        return d
    return d.astype(np.float32)


def relief_mesh(depth: np.ndarray, f: float, w: int, h: int, grid: int = 320, max_depth: float = 0.0, edge: float = 0.12):
    """Back-project a depth map into a grid mesh (camera at origin, looking down -Z, Y up)."""
    if depth.shape[1] != w or depth.shape[0] != h:
        depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_NEAREST)
    step = max(1, int(round(max(w, h) / grid)))
    us = np.arange(0, w, step, dtype=np.float32)
    vs = np.arange(0, h, step, dtype=np.float32)
    uu, vv = np.meshgrid(us, vs)
    z = depth[vv.astype(int), uu.astype(int)]
    valid = z > 0.05
    if max_depth > 0:
        valid &= z <= max_depth
    x = (uu + 0.5 - w / 2) / f * z
    y = -(vv + 0.5 - h / 2) / f * z
    pos = np.stack([x, y, -z], -1).reshape(-1, 3).astype(np.float32)
    uv = np.stack([(uu + 0.5) / w, (vv + 0.5) / h], -1).reshape(-1, 2).astype(np.float32)
    rows, cols = z.shape
    idx = np.arange(rows * cols).reshape(rows, cols)
    a, b, c, d = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    zf = z.reshape(-1)
    vf = valid.reshape(-1)
    tris = []
    for t in (np.stack([a, c, b], -1), np.stack([b, c, d], -1)):
        t = t.reshape(-1, 3)
        zt = zf[t]
        ok = vf[t].all(1)
        # Cut triangles across depth jumps (object edges) so the background doesn't smear.
        ok &= (zt.max(1) - zt.min(1)) <= edge * zt.min(1)
        tris.append(t[ok])
    tri = np.concatenate(tris).astype(np.uint32)
    # drop unused vertices
    used = np.unique(tri)
    remap = np.full(len(pos), -1, np.int64)
    remap[used] = np.arange(len(used))
    pos, uv, tri = pos[used], uv[used], remap[tri].astype(np.uint32)
    # Put the model on the ground: bottom at y = 0, centred in x/z.
    pos[:, 1] -= pos[:, 1].min()
    pos[:, 0] -= (pos[:, 0].min() + pos[:, 0].max()) / 2
    pos[:, 2] -= (pos[:, 2].min() + pos[:, 2].max()) / 2
    return pos, uv, tri


def write_glb(path: Path, pos: np.ndarray, uv: np.ndarray, tri: np.ndarray, jpeg: bytes, name: str = "Photo relief") -> None:
    """Minimal glTF 2.0 binary: one textured, unlit, double-sided mesh."""
    blobs, views, accessors = [], [], []

    def add(data: bytes, target=None):
        off = sum(len(b) for b in blobs)
        pad = (-len(data)) % 4
        blobs.append(data + b"\0" * pad)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    vp = add(pos.astype("<f4").tobytes(), 34962)
    accessors.append({"bufferView": vp, "componentType": 5126, "count": len(pos), "type": "VEC3",
                      "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
    vu = add(uv.astype("<f4").tobytes(), 34962)
    accessors.append({"bufferView": vu, "componentType": 5126, "count": len(uv), "type": "VEC2"})
    vi = add(tri.astype("<u4").reshape(-1).tobytes(), 34963)
    accessors.append({"bufferView": vi, "componentType": 5125, "count": int(tri.size), "type": "SCALAR"})
    vimg = add(jpeg)
    gltf = {
        "asset": {"version": "2.0", "generator": "Track & Props Studio"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"name": "photo", "doubleSided": True, "extensions": {"KHR_materials_unlit": {}},
                       "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1}}],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": vimg, "mimeType": "image/jpeg"}],
        "buffers": [{"byteLength": sum(len(b) for b in blobs)}],
        "bufferViews": views, "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    bin_ = b"".join(blobs)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(bin_), 0x004E4942) + bin_)


def photo_to_relief(bin_: str, img_path: Path, work: Path, ctx, max_depth: float = 0.0, grid: int = 320) -> Path:
    ds = work / f"ds_{img_path.stem}"
    shutil.rmtree(ds, ignore_errors=True)
    meta = make_dataset(img_path, ds)
    cmd = [bin_, "geometry", str(ds), "--depth", "--depth-units", "mm", "--normal-format", "jpg"] + spirula.resource_args("geometry")
    spirula.run(cmd, ctx, (ctx.job.progress, min(0.95, ctx.job.progress + 0.3)))
    depth = read_depth(ds, meta["name"])
    pos, uv, tri = relief_mesh(depth, meta["f"], meta["w"], meta["h"], grid=grid, max_depth=max_depth)
    if len(tri) == 0:
        raise RuntimeError("Depth map gave no usable surface (try a lower 'max depth' cut or another photo).")
    ok, jpg = cv2.imencode(".jpg", cv2.imread(str(ds / "images" / meta["name"])), [cv2.IMWRITE_JPEG_QUALITY, 90])
    out = work / f"{img_path.stem}_relief.glb"
    write_glb(out, pos, uv, tri, jpg.tobytes(), name=img_path.stem)
    size = pos.max(0) - pos.min(0)
    ctx.log(f"{img_path.name}: {len(tri)} triangles, {size[0]:.2f} × {size[1]:.2f} × {size[2]:.2f} m (w × h × depth)")
    return out
