"""OpenStreetMap (Overpass) through the backend: disk cache, polite User-Agent, retries, mirrors.

The public Overpass servers are often "at capacity" or hang; going through here means the
same area is downloaded once (cached in workspace/cache/osm) and busy servers are retried.
"""
from __future__ import annotations

import hashlib
import json
import time

import requests

import config

SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
HEADERS = {"User-Agent": "TrackPropsStudio/2.0 (desktop app; overpass client)", "Accept": "application/json"}
MAX_AGE_S = 30 * 24 * 3600  # map data changes slowly


def _cache_path(query: str):
    d = config.work_dir() / "cache" / "osm"
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha1(query.encode()).hexdigest() + ".json")


def query(q: str, deadline_s: float = 150) -> dict:
    path = _cache_path(q)
    if path.exists() and time.time() - path.stat().st_mtime < MAX_AGE_S:
        data = json.loads(path.read_text(encoding="utf-8"))
        data["cached"] = True
        return data
    start = time.time()
    errors = []
    attempt = 0
    while time.time() - start < deadline_s:
        for url in SERVERS:
            if time.time() - start >= deadline_s:
                break
            try:
                r = requests.post(url, data={"data": q}, headers=HEADERS, timeout=(8, 40))
                if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
                    data = r.json()
                    if data.get("elements") or not data.get("remark"):
                        path.write_text(json.dumps(data), encoding="utf-8")
                        return data
                    errors.append(f"{url.split('/')[2]}: {data['remark'][:80]}")
                else:
                    errors.append(f"{url.split('/')[2]}: HTTP {r.status_code}")
            except requests.RequestException as exc:
                errors.append(f"{url.split('/')[2]}: {type(exc).__name__}")
        attempt += 1
        time.sleep(min(15, 4 * attempt))  # busy servers: back off, then go round again
    raise RuntimeError("OpenStreetMap servers are busy right now (" + "; ".join(errors[-4:]) + "). Try again in a few minutes.")
