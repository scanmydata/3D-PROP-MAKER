"""Route geometry helpers: KML parsing, resampling, bearings, EXIF GPS."""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from pathlib import Path

EARTH_R = 6371008.8


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 360


def route_length(points: list[tuple[float, float]]) -> float:
    return sum(haversine(points[i], points[i + 1]) for i in range(len(points) - 1))


def resample(points: list[tuple[float, float]], step_m: float) -> list[tuple[float, float]]:
    """Evenly spaced samples along the polyline (true distance, unlike sampling vertices)."""
    if len(points) < 2:
        return list(points)
    out = [points[0]]
    carry = 0.0  # distance already travelled since the last emitted sample
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        seg = haversine(a, b)
        if seg <= 0:
            continue
        d = step_m - carry
        while d <= seg:
            f = d / seg
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            d += step_m
        carry = seg - (d - step_m)
    if haversine(out[-1], points[-1]) > step_m * 0.3:
        out.append(points[-1])
    return out


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_kml(data: bytes | str | Path) -> list[tuple[float, float]]:
    """Return the route as [(lat, lon)], from LineStrings, gx:Tracks, or ordered Points.

    Works with Google Maps / My Maps / Google Earth exports (namespace-agnostic).
    """
    if isinstance(data, Path):
        data = data.read_bytes()
    if isinstance(data, str):
        data = data.encode("utf-8")
    root = ET.fromstring(data)
    lines: list[list[tuple[float, float]]] = []
    points: list[tuple[float, float]] = []
    for el in root.iter():
        name = _local(el.tag)
        if name == "LineString":
            for c in el.iter():
                if _local(c.tag) == "coordinates" and c.text:
                    lines.append(_parse_coords(c.text))
        elif name == "Track":  # gx:Track
            pts = []
            for c in el:
                if _local(c.tag) == "coord" and c.text:
                    lon, lat, *_ = map(float, c.text.split())
                    pts.append((lat, lon))
            if pts:
                lines.append(pts)
        elif name == "Point":
            for c in el.iter():
                if _local(c.tag) == "coordinates" and c.text:
                    points.extend(_parse_coords(c.text))
    if lines:
        merged: list[tuple[float, float]] = []
        for line in lines:
            if merged and line and haversine(merged[-1], line[0]) < 1.0:
                line = line[1:]
            merged.extend(line)
        return merged
    return points


def _parse_coords(text: str) -> list[tuple[float, float]]:
    out = []
    for tok in text.replace("\n", " ").split():
        parts = tok.split(",")
        if len(parts) >= 2:
            lon, lat = float(parts[0]), float(parts[1])
            out.append((lat, lon))
    return out


def to_kml(points: list[tuple[float, float]], name: str = "Route") -> str:
    coords = " ".join(f"{lon:.7f},{lat:.7f},0" for lat, lon in points)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"<name>{name}</name><Placemark><name>{name}</name>"
        f"<LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString>"
        "</Placemark></Document></kml>\n"
    )


def _dms(deg: float):
    deg = abs(deg)
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return [(d, 1), (m, 1), (int(round(s * 10000)), 10000)]


def write_exif_gps(path: Path, lat: float, lon: float, alt: float = 2.5, heading: float | None = None) -> None:
    """Embed GPS in a JPEG so SfM (Spirula `--metric-gps auto`, RealityScan…) can recover metric scale."""
    import piexif
    from PIL import Image

    img = Image.open(path)
    exif_bytes = img.info.get("exif")
    img.close()
    exif = piexif.load(exif_bytes) if exif_bytes else {"0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": None}
    gps = {
        piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
        piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
        piexif.GPSIFD.GPSLatitude: _dms(lat),
        piexif.GPSIFD.GPSLongitudeRef: "E" if lon >= 0 else "W",
        piexif.GPSIFD.GPSLongitude: _dms(lon),
        piexif.GPSIFD.GPSAltitudeRef: 0,
        piexif.GPSIFD.GPSAltitude: (int(alt * 100), 100),
    }
    if heading is not None:
        gps[piexif.GPSIFD.GPSImgDirectionRef] = "T"
        gps[piexif.GPSIFD.GPSImgDirection] = (int((heading % 360) * 100), 100)
    exif["GPS"] = gps
    piexif.insert(piexif.dump(exif), str(path))
