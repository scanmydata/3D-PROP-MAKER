import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Editing operations for reconstructed meshes / point clouds. All are undoable through the editor. */

function meshesIn(object) {
  const out = [];
  object?.traverse((o) => { if ((o.isMesh || o.isPoints) && o.geometry) out.push(o); });
  return out;
}

export function centerPivot(editor, object) {
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const bottom = new THREE.Vector3(center.x, box.min.y, center.z);
  // Shift the content so the object's origin sits at the bottom-centre of its bounds,
  // and move the object by the same amount so nothing moves in world space.
  object.updateMatrixWorld(true);
  const local = object.worldToLocal(bottom.clone());
  const before = object.children.map((c) => c.position.clone());
  const selfGeo = object.isSplat ? null : object.geometry;
  const pos0 = object.position.clone();
  object.updateMatrix();
  const pos1 = local.clone().applyMatrix4(object.matrix);
  editor.execute({
    name: 'Center pivot',
    do() {
      if (selfGeo) selfGeo.translate(-local.x, -local.y, -local.z);
      object.children.forEach((c) => c.position.sub(local));
      object.position.copy(pos1);
      editor.emit('objectChanged', object);
    },
    undo() {
      if (selfGeo) selfGeo.translate(local.x, local.y, local.z);
      object.children.forEach((c, i) => c.position.copy(before[i]));
      object.position.copy(pos0);
      editor.emit('objectChanged', object);
    },
  });
}

export function dropToGround(editor, object) {
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) return;
  const dy = -box.min.y;
  const y0 = object.position.y;
  editor.setValue(object, 'Drop to ground', () => object.position.y, (v) => { object.position.y = v; }, y0 + dy);
}

/** Rotate so a Z-up model (COLMAP / photogrammetry) becomes Y-up, or flip upside-down. */
export function rotateFix(editor, object, axis, degrees) {
  if (!object) return;
  const q0 = object.quaternion.clone();
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), THREE.MathUtils.degToRad(degrees)).multiply(q0);
  editor.execute({
    name: 'Rotate',
    do() { object.quaternion.copy(q1); editor.emit('objectChanged', object); },
    undo() { object.quaternion.copy(q0); editor.emit('objectChanged', object); },
  });
}

/** Level a reconstruction: fit a plane to the lowest points (road surface) and rotate it to horizontal. */
export function levelToGround(editor, object) {
  const meshes = meshesIn(object);
  if (!meshes.length) return false;
  const pts = [];
  const v = new THREE.Vector3();
  meshes.forEach((m) => {
    const pos = m.geometry.getAttribute('position');
    const step = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += step) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
  });
  // Use the bottom 30% by height as ground candidates, then least-squares plane via PCA.
  pts.sort((a, b) => a.y - b.y);
  const ground = pts.slice(0, Math.max(10, Math.floor(pts.length * 0.3)));
  const c = ground.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(ground.length);
  const cov = new Array(9).fill(0);
  ground.forEach((p) => {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i * 3 + j] += d[i] * d[j];
  });
  const normal = smallestEigenvector(cov);
  if (normal.y < 0) normal.negate();
  const q = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0));
  const q0 = object.quaternion.clone();
  const q1 = q.clone().multiply(q0);
  editor.execute({
    name: 'Level to ground',
    do() { object.quaternion.copy(q1); editor.emit('objectChanged', object); },
    undo() { object.quaternion.copy(q0); editor.emit('objectChanged', object); },
  });
  return true;
}

function smallestEigenvector(m) {
  // Inverse power iteration on a 3x3 symmetric matrix (shifted for stability).
  const M = new THREE.Matrix3().fromArray(m).transpose();
  const shift = new THREE.Matrix3().set(1e-9, 0, 0, 0, 1e-9, 0, 0, 0, 1e-9);
  const A = new THREE.Matrix3().fromArray(M.elements.map((e, i) => e + shift.elements[i]));
  const inv = A.clone().invert();
  let x = new THREE.Vector3(0.3, 1, 0.2).normalize();
  for (let i = 0; i < 30; i += 1) x = x.applyMatrix3(inv).normalize();
  return x;
}

/** Decimate meshes with meshoptimizer (keeps UVs / colours, locks borders). */
export async function simplify(editor, object, ratio = 0.5) {
  await MeshoptSimplifier.ready;
  let done = 0;
  for (const mesh of meshesIn(object).filter((m) => m.isMesh)) {
    let geo = mesh.geometry;
    if (!geo.index) geo = mergeVertices(geo.clone(), 1e-6);
    const positions = geo.getAttribute('position');
    const pos = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i += 1) {
      pos[i * 3] = positions.getX(i); pos[i * 3 + 1] = positions.getY(i); pos[i * 3 + 2] = positions.getZ(i);
    }
    const idx = new Uint32Array(geo.index.array);
    const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.05, ['LockBorder']);
    const g = geo.clone();
    g.setIndex(new THREE.BufferAttribute(out, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    editor.replaceGeometry(mesh, g, `Simplify ${Math.round(ratio * 100)}%`);
    done += 1;
  }
  return done;
}

