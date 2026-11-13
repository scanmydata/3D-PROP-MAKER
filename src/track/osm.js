import * as THREE from 'three';
import { makeProjector } from './geo.js';

/**
 * OpenStreetMap around a route -> separate, editable 3D props in the scene's map frame:
 * buildings (extruded footprints with OSM heights), roads, trees, street lamps / signals, barriers.
 * Data © OpenStreetMap contributors (ODbL), fetched from the public Overpass API.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter';

export const OSM_LAYERS = {
  buildings: 'Buildings',
  roads: 'Roads & paths',
  trees: 'Trees',
  furniture: 'Street lamps, signals, signs',
  barriers: 'Walls, fences, guard rails',
};

export function bboxAround(points, bufferM) {
  const lats = points.map((p) => p[0]); const lons = points.map((p) => p[1]);
  const dLat = bufferM / 111320;
  const dLon = bufferM / (111320 * Math.cos(((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI / 180));
  return { s: Math.min(...lats) - dLat, w: Math.min(...lons) - dLon, n: Math.max(...lats) + dLat, e: Math.max(...lons) + dLon };
}

export async function fetchOSM(bbox, layers) {
  const b = `${bbox.s.toFixed(6)},${bbox.w.toFixed(6)},${bbox.n.toFixed(6)},${bbox.e.toFixed(6)}`;
  const parts = [];
  if (layers.buildings) parts.push(`way["building"](${b});`, `relation["building"]["type"="multipolygon"](${b});`);
  if (layers.roads) parts.push(`way["highway"](${b});`);
  if (layers.trees) parts.push(`node["natural"="tree"](${b});`, `way["natural"="tree_row"](${b});`);
  if (layers.furniture) parts.push(`node["highway"~"street_lamp|traffic_signals|stop|give_way"](${b});`, `node["traffic_sign"](${b});`);
  if (layers.barriers) parts.push(`way["barrier"](${b});`);
  if (!parts.length) return { elements: [] };
  const query = `[out:json][timeout:25];(${parts.join('')});out geom tags;`;
  // Through the backend first: it caches each area on disk and retries busy servers.
  try {
    const res = await fetch('/api/osm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    if (res.ok) return await res.json();
    if (res.status === 503) throw new Error((await res.json()).detail);
  } catch (e) { if (/busy/.test(e.message)) throw e; /* backend offline: ask Overpass directly */ }
  let last = '';
  // The public Overpass servers are often busy or hang; try each for 30 s, then the next mirror.
  for (const url of OVERPASS_SERVERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
      if (res.ok) {
        const json = await res.json();
        if (!json.remark || json.elements?.length) return json;
        last = json.remark;
      } else last = `HTTP ${res.status}`;
    } catch (e) { last = e.name === 'AbortError' ? 'timed out' : e.message; } finally { clearTimeout(timer); }
  }
  throw new Error(`OpenStreetMap (Overpass) unavailable: ${last}. Try again in a minute.`);
}

