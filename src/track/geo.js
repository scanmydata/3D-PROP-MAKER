/** Geographic helpers for routes: KML, distances, local metric projection, routing, elevation. */

const R = 6371008.8;
const D2R = Math.PI / 180;

export function haversine([lat1, lon1], [lat2, lon2]) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function routeLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i += 1) d += haversine(points[i - 1], points[i]);
  return d;
}

export function fmtDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** WGS84 -> local East-North-Up meters around `origin`; returned as three.js (x = east, y = up, z = -north). */
export function makeProjector([lat0, lon0], h0 = 0) {
  const a = 6378137; const f = 1 / 298.257223563; const e2 = f * (2 - f);
  const ecef = (lat, lon, h) => {
    const sl = Math.sin(lat * D2R); const cl = Math.cos(lat * D2R);
    const N = a / Math.sqrt(1 - e2 * sl * sl);
    return [(N + h) * cl * Math.cos(lon * D2R), (N + h) * cl * Math.sin(lon * D2R), (N * (1 - e2) + h) * sl];
  };
  const o = ecef(lat0, lon0, h0);
  const sl = Math.sin(lat0 * D2R); const cl = Math.cos(lat0 * D2R);
  const so = Math.sin(lon0 * D2R); const co = Math.cos(lon0 * D2R);
  return ([lat, lon], h = h0) => {
    const p = ecef(lat, lon, h);
    const dx = p[0] - o[0]; const dy = p[1] - o[1]; const dz = p[2] - o[2];
    const east = -so * dx + co * dy;
    const north = -sl * co * dx - sl * so * dy + cl * dz;
    const up = cl * co * dx + cl * so * dy + sl * dz;
    return { x: east, y: up, z: -north };
  };
}

// ---- KML ---------------------------------------------------------------

export function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid KML file');
  const byLocal = (name) => [...doc.getElementsByTagName('*')].filter((n) => n.localName === name);
  const parseCoords = (s) => s.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2 && c.every(Number.isFinite)).map(([lon, lat]) => [lat, lon]);
  const lines = [];
  byLocal('LineString').forEach((ls) => {
    const c = [...ls.getElementsByTagName('*')].find((n) => n.localName === 'coordinates');
    if (c) lines.push(parseCoords(c.textContent));
  });
  byLocal('Track').forEach((tr) => {
    const pts = [...tr.getElementsByTagName('*')].filter((n) => n.localName === 'coord').map((n) => n.textContent.trim().split(/\s+/).map(Number)).map(([lon, lat]) => [lat, lon]);
    if (pts.length) lines.push(pts);
  });
  if (lines.length) {
    const merged = [];
    lines.forEach((l) => {
      const line = merged.length && l.length && haversine(merged[merged.length - 1], l[0]) < 1 ? l.slice(1) : l;
      merged.push(...line);
    });
    return merged;
  }
  // Fallback: ordered placemark points (e.g. a list of waypoints)
  return byLocal('Point').flatMap((p) => {
    const c = [...p.getElementsByTagName('*')].find((n) => n.localName === 'coordinates');
    return c ? parseCoords(c.textContent) : [];
  });
}

export function toKML(points, name = 'Route') {
  const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const coords = points.map(([lat, lon]) => `${lon.toFixed(7)},${lat.toFixed(7)},0`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
<Placemark><name>${esc(name)}</name><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>
</Document></kml>
`;
}

// ---- online services (no key needed) -------------------------------------

/** Road-following route between waypoints, via the public OSRM server (like Google Maps directions). */
export async function routeAlongRoads(waypoints, profile = 'driving') {
  if (waypoints.length < 2) return waypoints;
  const coords = waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`Routing failed: ${data.message || data.code}`);
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  return (await res.json()).map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon), bbox: r.boundingbox?.map(Number) }));
}

const KIND_ICON = { highway: '🛣', place: '🏙', boundary: '🗺', building: '🏠', amenity: '📍', leisure: '🏁', tourism: '📷', shop: '🛍', railway: '🚆', natural: '⛰' };

/**
 * Live suggestions while typing (Photon by komoot: OpenStreetMap data, made for
 * search-as-you-type; Nominatim's usage policy does not allow autocomplete). Biased to the map centre.
 */
export async function suggestPlaces(query, near) {
  const params = new URLSearchParams({ q: query, limit: '7' });
  if (near) { params.set('lat', near[0].toFixed(4)); params.set('lon', near[1].toFixed(4)); }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`);
  if (!res.ok) throw new Error(`Suggestions failed (HTTP ${res.status})`);
  const seen = new Set();
  return (await res.json()).features.map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const name = [p.name || p.street, p.housenumber].filter(Boolean).join(' ') || p.city || p.country;
    const detail = [p.street && p.name ? p.street : null, p.district || p.locality, p.city, p.state].filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i && x !== name).slice(0, 3).join(', ');
    const e = p.extent; // [minLon, maxLat, maxLon, minLat]
    return { name, detail, label: detail ? `${name}, ${detail}` : name, lat, lon, kind: KIND_ICON[p.osm_key] || '📍',
      bbox: e ? [e[3], e[1], e[0], e[2]] : null };
  }).filter((r) => r.name && !seen.has(r.label) && seen.add(r.label));
}

/** Terrain height (m) for each point, from Open-Meteo's free elevation API (Copernicus DEM, ~90 m). */
export async function fetchElevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const lat = chunk.map((p) => p[0].toFixed(6)).join(',');
    const lon = chunk.map((p) => p[1].toFixed(6)).join(',');
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (!res.ok) throw new Error(`Elevation lookup failed (HTTP ${res.status})`);
    out.push(...(await res.json()).elevation);
  }
  return out;
}

/** Evenly spaced samples every `step` meters along a lat/lon polyline. */
export function resample(points, step) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const seg = haversine(a, b);
    if (seg <= 0) continue;
    let d = step - carry;
    while (d <= seg) {
      const f = d / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      d += step;
    }
    carry = seg - (d - step);
  }
  if (haversine(out[out.length - 1], points[points.length - 1]) > step * 0.3) out.push(points[points.length - 1]);
  return out;
}
