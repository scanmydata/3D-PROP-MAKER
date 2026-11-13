import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeProjector, resample, routeLength, haversine } from './geo.js';
import { roadTexture, stripeTexture, grassTexture } from '../generators/textures.js';

export const TRACK_DEFAULTS = {
  name: 'Track',
  width: 12, // asphalt width (m)
  kerbs: 'corners', // corners | all | none
  kerbWidth: 1.0,
  kerbRadius: 120, // corners tighter than this radius (m) get kerbs
  runoff: 6, // grass / run-off width each side (m)
  barrier: 'armco', // armco | wall | none
  closed: 'auto', // auto | yes | no
  step: 2, // sampling step along the track (m)
  smooth: true,
  startLine: true,
  ground: true,
};

/**
 * Build a drivable track model from a lat/lon route (and optional terrain heights).
 * Coordinates are local meters around the first route point: x = east, y = up, z = south.
 */
export function buildTrack(route, elevations = null, opts = {}) {
  const o = { ...TRACK_DEFAULTS, ...opts };
  if (route.length < 2) throw new Error('Route needs at least two points');
  const closed = o.closed === 'yes' || (o.closed === 'auto' && route.length > 3 && haversine(route[0], route[route.length - 1]) < Math.max(30, o.width * 2));
  const origin = route[0];
  const proj = makeProjector(origin);

  // Heights: interpolate elevations (given per route point) and smooth them (DEM is coarse).
  let heights = null;
  if (elevations?.length === route.length) {
    const base = Math.min(...elevations);
    heights = smoothArray(elevations.map((e) => e - base), 6);
  }
  let pts = route.map((p, i) => {
    const v = proj(p, 0);
    return new THREE.Vector3(v.x, heights ? heights[i] : 0, v.z);
  });
  if (closed && pts[0].distanceTo(pts[pts.length - 1]) < 1) pts = pts.slice(0, -1);
  // Thin out very dense input before the spline (OSRM/KML can have points < 1 m apart).
  pts = dedupe(pts, Math.min(o.step, 3));

  // Dense, evenly spaced centreline, then a moving-average pass that rounds every corner to
  // roughly the track width: street corners in OSRM/KML routes are sharp polyline vertices, and
  // offsetting a ribbon around a sharp vertex folds the inner edge over itself.
  let samples = new THREE.CatmullRomCurve3(pts, closed, 'centripetal').getSpacedPoints(Math.max(8, Math.round(polyLength(pts, closed) / o.step)));
  if (closed) samples.pop(); // last == first
  if (o.smooth) {
    const radius = Math.max(2, Math.round((o.width * 0.9) / o.step));
    samples = smoothPoints(smoothPoints(samples, radius, closed), radius, closed);
    const curve = new THREE.CatmullRomCurve3(samples, closed, 'centripetal');
    samples = curve.getSpacedPoints(Math.max(8, Math.round(curve.getLength() / o.step)));
    if (closed) samples.pop();
  }
  const count = samples.length;

  // Frames: horizontal tangent + left vector; signed curvature for kerb placement.
  const up = new THREE.Vector3(0, 1, 0);
  const left = []; const dist = [0]; const curvature = [];
  for (let i = 0; i < count; i += 1) {
    const prev = samples[closed ? (i - 1 + count) % count : Math.max(0, i - 1)];
    const next = samples[closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
    const t = next.clone().sub(prev).setY(0).normalize();
    left.push(new THREE.Vector3().crossVectors(up, t).normalize());
    if (i > 0) dist.push(dist[i - 1] + samples[i].distanceTo(samples[i - 1]));
  }
  for (let i = 0; i < count; i += 1) {
    const a = left[closed ? (i - 1 + count) % count : Math.max(0, i - 1)];
    const b = left[closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
    const ang = Math.atan2(a.clone().cross(b).y, a.dot(b));
    curvature.push(ang / (2 * o.step)); // 1/radius, sign = turn direction
  }
  const curvS = o.smooth ? smoothArray(curvature, 3) : curvature;
  if (closed) dist.push(dist[count - 1] + samples[count - 1].distanceTo(samples[0]));

  const group = new THREE.Group();
  group.name = o.name;
  const hw = o.width / 2;

  // Asphalt
  const roadTex = roadTexture();
  const road = ribbon(samples, left, dist, closed, -hw, hw, 0, 0, { uScale: 1 / o.width, vFrom: 0, vTo: 1 });
  group.add(mesh(road, new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, metalness: 0 }), 'Asphalt'));

  // Kerbs (both sides) where needed
  const kerbMat = new THREE.MeshStandardMaterial({ map: stripeTexture(['#cf1b1b', '#f2f2f2']), roughness: 0.65 });
  let kerbOuter = hw;
  if (o.kerbs !== 'none') {
    kerbOuter = hw + o.kerbWidth;
    const minCurv = 1 / o.kerbRadius;
    [1, -1].forEach((side) => {
      const mask = curvS.map((c) => o.kerbs === 'all' || Math.abs(c) > minCurv);
      const runs = maskRuns(dilate(mask, Math.ceil(8 / o.step), closed), closed);
      const parts = runs.map(([s, e]) => {
        const idx = range(s, e, count);
        return ribbon(idx.map((i) => samples[i]), idx.map((i) => left[i]), idx.map((i) => dist[i]), false,
          side > 0 ? hw : -kerbOuter, side > 0 ? kerbOuter : -hw, side > 0 ? 0.04 : 0.005, side > 0 ? 0.005 : 0.04,
          { uScale: 1 / 2, vFrom: 0, vTo: 1 });
      });
      // One mesh per side keeps the outliner tidy and draw calls low.
      if (parts.length) group.add(mesh(mergeGeometries(parts), kerbMat, side > 0 ? 'Kerbs L' : 'Kerbs R'));
    });
  }

  // Run-off grass
  if (o.runoff > 0) {
    const grassMat = new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 });
    [1, -1].forEach((side) => {
      const geo = ribbon(samples, left, dist, closed,
        side > 0 ? hw : -(kerbOuter + o.runoff), side > 0 ? kerbOuter + o.runoff : -hw, -0.02, -0.02,
        { uScale: 1 / 4, vFrom: 0, vTo: (kerbOuter + o.runoff - hw) / 4 });
      group.add(mesh(geo, grassMat, side > 0 ? 'Run-off L' : 'Run-off R'));
    });
  }

  // Barriers
  if (o.barrier !== 'none') {
    const off = kerbOuter + o.runoff;
    [1, -1].forEach((side) => group.add(barrier(samples, left, dist, closed, side * off, side, o.barrier, o.step)));
  }

  // Start / finish line
  if (o.startLine) {
    const slGeo = new THREE.PlaneGeometry(o.width, 1.0);
    slGeo.rotateX(-Math.PI / 2); // lie flat, width along local X
    const sl = new THREE.Mesh(slGeo, new THREE.MeshStandardMaterial({ map: checkerTexture(o.width), roughness: 0.8 }));
    sl.position.copy(samples[0]).setY(samples[0].y + 0.012);
    sl.rotation.y = Math.atan2(-left[0].z, left[0].x); // local X -> across the track
    sl.name = 'Start/Finish';
    group.add(sl);
  }

  // Ground plane
  if (o.ground) {
    const box = new THREE.Box3().setFromPoints(samples);
    const size = box.getSize(new THREE.Vector3());
    const g = new THREE.PlaneGeometry(size.x + 200, size.z + 200);
    g.rotateX(-Math.PI / 2);
    const tex = grassTexture();
    tex.repeat.set((size.x + 200) / 6, (size.z + 200) / 6);
    const plane = mesh(g, new THREE.MeshStandardMaterial({ map: tex, color: 0xb9c7b0, roughness: 1 }), 'Ground');
    plane.position.set((box.min.x + box.max.x) / 2, box.min.y - 0.08, (box.min.z + box.max.z) / 2);
    plane.castShadow = false;
    group.add(plane);
  }

  // Centre line (reference for aligning photogrammetry / AI line)
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...samples, ...(closed ? [samples[0]] : [])].map((p) => p.clone().setY(p.y + 0.03))),
    new THREE.LineBasicMaterial({ color: 0xffd400 }));
  line.name = 'Centre line';
  line.visible = false;
  group.add(line);

  group.userData = {
    generator: 'Track',
    geo: { origin, crs: 'ENU (x=east, y=up, z=south), meters' },
    length_m: Math.round(closed ? dist[count] : dist[count - 1]),
    route_length_m: Math.round(routeLength(route)),
    closed,
    params: { ...o },
  };
  return group;
}