/** A translucent box the user positions over the part to keep, then "Crop" with it. */
export function createCropBox(target) {
  const box = new THREE.Box3().setFromObject(target || new THREE.Object3D(), true);
  const size = box.isEmpty() ? new THREE.Vector3(2, 2, 2) : box.getSize(new THREE.Vector3()).multiplyScalar(0.8);
  const center = box.isEmpty() ? new THREE.Vector3(0, 1, 0) : box.getCenter(new THREE.Vector3());
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x33aaff, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x33aaff })));
  mesh.children[0].userData.noPick = true;
  mesh.scale.copy(size);
  mesh.position.copy(center);
  mesh.name = 'Crop Box';
  mesh.userData.cropBox = true;
  mesh.castShadow = false;
  return mesh;
}

/** Remove triangles / points of `object` that fall outside `cropBox` (keepInside) or inside it. */
export function crop(editor, object, cropBox, keepInside = true) {
  cropBox.updateMatrixWorld(true);
  const inv = cropBox.matrixWorld.clone().invert();
  const inside = (p) => Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5 && Math.abs(p.z) <= 0.5;
  const v = new THREE.Vector3();
  let changed = 0;
  for (const m of meshesIn(object)) {
    if (m === cropBox || m.userData.cropBox) continue;
    m.updateMatrixWorld(true);
    const toBox = inv.clone().multiply(m.matrixWorld);
    const geo = m.geometry;
    const pos = geo.getAttribute('position');
    const keepVert = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i += 1) keepVert[i] = inside(v.fromBufferAttribute(pos, i).applyMatrix4(toBox)) === keepInside ? 1 : 0;
    let g;
    if (m.isPoints) {
      const keep = [];
      for (let i = 0; i < pos.count; i += 1) if (keepVert[i]) keep.push(i);
      g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) {
        const arr = new attr.array.constructor(keep.length * attr.itemSize);
        keep.forEach((src, dst) => { for (let k = 0; k < attr.itemSize; k += 1) arr[dst * attr.itemSize + k] = attr.array[src * attr.itemSize + k]; });
        g.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
      }
    } else {
      const index = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
      const out = [];
      for (let t = 0; t < index.length; t += 3) {
        const a = index[t]; const b = index[t + 1]; const c = index[t + 2];
        if (keepVert[a] + keepVert[b] + keepVert[c] >= 2) out.push(a, b, c);
      }
      g = geo.clone();
      g.setIndex(out);
      g.groups = [];
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    editor.replaceGeometry(m, g, 'Crop');
    changed += 1;
  }
  return changed;
}

export function geometryStats(object) {
  let tris = 0; let points = 0; let meshes = 0;
  object?.traverse((o) => {
    if (o.isMesh && o.geometry) {
      meshes += 1;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position')?.count || 0) / 3;
    } else if (o.isPoints && o.geometry) points += o.geometry.getAttribute('position')?.count || 0;
  });
  return { tris: Math.round(tris), points, meshes };
}

/**
 * Split a reconstructed mesh into separate props, one per building footprint (OSM), so a
 * Street View scan of a street becomes "Building A, Building B, … + street". Footprints are
 * [[x, z], ...] in world space; triangles whose centre falls inside (or within `margin` m of)
 * a footprint go to that building. Shares vertex buffers, so it is cheap. One undo step.
 */
