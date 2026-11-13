"""Read a COLMAP sparse model (what `spirula sfm auto` writes) for quick previews in the editor."""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np


def read_points3d_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        xyz = np.empty((n, 3), np.float64)
        rgb = np.empty((n, 3), np.uint8)
        for i in range(n):
            data = f.read(43)  # id(Q) xyz(3d) rgb(3B) err(d)
            _, x, y, z, r, g, b, _err = struct.unpack("<Q3d3Bd", data)
            xyz[i] = (x, y, z)
            rgb[i] = (r, g, b)
            (track_len,) = struct.unpack("<Q", f.read(8))
            f.seek(8 * track_len, 1)
    return xyz, rgb


def read_points3d_txt(path: Path) -> tuple[np.ndarray, np.ndarray]:
    pts, cols = [], []
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        t = line.split()
        pts.append([float(t[1]), float(t[2]), float(t[3])])
        cols.append([int(t[4]), int(t[5]), int(t[6])])
    return np.array(pts, np.float64).reshape(-1, 3), np.array(cols, np.uint8).reshape(-1, 3)


def read_images_bin(path: Path) -> np.ndarray:
    """Camera centres of registered images."""
    centres = []
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            _id, qw, qx, qy, qz, tx, ty, tz, _cam = struct.unpack("<I7dI", f.read(64))
            while f.read(1) != b"\x00":
                pass
            (np2d,) = struct.unpack("<Q", f.read(8))
            f.seek(24 * np2d, 1)
            r = _quat_to_r(qw, qx, qy, qz)
            centres.append(-r.T @ np.array([tx, ty, tz]))
    return np.array(centres).reshape(-1, 3)


def _quat_to_r(w, x, y, z):
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    n = len(xyz)
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {n}\nproperty float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    ).encode()
    rec = np.zeros(n, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rec["r"], rec["g"], rec["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    with open(path, "wb") as f:
        f.write(header)
        f.write(rec.tobytes())


def sparse_to_ply(sparse_dir: Path, out: Path) -> int:
    if (sparse_dir / "points3D.bin").exists():
        xyz, rgb = read_points3d_bin(sparse_dir / "points3D.bin")
    else:
        xyz, rgb = read_points3d_txt(sparse_dir / "points3D.txt")
    # Written in the model's own frame so it overlays the splat/mesh from the same run.
    # The editor has "Orient" tools (Z-up -> Y-up, level to ground) for fixing the up axis.
    write_ply(out, xyz, rgb)
    return len(xyz)
