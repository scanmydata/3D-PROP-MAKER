"""LiDAR scan -> 3D map and 3D objects, without a GPU.

* terrain():  bare-earth surface (DTM) as a textured GLB, coloured from the scan's RGB (or by
  height) with baked hill-shading so slopes read well.
* objects():  buildings (footprint outline + roof height) and trees (position, height, crown) as
  JSON; the editor turns them into separate, named, editable props.

Everything is in the scan's local frame (x = easting, y = northing, z = up, shifted near 0 by
lidar.load_local); the job's georef matrix places it on the map, like the point cloud.

Ground/building/tree split: ASPRS classes when the file has them (2 ground, 3-5 vegetation,
6 building), otherwise a morphological ground filter + roof-flatness test.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np

from .photo3d import write_glb

GROUND, VEG, BUILDING = 2, (3, 4, 5), 6


def _grid(xyz: np.ndarray, cell: float):
    x0, y0 = xyz[:, 0].min(), xyz[:, 1].min()
    w = int(math.ceil((xyz[:, 0].max() - x0) / cell)) + 1
    h = int(math.ceil((xyz[:, 1].max() - y0) / cell)) + 1
    j = ((xyz[:, 0] - x0) / cell).astype(np.int64).clip(0, w - 1)
    i = ((xyz[:, 1] - y0) / cell).astype(np.int64).clip(0, h - 1)
    return (x0, y0, w, h), i, j


def _reduce(i, j, h, w, values, how: str) -> np.ndarray:
    flat = i * w + j
    if how == "min":
        out = np.full(h * w, np.inf)
        np.minimum.at(out, flat, values)
        out[np.isinf(out)] = np.nan
    elif how == "max":
        out = np.full(h * w, -np.inf)
        np.maximum.at(out, flat, values)
        out[np.isinf(out)] = np.nan
    else:  # mean
        s = np.bincount(flat, values, h * w)
        n = np.bincount(flat, None, h * w)
        out = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return out.reshape(h, w)


def fill_holes(grid: np.ndarray) -> np.ndarray:
    """Fill NaN cells from their neighbours with growing box filters (cheap inpainting)."""
    g = grid.astype(np.float32).copy()
    valid = np.isfinite(g)
    if valid.all() or not valid.any():
        return np.nan_to_num(g)
    k = 3
    while not valid.all() and k < 2 * max(g.shape) + 3:
        num = cv2.blur(np.where(valid, g, 0).astype(np.float32), (k, k), borderType=cv2.BORDER_REPLICATE)
        den = cv2.blur(valid.astype(np.float32), (k, k), borderType=cv2.BORDER_REPLICATE)
        fill = (~valid) & (den > 1e-3)
        g[fill] = num[fill] / den[fill]
        valid = valid | fill
        k = k * 2 + 1
    return np.nan_to_num(g)


def ground_model(scan: dict, cell: float, ctx=None) -> dict:
    """Digital terrain model on a regular grid + which points are ground."""
    xyz, cls = scan["xyz"], scan["cls"]
    (x0, y0, w, h), i, j = _grid(xyz, cell)
    use_classes = cls is not None and (cls == GROUND).sum() > max(500, 0.02 * len(cls))
    if use_classes:
        g = cls == GROUND
        dtm = _reduce(i[g], j[g], h, w, xyz[g, 2], "mean")
        method = "LAS classification (class 2 = ground)"
    else:
        # Lowest point per cell, then a morphological opening wider than a building removes
        # roofs and canopies; what is left is the ground (works for urban and gentle terrain).
        zmin = fill_holes(_reduce(i, j, h, w, xyz[:, 2], "min"))
        k = max(3, int(round(24.0 / cell)) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        opened = cv2.dilate(cv2.erode(zmin, kernel), kernel)
        dtm = np.minimum(zmin, cv2.GaussianBlur(opened, (0, 0), max(1.0, 2.0 / cell)))
        near = xyz[:, 2] - dtm[i, j] < 0.35
        dtm = _reduce(i[near], j[near], h, w, xyz[near, 2], "mean")
        method = "automatic ground filter (file has no ground class)"
    covered = np.isfinite(_reduce(i, j, h, w, xyz[:, 2], "min"))
    dtm = fill_holes(dtm)
    dtm = cv2.GaussianBlur(dtm, (0, 0), 0.6)
    hag = xyz[:, 2] - dtm[i, j]
    if ctx:
        ctx.log(f"Ground: {method}; grid {w} × {h} cells of {cell:.2f} m")
    return {"dtm": dtm, "x0": x0, "y0": y0, "w": w, "h": h, "cell": cell, "i": i, "j": j, "hag": hag,
            "covered": covered, "method": method}


def _hillshade(dtm: np.ndarray, cell: float) -> np.ndarray:
    gy, gx = np.gradient(dtm, cell)
    n = np.dstack([-gx, -gy, np.ones_like(dtm)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    light = np.array([-0.5, 0.6, 0.62])
    light /= np.linalg.norm(light)
    return (n @ light).clip(0, 1)


def terrain(scan: dict, gm: dict, out_glb: Path, ctx=None) -> dict:
    """Write the DTM as a textured, hill-shaded GLB (scan-local frame)."""
    dtm, cell, h, w = gm["dtm"], gm["cell"], gm["h"], gm["w"]
    i, j, hag = gm["i"], gm["j"], gm["hag"]
    near = np.abs(hag) < 0.4
    if scan["rgb"] is not None:
        rgb = np.dstack([fill_holes(_reduce(i[near], j[near], h, w, scan["rgb"][near, c].astype(np.float64), "mean")) for c in range(3)]) / 255.0
        shade = 0.75 + 0.25 * _hillshade(dtm, cell)[..., None]
    else:
        t = (dtm - np.percentile(dtm, 1)) / max(0.5, np.percentile(dtm, 99) - np.percentile(dtm, 1))
        t = t.clip(0, 1)[..., None]
        low, high = np.array([0.42, 0.52, 0.33]), np.array([0.72, 0.66, 0.52])  # grass -> dry earth
        rgb = low * (1 - t) + high * t
        shade = 0.35 + 0.75 * _hillshade(dtm, cell)[..., None]
    img = (rgb * shade * 255).clip(0, 255).astype(np.uint8)
    scale = 2 if max(h, w) <= 2048 else 1
    if scale > 1:
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_LINEAR)
    ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Keep only cells near real data (no skirt of invented terrain far outside the scan).
    keep = cv2.dilate(gm["covered"].astype(np.uint8), np.ones((max(3, int(8 / cell) | 1),) * 2, np.uint8)) > 0
    jj, ii = np.meshgrid(np.arange(w), np.arange(h))
    pos = np.stack([gm["x0"] + (jj + 0.5) * cell, gm["y0"] + (ii + 0.5) * cell, dtm], -1).reshape(-1, 3)
    uv = np.stack([(jj + 0.5) / w, (ii + 0.5) / h], -1).reshape(-1, 2)
    a = (ii[:-1, :-1] * w + jj[:-1, :-1]).reshape(-1)
    quad_keep = (keep[:-1, :-1] & keep[1:, 1:] & keep[:-1, 1:] & keep[1:, :-1]).reshape(-1)
    a = a[quad_keep]
    b, c, d = a + 1, a + w + 1, a + w
    tri = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    used = np.unique(tri)
    remap = np.full(len(pos), -1, np.int64)
    remap[used] = np.arange(len(used))
    write_glb(out_glb, pos[used], uv[used], remap[tri], jpg.tobytes(), name="LiDAR terrain")
    if ctx:
        ctx.log(f"Terrain mesh: {len(tri):,} triangles, {len(used):,} vertices")
    return {"triangles": int(len(tri)), "cell_m": cell}


def _components(mask: np.ndarray, min_cells: int):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return [(k, stats[k]) for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= min_cells], labels


def objects(scan: dict, gm: dict, out_json: Path, ctx=None, min_building_m2: float = 15.0,
            min_height: float = 2.5, max_trees: int = 4000) -> dict:
    """Buildings (outline + height) and trees (position + size) from the points above the ground."""
    xyz, cls, hag = scan["xyz"], scan["cls"], gm["hag"]
    cell = max(0.5, min(1.0, gm["cell"]))
    above = hag > min_height
    if cls is not None and ((cls == BUILDING).any() or np.isin(cls, VEG).any()):
        b_pts = above & (cls == BUILDING)
        v_pts = above & np.isin(cls, VEG)
        mode = "classes"
    else:
        b_pts = v_pts = above
        mode = "auto"
    (x0, y0, w, h), i, j = _grid(xyz, cell)
    dtm_at = lambda ii, jj: gm["dtm"][((y0 + (ii + 0.5) * cell - gm["y0"]) / gm["cell"]).astype(int).clip(0, gm["h"] - 1),  # noqa: E731
                                     ((x0 + (jj + 0.5) * cell - gm["x0"]) / gm["cell"]).astype(int).clip(0, gm["w"] - 1)]

    def top_surface(sel):
        top = _reduce(i[sel], j[sel], h, w, hag[sel], "max")
        return top

    buildings, trees = [], []
    # ---- buildings ----
    btop = top_surface(b_pts)
    bmask = np.isfinite(btop)
    bmask = cv2.morphologyEx(bmask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    veg_mask = None
    if mode == "auto":
        # Roof facets (flat or pitched) are locally planar: small Laplacian. Tree crowns are not.
        top_f = fill_holes(np.where(bmask, btop, np.nan)).astype(np.float32)
        lap = np.abs(cv2.Laplacian(top_f, cv2.CV_32F, ksize=1))
        lap = cv2.medianBlur(lap, 5)
        smooth = bmask & (lap < 0.6)
        smooth = cv2.morphologyEx(smooth.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        veg_mask = bmask & ~(cv2.dilate(smooth.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        bmask = smooth
    else:
        bmask = cv2.morphologyEx(bmask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)) > 0
    zsel = b_pts
    roof_abs = _reduce(i[zsel], j[zsel], h, w, xyz[zsel, 2], "max")
    # without LAS classes, small blobs are mostly bridge / wall / vehicle fragments, not buildings
    min_area = min_building_m2 if mode == "classes" else max(min_building_m2, 30.0)
    comps, labels = _components(bmask, int(min_area / cell ** 2))
    for k, st in comps:
        m = labels == k
        roofs = roof_abs[m & np.isfinite(roof_abs)]
        if not len(roofs):
            continue
        area = st[cv2.CC_STAT_AREA] * cell * cell
        cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = max(cnts, key=cv2.contourArea)
        if min(cv2.minAreaRect(cnt)[1]) * cell < 4.0:
            continue  # long and thin: a bridge, wall or power line, not a building
        poly = cv2.approxPolyDP(cnt, max(1.0, 0.7 / cell), True).reshape(-1, 2).astype(np.float64)
        if len(poly) < 3:
            continue
        ii, jj = np.nonzero(m)
        base = float(np.percentile(dtm_at(ii, jj), 10))  # lowest ground along the footprint: no floating on slopes
        top = float(np.percentile(roofs, 90))
        eave = float(np.percentile(roofs, 15))
        xy = np.stack([x0 + (poly[:, 0] + 0.5) * cell, y0 + (poly[:, 1] + 0.5) * cell], 1)
        buildings.append({"name": f"LiDAR building {len(buildings) + 1}", "outline": xy.round(2).tolist(),
                          "base": round(base, 2), "height": round(max(min_height, top - base), 2),
                          "eave_height": round(max(min_height, eave - base), 2), "area_m2": round(area, 1)})
    # ---- trees ----
    if mode == "classes":
        vtop = top_surface(v_pts)
        vmask = np.isfinite(vtop)
    else:
        vtop = btop
        vmask = veg_mask
    if vmask.any():
        vt = np.where(vmask, np.nan_to_num(vtop, nan=0.0), 0).astype(np.float32)
        vt = cv2.GaussianBlur(vt, (0, 0), 0.8)
        win = max(3, int(round(3.0 / cell)) | 1)
        peaks = (vt == cv2.dilate(vt, np.ones((win, win), np.uint8))) & (vt > min_height) & vmask
        vcomps, vlabels = _components(vmask, 2)
        area_of = {k: st[cv2.CC_STAT_AREA] * cell * cell for k, st in vcomps}
        pi, pj = np.nonzero(peaks)
        order = np.argsort(-vt[pi, pj])[:max_trees]
        per_comp: dict[int, int] = {}
        for idx in order:
            per_comp[int(vlabels[pi[idx], pj[idx]])] = per_comp.get(int(vlabels[pi[idx], pj[idx]]), 0) + 1
        for idx in order:
            a, b = pi[idx], pj[idx]
            lab = int(vlabels[a, b])
            if lab not in area_of:
                continue
            radius = math.sqrt(area_of[lab] / max(1, per_comp[lab]) / math.pi)
            trees.append({"x": round(x0 + (b + 0.5) * cell, 2), "y": round(y0 + (a + 0.5) * cell, 2),
                          "base": round(float(dtm_at(np.array([a]), np.array([b]))[0]), 2),
                          "height": round(float(vt[a, b]), 2), "radius": round(min(8.0, max(0.8, radius)), 2)})
    out = {"frame": "scan-local (x east, y north, z up); apply georef matrix", "mode": mode,
           "ground": gm["method"], "buildings": buildings, "trees": trees}
    out_json.write_text(json.dumps(out), encoding="utf-8")
    if ctx:
        ctx.log(f"Objects ({'LAS classes' if mode == 'classes' else 'automatic'}): {len(buildings)} buildings, {len(trees)} trees")
    return {"buildings": len(buildings), "trees": len(trees)}


def auto_cell(scan: dict, requested: float | None = None) -> float:
    if requested:
        return float(requested)
    ext = scan["xyz"][:, :2].max(0) - scan["xyz"][:, :2].min(0)
    area = float(ext[0] * ext[1])
    density = len(scan["xyz"]) / max(1.0, area)  # points per m²
    cell = max(0.5, 1.5 / math.sqrt(max(density, 1e-3)))  # ~2 points per cell
    return round(max(cell, math.sqrt(area / 1_500_000)), 2)  # at most ~1.5 M cells
