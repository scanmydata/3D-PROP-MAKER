"""Place a reconstruction on the map: fit SfM camera centres to the images' GPS.

Output: a 4x4 matrix (three.js column-major) that maps model coordinates to the editor's
local ENU frame around `origin` (x = east, y = up, z = south, meters) - the same frame the
procedural track, OSM data and LiDAR imports use, so everything lines up without manual work.

Up is estimated from the cameras themselves (their average "up" direction; photos are mostly
taken level and our Street View cut-outs are level by construction), then a 2-D similarity
(rotation about up + scale + shift) is fitted on the horizontal plane. That stays well-posed
even when all cameras lie on one straight street.
"""
from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np

from . import geo


def read_images(path: Path) -> list[dict]:
    out = []
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            _id, qw, qx, qy, qz, tx, ty, tz, _cam = struct.unpack("<I7dI", f.read(64))
            name = b""
            while (ch := f.read(1)) != b"\x00":
                name += ch
            (np2d,) = struct.unpack("<Q", f.read(8))
            f.seek(24 * np2d, 1)
            r = _quat(qw, qx, qy, qz)
            out.append({"name": name.decode("utf-8", "replace"), "R": r, "C": -r.T @ np.array([tx, ty, tz])})
    return out


def _quat(w, x, y, z):
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def _rot_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if c < -0.999999:
        axis = np.cross(a, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 0, 1])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def fit(cams: list[dict], gps: dict[str, tuple[float, float]], origin: tuple[float, float], camera_height: float) -> dict | None:
    pairs = [(c, gps[c["name"]]) for c in cams if c["name"] in gps]
    if len(pairs) < 3:
        return None
    proj = geo_projector(origin)
    C = np.array([c["C"] for c, _ in pairs])
    E = np.array([proj(ll) for _, ll in pairs])  # (x east, z south)
    # 1) level: average camera up (COLMAP cameras look +Z with +Y down -> up is -Y in camera frame)
    ups = np.array([c["R"].T @ np.array([0, -1.0, 0]) for c, _ in pairs])
    up = ups.mean(0)
    if np.linalg.norm(up) < 0.5:  # cameras disagree on up: fall back to model -Y
        up = np.array([0, -1.0, 0])
    for cand in (up, -up):  # a fit that needs a mirror means the up guess is upside down
        res = _fit_level(C, E, cand, camera_height, origin, len(pairs))
        if res:
            return res
    return None


def _fit_level(C, E, up, camera_height, origin, n):
    R1 = _rot_between(up, np.array([0, 1.0, 0]))
    P = C @ R1.T
    # 2) 2-D similarity on the horizontal plane (x, z)
    a = P[:, [0, 2]]
    b = E
    if np.ptp(b, axis=0).max() < 2.0:
        return None  # all images at one spot: scale/heading unknown
    ma, mb = a.mean(0), b.mean(0)
    A, B = a - ma, b - mb
    cov = B.T @ A / len(a)
    U, S, Vt = np.linalg.svd(cov)
    D = np.diag([1, np.sign(np.linalg.det(U @ Vt))])
    R2 = U @ D @ Vt
    s = float((S * np.diag(D)).sum() / (A ** 2).sum() * len(a))
    if D[1, 1] < 0:
        return None  # would need a mirror: the up axis guess is upside down
    t2 = mb - s * R2 @ ma
    # 3) compose into 3-D: rotation about Y by R2 (acting on x,z), uniform scale, shift
    R2_3 = np.array([[R2[0, 0], 0, R2[0, 1]], [0, 1, 0], [R2[1, 0], 0, R2[1, 1]]])
    Rt = R2_3 @ R1
    ty = camera_height - s * float((P[:, 1]).mean())
    M = np.eye(4)
    M[:3, :3] = s * Rt
    M[:3, 3] = [t2[0], ty, t2[1]]
    resid = (s * a @ R2.T + t2) - b
    rmse = float(np.sqrt((resid ** 2).sum(1).mean()))
    return {"origin": list(origin), "matrix": M.T.reshape(-1).tolist(), "scale": s, "rmse_m": rmse,
            "cameras": n, "frame": "ENU around origin: x=east, y=up, z=south (meters)"}


def geo_projector(origin):
    lat0, lon0 = origin
    k = math.cos(math.radians(lat0))

    def p(ll):
        lat, lon = ll
        east = math.radians(lon - lon0) * geo.EARTH_R * k
        north = math.radians(lat - lat0) * geo.EARTH_R
        return (east, -north)

    return p


def exif_gps(path: Path) -> tuple[float, float] | None:
    try:
        from PIL import Image

        gps = Image.open(path).getexif().get_ifd(0x8825)
        if not gps or 2 not in gps:
            return None

        def dms(v, ref):
            d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
            return -d if ref in ("S", "W") else d

        return dms(gps[2], gps.get(1, "N")), dms(gps[4], gps.get(3, "E"))
    except Exception:  # noqa: BLE001
        return None


def georeference(sparse: Path, images_dir: Path, out: Path, ctx, origin=None, camera_height: float = 1.6) -> dict | None:
    f = sparse / "images.bin"
    if not f.exists():
        return None
    cams = read_images(f)
    gps = {}
    for c in cams:
        g = exif_gps(images_dir / c["name"])
        if g:
            gps[c["name"]] = g
    if len(gps) < 3:
        ctx.log("Georeference skipped: fewer than 3 registered images carry GPS.")
        return None
    if origin is None:
        origin = tuple(np.array(list(gps.values())).mean(0))
    res = fit(cams, gps, tuple(origin), camera_height)
    if not res:
        ctx.log("Georeference skipped: camera positions too close together to fix scale and heading.")
        return None
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    ctx.log(f"Georeferenced on {res['cameras']} cameras: scale {res['scale']:.3f}, fit error {res['rmse_m']:.2f} m")
    return res


def add_train_frame(georef_path: Path, run_dir: Path) -> None:
    """Splats and meshes live in Spirula's training frame (scene_transform.json); store the
    georef for that frame too, as matrix_train = georef · world_from_train."""
    st = run_dir / "scene_transform.json"
    if not georef_path.exists() or not st.exists():
        return
    g = json.loads(georef_path.read_text(encoding="utf-8"))
    w = np.array(json.loads(st.read_text(encoding="utf-8"))["world_from_train"]["matrix_4x4"], dtype=float)
    m = np.array(g["matrix"], dtype=float).reshape(4, 4).T  # stored column-major
    g["matrix_train"] = (m @ w).T.reshape(-1).tolist()
    georef_path.write_text(json.dumps(g, indent=1), encoding="utf-8")
