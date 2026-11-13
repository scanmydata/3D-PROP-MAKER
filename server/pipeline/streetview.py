"""Download Google Street View imagery along a route (KML or drawn on the map).

Two sources:
* "panorama"  - full 360° equirectangular panoramas (the approach of
                360-street-view-extractor/1_download_panos.py), via pipeline/gsv.py. Uses
                Google's undocumented endpoints; check that your use complies with the
                Google Maps Platform terms.
* "static"    - the official Street View Static API (needs GOOGLE_API_KEY). Returns
                640x640 perspective views per heading; lower quality, but the documented API.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from . import geo, gsv


def fetch_panoramas(route: list[tuple[float, float]], out_dir: Path, ctx, step_m: float = 8.0, zoom: int = 4,
                    min_year: int = 0, search_radius: float = 25.0) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = geo.resample(route, step_m)
    ctx.log(f"Route {geo.route_length(route):.0f} m -> {len(samples)} sample points every {step_m} m")
    seen: set[str] = set()
    metas: list[dict] = []
    session = requests.Session()
    misses = 0
    for i, (lat, lon) in enumerate(samples):
        ctx.check()
        ctx.progress(0.02 + 0.33 * i / max(1, len(samples)))
        try:
            pano = gsv.find_panorama(lat, lon, search_radius, session)
        except Exception as exc:  # noqa: BLE001
            ctx.log(f"search failed at {lat:.6f},{lon:.6f}: {exc}")
            misses += 1
            if misses >= 10 and not metas:
                raise RuntimeError(f"Street View search keeps failing ({exc}). Google may have changed the endpoint.") from exc
            time.sleep(1.0)
            continue
        if not pano or pano.pano_id in seen:
            continue
        seen.add(pano.pano_id)
        if min_year and pano.year and pano.year < min_year:
            ctx.log(f"skip {pano.pano_id}: imagery from {pano.date} is older than {min_year}")
            continue
        dst = out_dir / f"{len(metas):04d}_{pano.pano_id}.jpg"
        if not dst.exists():
            try:
                img = gsv.download_panorama(pano, zoom, session)
                img.save(dst, quality=95)
            except Exception as exc:  # noqa: BLE001
                ctx.log(f"download {pano.pano_id} failed: {exc}")
                continue
        geo.write_exif_gps(dst, pano.lat, pano.lon, alt=2.5, heading=pano.heading)
        meta = {"file": dst.name, "pano_id": pano.pano_id, "lat": pano.lat, "lon": pano.lon,
                "heading": pano.heading, "date": pano.date}
        metas.append(meta)
        ctx.log(f"pano {len(metas)}: {pano.pano_id} {pano.date or ''} ({pano.lat:.5f},{pano.lon:.5f})")
    (out_dir / "panoramas.json").write_text(json.dumps(metas, indent=1), encoding="utf-8")
    if not metas:
        raise RuntimeError("No Street View panoramas found along this route.")
    return metas


STATIC_URL = "https://maps.googleapis.com/maps/api/streetview"
META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"


def fetch_static_views(route: list[tuple[float, float]], out_dir: Path, ctx, api_key: str, step_m: float = 8.0,
                       headings_rel=(0, 45, -45, 90, -90, 135, -135, 180), fov: int = 90, pitch: int = 0) -> list[dict]:
    if not api_key:
        raise RuntimeError("The official Street View Static API needs a Google API key (Settings -> Google API key).")
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = geo.resample(route, step_m)
    seen: set[str] = set()
    metas: list[dict] = []
    session = requests.Session()
    for i, (lat, lon) in enumerate(samples):
        ctx.check()
        ctx.progress(0.02 + 0.33 * i / max(1, len(samples)))
        r = session.get(META_URL, params={"location": f"{lat},{lon}", "key": api_key, "source": "outdoor"}, timeout=20)
        m = r.json()
        if m.get("status") != "OK" or m.get("pano_id") in seen:
            continue
        seen.add(m["pano_id"])
        plat, plon = m["location"]["lat"], m["location"]["lng"]
        nxt = samples[min(i + 1, len(samples) - 1)]
        prv = samples[max(i - 1, 0)]
        forward = geo.bearing(prv, nxt) if nxt != prv else 0.0
        for rel in headings_rel:
            h = (forward + rel) % 360
            img = session.get(STATIC_URL, params={"size": "640x640", "pano": m["pano_id"], "heading": f"{h:.1f}",
                                                  "fov": fov, "pitch": pitch, "key": api_key, "return_error_code": "true"},
                              timeout=30)
            if img.status_code != 200:
                ctx.log(f"static view failed: HTTP {img.status_code}")
                continue
            dst = out_dir / f"{len(seen):04d}_{m['pano_id']}_h{int(h):03d}.jpg"
            dst.write_bytes(img.content)
            geo.write_exif_gps(dst, plat, plon, alt=2.5, heading=h)
            metas.append({"file": dst.name, "pano_id": m["pano_id"], "lat": plat, "lon": plon, "heading": h, "date": m.get("date")})
        ctx.log(f"location {len(seen)}: {m['pano_id']} {m.get('date', '')}")
    (out_dir / "views.json").write_text(json.dumps(metas, indent=1), encoding="utf-8")
    if not metas:
        raise RuntimeError("No Street View imagery found along this route.")
    return metas