const OVERPASS_SERVERS = [OVERPASS, 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

const ROAD_WIDTH = {
  motorway: 11, trunk: 10, primary: 9, secondary: 8, tertiary: 7, unclassified: 6, residential: 6,
  service: 4, living_street: 5, pedestrian: 5, track: 3, footway: 2, path: 1.5, cycleway: 2, steps: 2, raceway: 12,
};
const BARRIER_HEIGHT = { wall: 2, retaining_wall: 1.2, fence: 1.5, guard_rail: 0.8, hedge: 1.4, kerb: 0.15, city_wall: 4, handrail: 1 };

function heightOf(tags) {
  const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const h = num(tags.height) ?? (num(tags['building:levels']) != null ? num(tags['building:levels']) * 3.2 + 1 : null);
  return { h: h ?? (tags.building === 'garage' || tags.building === 'shed' ? 3 : 9), min: num(tags.min_height) ?? 0 };
}

function buildingColor(tags) {
  const c = tags['building:colour'] || tags['building:color'];
  if (c) { try { return new THREE.Color(c); } catch { /* invalid */ } }
  const palette = { residential: 0xd9cfc1, apartments: 0xd7d0c4, commercial: 0xc9ccd2, retail: 0xd3c7b8, industrial: 0xb8bcc2, church: 0xe6dccb, garage: 0xbab4ac };
  return new THREE.Color(palette[tags.building] ?? 0xd4cbbf);
}

/** Build the scene groups. `origin` = scene map origin [lat, lon]. */
export function buildOSM(data, origin, layers) {
  const proj = makeProjector(origin);
  const xz = (g) => { const p = proj([g.lat, g.lon], 0); return new THREE.Vector2(p.x, -p.z); }; // shape space: (east, north)
  const v3 = (g, y = 0) => { const p = proj([g.lat, g.lon], 0); return new THREE.Vector3(p.x, y, p.z); };
  const groups = {};
  const group = (key) => {
    if (!groups[key]) { groups[key] = new THREE.Group(); groups[key].name = `OSM · ${OSM_LAYERS[key]}`; }
    return groups[key];
  };
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8c8580, roughness: 0.9 });
  const counts = {};

  for (const el of data.elements || []) {
    const t = el.tags || {};
    // ---- buildings ----
    if (layers.buildings && t.building && (el.geometry || el.members)) {
      const rings = el.type === 'relation'
        ? (el.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry)
        : [el.geometry];
      rings.forEach((ring) => {
        if (!ring || ring.length < 4) return;
        const pts = ring.map(xz);
        if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
        const { h, min } = heightOf(t);
        const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: Math.max(1, h - min), bevelEnabled: false });
        geo.rotateX(-Math.PI / 2); // shape (east, north) -> (x, -z); extrude +Z -> +Y
        geo.translate(0, min, 0);
        const wall = new THREE.MeshStandardMaterial({ color: buildingColor(t), roughness: 0.85 });
        const mesh = new THREE.Mesh(geo, [roofMat, wall]);
        mesh.name = t.name || t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim() || `Building ${el.id}`;
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData = { osm: { id: el.id, type: el.type, tags: t }, footprint: pts.map((p) => [p.x, -p.y]), height: h };
        group('buildings').add(mesh);
        counts.buildings = (counts.buildings || 0) + 1;
      });
      continue;
    }
    // ---- roads ----
    if (layers.roads && t.highway && el.type === 'way' && el.geometry?.length > 1) {
      const lanes = parseFloat(t.lanes);
      const width = parseFloat(t.width) || (Number.isFinite(lanes) ? lanes * 3.2 : ROAD_WIDTH[t.highway] || 5);
      const mesh = ribbon(el.geometry.map((g) => v3(g, 0.03)), width, new THREE.MeshStandardMaterial({ color: t.highway === 'footway' || t.highway === 'pedestrian' ? 0x9a948c : 0x4a4c50, roughness: 0.95 }));
      if (!mesh) continue;
      mesh.name = t.name ? `${t.name} (${t.highway})` : `${t.highway} ${el.id}`;
      mesh.userData = { osm: { id: el.id, type: el.type, tags: t }, width };
      group('roads').add(mesh);
      counts.roads = (counts.roads || 0) + 1;
      continue;
    }
    // ---- trees ----
    if (layers.trees && t.natural === 'tree' && el.type === 'node') {
      const tree = makeTree(parseFloat(t.height) || 7);
      tree.position.copy(v3(el));
      tree.userData = { osm: { id: el.id, tags: t } };
      group('trees').add(tree);
      counts.trees = (counts.trees || 0) + 1;
      continue;
    }
    if (layers.trees && t.natural === 'tree_row' && el.geometry) {
      const pts = el.geometry.map((g) => v3(g));
      for (let i = 1; i < pts.length; i += 1) {
        const seg = pts[i].clone().sub(pts[i - 1]);
        for (let d = 0; d < seg.length(); d += 8) {
          const tree = makeTree(7);
          tree.position.copy(pts[i - 1]).addScaledVector(seg.clone().normalize(), d);
          group('trees').add(tree);
          counts.trees = (counts.trees || 0) + 1;
        }
      }
      continue;
    }
    // ---- street furniture ----
    if (layers.furniture && el.type === 'node' && (t.highway || t.traffic_sign)) {
      const kind = t.highway === 'street_lamp' ? 'lamp' : t.highway === 'traffic_signals' ? 'signal' : 'sign';
      const obj = makePole(kind);
      obj.position.copy(v3(el));
      obj.name = { lamp: 'Street lamp', signal: 'Traffic signal', sign: `Sign ${t.traffic_sign || t.highway}` }[kind];
      obj.userData = { osm: { id: el.id, tags: t } };
      group('furniture').add(obj);
      counts.furniture = (counts.furniture || 0) + 1;
      continue;
    }
    // ---- barriers ----
    if (layers.barriers && t.barrier && el.type === 'way' && el.geometry?.length > 1) {
      const h = parseFloat(t.height) || BARRIER_HEIGHT[t.barrier] || 1.2;
      const mesh = wallStrip(el.geometry.map((g) => v3(g)), h, t.barrier === 'guard_rail' ? 0.45 : 0, new THREE.MeshStandardMaterial({
        color: { hedge: 0x3f6b2f, guard_rail: 0xbfc5cb, fence: 0x7d7468 }[t.barrier] ?? 0xb9b3a8,
        metalness: t.barrier === 'guard_rail' ? 0.8 : 0, roughness: 0.7, side: THREE.DoubleSide,
      }));
      mesh.name = `${t.barrier} ${el.id}`;
      mesh.userData = { osm: { id: el.id, tags: t } };
      group('barriers').add(mesh);
      counts.barriers = (counts.barriers || 0) + 1;
    }
  }
  const out = Object.values(groups);
  out.forEach((g) => { g.userData.geo = { origin, source: 'OpenStreetMap contributors (ODbL)' }; });
  return { groups: out, counts };
}

