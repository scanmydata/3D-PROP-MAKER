"""LiDAR / point-cloud scans: LAS, LAZ and PLY in a projected CRS (Greek data: EPSG:2100, ΕΓΣΑ87).

* to_local(): read a scan, thin it, shift it near the origin (float32-safe) and write a PLY that
  Spirula's `lidar` command and the editor can read, plus the matrix that places it in the
  editor's ENU frame (x = east, y = up, z = south) around a lat/lon origin.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import colmap


def read_cloud(path: Path, max_points: int, ctx=None):
    """xyz (float64), rgb (uint8 or None), ASPRS classification (uint8 or None), CRS stored in the file (or None)."""
    ext = path.suffix.lower()
    if ext in (".las", ".laz"):
        import laspy

        with laspy.open(str(path)) as fh:
            try:
                file_crs = fh.header.parse_crs()
            except Exception:  # noqa: BLE001 - malformed VLRs: fall back to the chosen code
                file_crs = None
            n = fh.header.point_count
            keep = min(1.0, max_points / max(1, n))
            xyz_parts, rgb_parts, cls_parts = [], [], []
            for chunk in fh.chunk_iterator(2_000_000):
                sel = np.random.random(len(chunk)) < keep if keep < 1 else slice(None)
                xyz_parts.append(np.stack([np.asarray(chunk.x)[sel], np.asarray(chunk.y)[sel], np.asarray(chunk.z)[sel]], 1))
                names = set(chunk.point_format.dimension_names)
                if {"red", "green", "blue"} <= names:
                    rgb = np.stack([np.asarray(chunk.red)[sel], np.asarray(chunk.green)[sel], np.asarray(chunk.blue)[sel]], 1).astype(np.float64)
                    rgb_parts.append(rgb)
                if "classification" in names:
                    cls_parts.append(np.asarray(chunk.classification)[sel].astype(np.uint8))
                if ctx:
                    ctx.check()
            xyz = np.concatenate(xyz_parts)
            rgb = None
            if rgb_parts:
                rgb = np.concatenate(rgb_parts)
                rgb = (rgb / (65535.0 if rgb.max() > 255 else 255.0) * 255).clip(0, 255).astype(np.uint8)
                if rgb.max() == 0:
                    rgb = None  # colour fields present but empty
            cls = np.concatenate(cls_parts) if cls_parts else None
            if cls is not None and not (cls > 1).any():
                cls = None  # all 'never classified' / 'unclassified'
            return xyz, rgb, cls, file_crs
    if ext == ".ply":
        return _read_ply_xyz(path, max_points)
    raise RuntimeError(f"Unsupported scan format {ext}: use LAS, LAZ or PLY (E57 can go straight to Spirula's alignment).")


def _read_ply_xyz(path: Path, max_points: int):
    with open(path, "rb") as f:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                raise RuntimeError("Bad PLY header")
            header += line
        text = header.decode("ascii", "replace")
        if "binary_little_endian" not in text:
            raise RuntimeError("Only binary little-endian PLY is supported")
        props, n, in_vertex = [], 0, False
        tmap = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8", "uchar": "u1", "uint8": "u1",
                "char": "i1", "int8": "i1", "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
                "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4"}
        for line in text.splitlines():
            p = line.split()
            if p[:2] == ["element", "vertex"]:
                n, in_vertex = int(p[2]), True
            elif p and p[0] == "element":
                in_vertex = False
            elif in_vertex and p and p[0] == "property":
                props.append((p[2], tmap[p[1]]))
        data = np.fromfile(f, dtype=np.dtype(props), count=n)
    if len(data) > max_points:
        data = data[np.random.choice(len(data), max_points, replace=False)]
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    names = data.dtype.names
    rgb = np.stack([data["red"], data["green"], data["blue"]], 1).astype(np.uint8) if {"red", "green", "blue"} <= set(names) else None
    return xyz, rgb, None, None


def elevation_colors(z: np.ndarray) -> np.ndarray:
    t = (z - np.percentile(z, 1)) / max(1e-6, np.percentile(z, 99) - np.percentile(z, 1))
    t = t.clip(0, 1)
    return (np.stack([0.2 + 0.8 * t, 0.35 + 0.5 * (1 - abs(t - 0.5) * 2), 1 - 0.8 * t], 1) * 255).astype(np.uint8)


def resolve_crs(crs):
    """EPSG code, WKT or pyproj CRS -> (pyproj CRS, meters per unit of its x/y axes)."""
    from pyproj import CRS

    c = crs if isinstance(crs, CRS) else CRS.from_user_input(crs)
    try:
        unit = float(c.axis_info[0].unit_conversion_factor) if c.axis_info else 1.0
    except Exception:  # noqa: BLE001
        unit = 1.0
    return c, unit if c.is_projected else 1.0


def enu_matrix(crs, offset: np.ndarray, origin: tuple[float, float], unit: float = 1.0) -> list[float]:
    """Affine map: local scan coords in meters (x, y, z with z up; native = local/unit + offset)
    -> editor ENU frame around origin."""
    from pyproj import Transformer

    tr = Transformer.from_crs(resolve_crs(crs)[0], 4326, always_xy=True)
    lat0, lon0 = origin
    k = math.cos(math.radians(lat0))
    R = 6371008.8

    def enu(x, y):
        lon, lat = tr.transform(x / unit + offset[0], y / unit + offset[1])
        return math.radians(lon - lon0) * R * k, math.radians(lat - lat0) * R

    e0, n0 = enu(0, 0)
    ex, nx = enu(100, 0)
    ey, ny = enu(0, 100)
    # columns: how scan +x, +y, +z map to three's (x=east, y=up, z=-north)
    cx = np.array([(ex - e0) / 100, 0, -(nx - n0) / 100])
    cy = np.array([(ey - e0) / 100, 0, -(ny - n0) / 100])
    cz = np.array([0, 1.0, 0])
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2] = cx, cy, cz
    # local z is already relative to offset[2] (ground near 0), the same height datum as the
    # procedural track / OSM (y = 0 at the ground), so no vertical shift here
    M[:3, 3] = [e0, 0.0, -n0]
    return M.T.reshape(-1).tolist()


def load_local(src: Path, epsg: int, origin: tuple[float, float] | None, max_points: int, ctx,
               offset: list[float] | None = None) -> dict:
    """Read a scan, convert it to meters and shift it near (0, 0, ground) so float32 keeps
    millimetres. Returns arrays + info. epsg = 0 reads the coordinate system stored in the file
    (falls back to EPSG:2100, Greek Grid). Pass `offset` to put several files in one frame."""
    xyz, rgb, cls, file_crs = read_cloud(src, max_points, ctx)
    if not len(xyz):
        raise RuntimeError(f"{src.name} has no points")
    if epsg:
        crs, unit = resolve_crs(int(epsg))
        if file_crs is not None and file_crs.to_epsg() not in (None, int(epsg)):
            ctx.log(f"Note: the file says its coordinate system is {file_crs.name}, but EPSG:{epsg} was chosen.")
    elif file_crs is not None:
        crs, unit = resolve_crs(file_crs)
        ctx.log(f"Coordinate system from the file: {crs.name}" + (f" (EPSG:{crs.to_epsg()})" if crs.to_epsg() else "")
                + (f", units {crs.axis_info[0].unit_name} -> converted to meters" if unit != 1.0 else ""))
    else:
        crs, unit = resolve_crs(2100)
        ctx.log("The file does not say its coordinate system: assuming EPSG:2100 (Greek Grid). Choose it in Map data if wrong.")
    if offset is not None:
        offset = np.asarray(offset, dtype=np.float64)
    else:
        offset = np.floor(xyz.min(0))
        offset[2] = math.floor(np.percentile(xyz[:, 2], 2))  # ground level near 0
    local = (xyz - offset) * unit  # meters
    if origin is None:
        from pyproj import Transformer

        c = xyz.mean(0)
        lon, lat = Transformer.from_crs(crs, 4326, always_xy=True).transform(c[0], c[1])
        origin = (lat, lon)
    info = {"points": int(len(xyz)), "epsg": crs.to_epsg(), "crs": crs.name, "unit_m": unit, "offset": offset.tolist(),
            "origin": list(origin), "matrix": enu_matrix(crs, offset, origin, unit),
            "bounds_m": (local.max(0) - local.min(0)).round(1).tolist(),
            "classified": cls is not None, "colored": rgb is not None,
            "frame": "ENU around origin: x=east, y=up, z=south (meters)"}
    ctx.log(f"{src.name}: {info['points']:,} points, {info['bounds_m'][0]} × {info['bounds_m'][1]} m, height range {info['bounds_m'][2]} m"
            f"{', classified' if cls is not None else ''}{', RGB' if rgb is not None else ''}")
    return {"xyz": local, "rgb": rgb, "cls": cls, "info": info}


def write_points(scan: dict, out_ply: Path, max_points: int) -> None:
    xyz, rgb = scan["xyz"], scan["rgb"]
    if rgb is None:
        rgb = elevation_colors(xyz[:, 2])
    if len(xyz) > max_points:
        sel = np.random.default_rng(0).choice(len(xyz), max_points, replace=False)
        xyz, rgb = xyz[sel], rgb[sel]
    colmap.write_ply(out_ply, xyz, rgb)


def to_local(src: Path, out_ply: Path, epsg: int, origin: tuple[float, float] | None, max_points: int, ctx) -> dict:
    scan = load_local(src, epsg, origin, max_points, ctx)
    write_points(scan, out_ply, max_points)
    return scan["info"]


GREEK_SOURCES = [
    {"name": "OpenTopography — Santorini 2012 airborne LiDAR (islands)", "url": "https://portal.opentopography.org/dataspace/dataset?opentopoID=OTDS.112018.32635.1", "type": "point cloud", "free": True},
    {"name": "OpenTopography — Corinth Canal satellite point clouds (mainland)", "url": "https://portal.opentopography.org/dataspace/dataset?opentopoID=OTDS.092023.32635.1", "type": "point cloud", "free": True},
    {"name": "OpenTopography — global DEMs (Copernicus GLO-30, etc.)", "url": "https://portal.opentopography.org/dataCatalog", "type": "DEM 30 m", "free": True},
    {"name": "Your own phone / tablet LiDAR (Polycam, Scaniverse, SiteScape → LAS/PLY/E57)", "url": "", "type": "point cloud", "free": True},
]


def save_info(info: dict, path: Path) -> None:
    path.write_text(json.dumps(info, indent=1), encoding="utf-8")