function mesh(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}

/** Strip between lateral offsets a..b (left-positive), heights ya/yb above the centreline. */
function ribbon(samples, left, dist, closed, a, b, ya, yb, { uScale, vFrom, vTo }) {
  const n = samples.length;
  const rows = closed ? n + 1 : n;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const total = closed ? dist[n] ?? dist[n - 1] + samples[n - 1].distanceTo(samples[0]) : 0;
  for (let r = 0; r < rows; r += 1) {
    const i = r % n;
    const p = samples[i]; const l = left[i];
    const d = r === n ? total : dist[i];
    pos.set([p.x + l.x * a, p.y + ya, p.z + l.z * a, p.x + l.x * b, p.y + yb, p.z + l.z * b], r * 6);
    uv.set([d * uScale, vFrom, d * uScale, vTo], r * 4);
  }
  const index = [];
  for (let r = 0; r < rows - 1; r += 1) {
    const i0 = r * 2; const i1 = i0 + 1; const i2 = i0 + 2; const i3 = i0 + 3;
    index.push(i0, i2, i1, i1, i2, i3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  // Make sure faces point up regardless of offset order.
  const nrm = g.getAttribute('normal');
  let upCount = 0;
  for (let k = 0; k < nrm.count; k += 1) if (nrm.getY(k) >= 0) upCount += 1;
  if (upCount < nrm.count / 2) {
    for (let k = 0; k < index.length; k += 3) [index[k + 1], index[k + 2]] = [index[k + 2], index[k + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  return g;
}

function barrier(samples, left, dist, closed, offset, side, kind, step) {
  const g = new THREE.Group();
  g.name = `${kind === 'wall' ? 'Wall' : 'Armco'} ${side > 0 ? 'L' : 'R'}`;
  if (kind === 'wall') {
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c9c4, roughness: 0.9 });
    const face = verticalStrip(samples, left, dist, closed, offset, 0, 1.0);
    const top = ribbon(samples, left, dist, closed, Math.min(offset, offset + side * 0.4), Math.max(offset, offset + side * 0.4), 1.0, 1.0, { uScale: 1, vFrom: 0, vTo: 1 });
    g.add(mesh(face, mat, 'Face'), mesh(top, mat, 'Top'));
    return g;
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0xbcc2c8, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide });
  g.add(mesh(verticalStrip(samples, left, dist, closed, offset, 0.45, 0.76), steel, 'Rail'));
  // posts every ~2 m as one instanced mesh
  const every = Math.max(1, Math.round(2 / step));
  const ids = [];
  for (let i = 0; i < samples.length; i += every) ids.push(i);
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.8, 0.15), new THREE.MeshStandardMaterial({ color: 0x8f959b, metalness: 0.6, roughness: 0.5 }), ids.length);
  const m = new THREE.Matrix4();
  ids.forEach((i, k) => {
    const p = samples[i].clone().addScaledVector(left[i], offset + Math.sign(offset) * 0.12);
    m.makeRotationY(Math.atan2(left[i].x, left[i].z));
    m.setPosition(p.x, p.y + 0.4, p.z);
    posts.setMatrixAt(k, m);
  });
  posts.name = 'Posts';
  posts.castShadow = true;
  g.add(posts);
  return g;
}