export function splitByFootprints(editor, object, footprints, margin = 1.0) {
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry && !o.userData.cropBox) meshes.push(o); });
  if (!meshes.length || !footprints.length) return 0;
  const polys = footprints.map((f) => ({ ...f, box: bounds2(f.polygon, margin) }));
  const created = [];
  const restored = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const geo = m.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
    const buckets = polys.map(() => []);
    const bucketY = polys.map(() => []);
    const rest = [];
    const cx = new Float32Array(3);
    for (let t = 0; t < index.length; t += 3) {
      cx[0] = 0; cx[1] = 0; cx[2] = 0;
      for (let k = 0; k < 3; k += 1) { v.fromBufferAttribute(pos, index[t + k]).applyMatrix4(m.matrixWorld); cx[0] += v.x / 3; cx[1] += v.y / 3; cx[2] += v.z / 3; }
      let hit = -1;
      for (let p = 0; p < polys.length && hit < 0; p += 1) {
        const b = polys[p].box;
        if (cx[0] < b[0] || cx[0] > b[2] || cx[2] < b[1] || cx[2] > b[3]) continue;
        if (pointInPoly(cx[0], cx[2], polys[p].polygon) || distToPoly(cx[0], cx[2], polys[p].polygon) <= margin) hit = p;
      }
      (hit >= 0 ? buckets[hit] : rest).push(index[t], index[t + 1], index[t + 2]);
      if (hit >= 0) bucketY[hit].push(cx[1]);
    }
    buckets.forEach((all, p) => {
      // Drop floaters well above the building (Street View scans have noisy "sky" fragments):
      // keep up to the OSM height + margin above this part's own ground level.
      const ys = bucketY[p];
      let idx = all;
      if (ys.length > 30) {
        const sorted = Float32Array.from(ys).sort();
        const ground = sorted[Math.floor(sorted.length * 0.03)];
        const top = ground + Math.max((polys[p].height || 9) * 1.4 + 5, 18);
        idx = [];
        for (let i = 0; i < ys.length; i += 1) {
          if (ys[i] <= top) idx.push(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]);
          else rest.push(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]);
        }
      }
      if (idx.length < 300) { rest.push(...idx); return; } // under 100 triangles: a fragment, not a building
      // A real prop: only its own vertices, in meters (scan transform baked in), pivot at the
      // bottom-centre, no rotation / scale — so it moves, snaps and exports like any other object.
      const { geometry: g, pivot } = compactPart(geo, idx, m.matrixWorld);
      const part = new THREE.Mesh(g, m.material);
      part.position.copy(pivot);
      part.castShadow = true; part.receiveShadow = true;
      part.name = polys[p].name;
      part.userData = { splitFrom: object.name, osm: polys[p].osm };
      created.push(part);
    });
    const restGeo = geo.clone();
    restGeo.setIndex(rest);
    restored.push([m, geo, restGeo]);
  }
  if (!created.length) return 0;
  const group = new THREE.Group();
  group.name = `${object.name || 'Scan'} · buildings`;
  created.forEach((c) => group.add(c));
  editor.execute({
    name: 'Split by buildings',
    do() { restored.forEach(([m, , g]) => { m.geometry = g; }); editor.scene.add(group); editor.emit('sceneChanged'); },
    undo() { restored.forEach(([m, g]) => { m.geometry = g; }); editor.scene.remove(group); editor.emit('sceneChanged'); },
  });
  return created.length;
}

/** Copy the triangles `idx` of `geo` into a new, compact geometry in world space, pivot at bottom-centre. */
export function compactPart(geo, idx, matrixWorld) {
  const remap = new Map();
  const order = [];
  const newIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i += 1) {
    let k = remap.get(idx[i]);
    if (k === undefined) { k = order.length; remap.set(idx[i], k); order.push(idx[i]); }
    newIdx[i] = k;
  }
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const n = attr.itemSize;
    const arr = new attr.array.constructor(order.length * n);
    for (let i = 0; i < order.length; i += 1) for (let c = 0; c < n; c += 1) arr[i * n + c] = attr.getComponent(order[i], c);
    g.setAttribute(name, new THREE.BufferAttribute(arr, n, attr.normalized));
  }
  if (matrixWorld.determinant() < 0) for (let i = 0; i < newIdx.length; i += 3) [newIdx[i], newIdx[i + 1]] = [newIdx[i + 1], newIdx[i]]; // keep faces outward
  g.setIndex(new THREE.BufferAttribute(newIdx, 1));
  g.applyMatrix4(matrixWorld); // positions and normals into meters / world axes
  g.computeBoundingBox();
  const b = g.boundingBox;
  const pivot = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
  g.translate(-pivot.x, -pivot.y, -pivot.z);
  g.computeBoundingSphere();
  return { geometry: g, pivot };
}

function bounds2(poly, margin) {
  let a = Infinity; let b = Infinity; let c = -Infinity; let d = -Infinity;
  poly.forEach(([x, z]) => { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); });
  return [a - margin, b - margin, c + margin, d + margin];
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, zi] = poly[i]; const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToPoly(x, z, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [ax, az] = poly[j]; const [bx, bz] = poly[i];
    const dx = bx - ax; const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

/** Footprints of OSM buildings in the scene, in world space. */
export function sceneFootprints(editor) {
  const out = [];
  editor.scene.traverse((o) => {
    if (!o.userData?.footprint) return;
    o.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    out.push({ name: o.name, osm: o.userData.osm, height: o.userData.height, polygon: o.userData.footprint.map(([x, z]) => { v.set(x, 0, z).applyMatrix4(o.matrixWorld); return [v.x, v.z]; }) });
  });
  return out;
}