function ribbon(points, width, material) {
  if (points.length < 2) return null;
  const pos = []; const idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]; const b = points[Math.min(points.length - 1, i + 1)];
    const left = new THREE.Vector3().crossVectors(up, b.clone().sub(a).setY(0).normalize()).multiplyScalar(width / 2);
    pos.push(p.x - left.x, p.y, p.z - left.z, p.x + left.x, p.y, p.z + left.z);
    if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  if (n.count && n.getY(0) < 0) { for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]]; g.setIndex(idx); g.computeVertexNormals(); }
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  return m;
}

function wallStrip(points, height, base, material) {
  const pos = []; const idx = [];
  points.forEach((p, i) => {
    pos.push(p.x, base, p.z, p.x, base + height, p.z);
    if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

const treeTrunk = new THREE.CylinderGeometry(0.12, 0.18, 1, 8).translate(0, 0.5, 0);
const treeCrown = new THREE.IcosahedronGeometry(1, 1);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1 });
const crownMat = new THREE.MeshStandardMaterial({ color: 0x3e6b2e, roughness: 0.95, flatShading: true });

export function makeTree(height = 7) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(treeTrunk, trunkMat);
  trunk.scale.set(1, height * 0.45, 1);
  const crown = new THREE.Mesh(treeCrown, crownMat);
  crown.scale.set(height * 0.3, height * 0.35, height * 0.3);
  crown.position.y = height * 0.65;
  trunk.castShadow = crown.castShadow = true;
  g.add(trunk, crown);
  g.name = 'Tree';
  return g;
}

const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 1, 8).translate(0, 0.5, 0);
const poleMat = new THREE.MeshStandardMaterial({ color: 0x6f757b, metalness: 0.7, roughness: 0.45 });

export function makePole(kind) {
  const g = new THREE.Group();
  const h = kind === 'lamp' ? 8 : kind === 'signal' ? 3.5 : 2.6;
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.scale.y = h;
  g.add(pole);
  if (kind === 'lamp') {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.08), poleMat);
    arm.position.set(0.6, h, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.25), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0x332a10 }));
    head.position.set(1.15, h - 0.08, 0);
    g.add(arm, head);
  } else if (kind === 'signal') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.25), new THREE.MeshStandardMaterial({ color: 0x1d1f22 }));
    box.position.y = h - 0.3;
    g.add(box);
  } else {
    const plate = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    plate.position.y = h - 0.2;
    g.add(plate);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
