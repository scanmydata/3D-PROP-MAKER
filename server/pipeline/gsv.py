"""Minimal Google Street View panorama client (search by location + tile download).

Google turned off the old `GeoPhotoService.SingleImageSearch` endpoint that the `streetview`
package (and the original 360-street-view-extractor) relied on. This talks to the endpoint the
Maps JavaScript API uses today. The request/response layout follows the open-source
`streetlevel` project (MIT, https://github.com/sk-zk/streetlevel).

These are undocumented endpoints: they can change without notice, and you are responsible for
using the imagery in line with Google's terms.
"""
from __future__ import annotations

import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import requests
from PIL import Image

SEARCH_URL = "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch"
TILE_URL = "https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid={id}&x={x}&y={y}&zoom={z}"
TILE_HEADERS = {
    "Origin": "https://www.google.com",
    "Referer": "https://www.google.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
}


@dataclass
class Pano:
    pano_id: str
    lat: float
    lon: float
    heading: float  # degrees, direction of the panorama's centre column
    date: str | None  # "YYYY-MM"
    elevation: float | None
    image_sizes: list[tuple[int, int]]  # (w, h) per zoom level
    tile_size: tuple[int, int]

    @property
    def year(self) -> int:
        return int(self.date[:4]) if self.date else 0


def _get(fn, default=None):
    try:
        return fn()
    except (IndexError, KeyError, TypeError):
        return default


def _search_body(lat: float, lon: float, radius: float) -> str:
    return json.dumps([
        ["apiv3", None, None, None, "US"],
        [[None, None, lat, lon], float(radius)],
        [None, ["en", "US"], None, None, None, None, None, None, [2], None, [[[2, True, 2]]]],  # official imagery only
        [[1, 2, 3, 4, 6, 8, 12], None, None, None, [], []],
    ])


def find_panorama(lat: float, lon: float, radius: float = 25.0, session: requests.Session | None = None) -> Pano | None:
    s = session or requests
    r = s.post(SEARCH_URL, data=_search_body(lat, lon, radius), headers={"content-type": "application/json+protobuf"}, timeout=20)
    r.raise_for_status()
    data = r.json()
    if _get(lambda: data[0][0]) != 0:
        return None  # 5 = nothing in radius
    msg = data[1]
    sizes = [(s_[0][1], s_[0][0]) for s_ in msg[2][3][0]]
    date = _get(lambda: msg[6][7])
    return Pano(
        pano_id=msg[1][1],
        lat=float(msg[5][0][1][0][2]),
        lon=float(msg[5][0][1][0][3]),
        heading=float(_get(lambda: msg[5][0][1][2][0], 0.0) or 0.0),
        date=f"{date[0]}-{date[1]:02d}" if date else None,
        elevation=_get(lambda: msg[5][0][1][1][0]),
        image_sizes=sizes,
        tile_size=(msg[2][3][1][0], msg[2][3][1][1]),
    )


def download_panorama(pano: Pano, zoom: int = 4, session: requests.Session | None = None, workers: int = 8) -> Image.Image:
    """Stitch the equirectangular panorama at `zoom` (clamped to what the pano has)."""
    zoom = max(0, min(zoom, len(pano.image_sizes) - 1))
    w, h = pano.image_sizes[zoom]
    tw, th = pano.tile_size
    cols, rows = math.ceil(w / tw), math.ceil(h / th)
    s = session or requests.Session()
    canvas = Image.new("RGB", (w, h))

    def fetch(xy):
        x, y = xy
        for _ in range(3):
            r = s.get(TILE_URL.format(id=pano.pano_id, x=x, y=y, z=zoom), headers=TILE_HEADERS, timeout=30)
            if r.status_code == 200:
                return x, y, Image.open(io.BytesIO(r.content)).convert("RGB")
        raise RuntimeError(f"tile {x},{y} of {pano.pano_id}: HTTP {r.status_code}")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for x, y, tile in ex.map(fetch, [(x, y) for y in range(rows) for x in range(cols)]):
            canvas.paste(tile, (x * tw, y * th))
    return canvas