function verticalStrip(samples, left, dist, closed, offset, y0, y1) {
  const n = samples.length;
  const rows = closed ? n + 1 : n;
  const pos = new Float32Array(rows * 6);
  const uv = new Float32Array(rows * 4);
  for (let r = 0; r < rows; r += 1) {
    const i = r % n;
    const p = samples[i]; const l = left[i];
    const x = p.x + l.x * offset; const z = p.z + l.z * offset;
    pos.set([x, p.y + y0, z, x, p.y + y1, z], r * 6);
    const d = r === n ? dist[n] ?? 0 : dist[i];
    uv.set([d, 0, d, 1], r * 4);
  }
  const index = [];
  for (let r = 0; r < rows - 1; r += 1) { const i0 = r * 2; index.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function checkerTexture(width) {
  const c = document.createElement('canvas');
  const cols = Math.max(8, Math.round(width / 0.5));
  c.width = cols * 16; c.height = 32;
  const ctx = c.getContext('2d');
  for (let x = 0; x < cols; x += 1) for (let y = 0; y < 2; y += 1) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
    ctx.fillRect(x * 16, y * 16, 16, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function smoothArray(arr, radius) {
  return arr.map((_, i) => {
    let s = 0; let k = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j += 1) { s += arr[j]; k += 1; }
    return s / k;
  });
}

function polyLength(pts, closed) {
  let d = 0;
  for (let i = 1; i < pts.length; i += 1) d += pts[i].distanceTo(pts[i - 1]);
  return closed ? d + pts[0].distanceTo(pts[pts.length - 1]) : d;
}

/** Moving average of positions (wraps for closed loops; open ends keep their end points). */
function smoothPoints(pts, r, closed) {
  const n = pts.length;
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return p.clone();
    const acc = new THREE.Vector3();
    let k = 0;
    for (let j = -r; j <= r; j += 1) {
      let idx = i + j;
      if (closed) idx = (idx + n) % n;
      else if (idx < 0 || idx >= n) continue;
      acc.add(pts[idx]); k += 1;
    }
    return acc.divideScalar(k);
  });
}

function dedupe(pts, minDist) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) if (pts[i].distanceTo(out[out.length - 1]) >= minDist) out.push(pts[i]);
  if (out.length < 2) out.push(pts[pts.length - 1]);
  return out;
}

function dilate(mask, r, closed) {
  const n = mask.length;
  return mask.map((_, i) => {
    for (let j = -r; j <= r; j += 1) {
      const k = closed ? (i + j + n) % n : i + j;
      if (k >= 0 && k < n && mask[k]) return true;
    }
    return false;
  });
}

/** [start, endInclusive] runs of true values; for closed tracks a run may wrap around. */
function maskRuns(mask, closed) {
  const n = mask.length;
  if (mask.every(Boolean)) return [[0, closed ? n : n - 1]];
  const runs = [];
  let start = -1;
  for (let i = 0; i < n; i += 1) {
    if (mask[i] && start < 0) start = i;
    if (!mask[i] && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, n - 1]);
  if (closed && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n - 1) {
    const last = runs.pop();
    runs[0] = [last[0], runs[0][1] + n];
  }
  return runs.filter(([s, e]) => e - s >= 2);
}

function range(s, e, n) {
  const out = [];
  for (let i = s; i <= e; i += 1) out.push(i % n);
  return out;
}

export { resample };
