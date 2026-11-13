import * as THREE from 'three';
import { createPVCBanner } from './banner.js';
import { createRng } from '../random.js';
import { asphaltTexture, stripeTexture } from './textures.js';

/** Procedural racing-track props at real-world scale (meters). */

export function trafficCone({ height = 0.75 } = {}) {
  const g = new THREE.Group();
  const orange = new THREE.MeshStandardMaterial({ color: 0xff5a1a, roughness: 0.55 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.45 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.38), orange);
  base.position.y = 0.015;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.15, height - 0.03, 32, 1, true), orange);
  body.position.y = 0.03 + (height - 0.03) / 2;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.12, 32, 1, true), white);
  band.position.y = 0.03 + (height - 0.03) * 0.5;
  band.scale.setScalar(1.02);
  g.add(base, body, band);
  g.name = 'Traffic Cone';
  return finish(g, 'Traffic Cone', { height });
}

export function tireStack({ tires = 5, columns = 4, rows = 1, seed = 7 } = {}) {
  const rng = createRng(seed);
  const g = new THREE.Group();
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 });
  const geo = new THREE.TorusGeometry(0.27, 0.11, 14, 32);
  geo.rotateX(Math.PI / 2);
  const step = 0.76;
  for (let c = 0; c < columns; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      for (let t = 0; t < tires; t += 1) {
        const m = new THREE.Mesh(geo, rubber);
        m.position.set(c * step - ((columns - 1) * step) / 2 + (rng() - 0.5) * 0.04, 0.11 + t * 0.215, r * step + (rng() - 0.5) * 0.04);
        m.rotation.y = rng() * Math.PI;
        g.add(m);
      }
    }
  }
  const belt = new THREE.Mesh(new THREE.BoxGeometry(columns * step + 0.1, tires * 0.215, 0.02), new THREE.MeshStandardMaterial({ color: 0x1e5bd6, roughness: 0.7 }));
  belt.position.set(0, (tires * 0.215) / 2, -0.38);
  g.add(belt);
  return finish(g, 'Tire Wall', { tires, columns, rows });
}

/** W-profile guardrail (Armco) segment with posts, `length` meters long. */
export function armco({ length = 4, posts = true } = {}) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bec5, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide });
  const shape = new THREE.Shape();
  // W-beam cross-section (~0.31 m tall, ~0.08 m deep)
  const pts = [[0, 0], [0.03, 0.04], [0.03, 0.11], [0, 0.155], [0.03, 0.2], [0.03, 0.27], [0, 0.31]];
  shape.moveTo(pts[0][0], pts[0][1]);
  pts.slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  [...pts].reverse().forEach(([x, y]) => shape.lineTo(x + 0.004, y));
  const beamGeo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, steps: 1 });
  beamGeo.rotateY(Math.PI / 2);
  beamGeo.translate(-length / 2, 0.45, 0);
  g.add(new THREE.Mesh(beamGeo, steel));
  if (posts) {
    const postGeo = new THREE.BoxGeometry(0.1, 0.8, 0.15);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.45 });
    for (let x = -length / 2 + 0.3; x <= length / 2 - 0.29; x += 2) {
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(x, 0.4, -0.1);
      g.add(p);
    }
  }
  return finish(g, 'Armco Barrier', { length });
}

/** Red/white kerb segment (sloped), `length` meters. */
export function kerb({ length = 5, width = 1, height = 0.06 } = {}) {
  const geo = new THREE.BoxGeometry(length, height, width, 1, 1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) if (pos.getY(i) > 0 && pos.getZ(i) < 0) pos.setY(i, -height / 2 + 0.005);
  geo.computeVertexNormals();
  geo.translate(0, height / 2, 0);
  const tex = stripeTexture(['#d01818', '#f4f4f4']);
  tex.repeat.set(length, 1);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
  const g = new THREE.Group();
  g.add(m);
  return finish(g, 'Kerb', { length, width });
}

export function asphaltPatch({ size = 10 } = {}) {
  const tex = asphaltTexture();
  tex.repeat.set(size / 4, size / 4);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  const g = new THREE.Group();
  g.add(m);
  return finish(g, 'Asphalt Patch', { size });
}

export function banner(settings = {}) {
  const b = createPVCBanner(settings);
  b.position.y = 0.65 + 0.3;
  const g = new THREE.Group();
  g.add(b);
  // two poles
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.8, roughness: 0.4 });
  [-1.02, 1.02].forEach((x) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.7, 12), poleMat);
    p.position.set(x, 0.85, -0.01);
    g.add(p);
  });
  return finish(g, 'PVC Banner', { ...b.userData.settings, texture: undefined, seed: b.userData.seed });
}

function finish(group, name, params) {
  group.name = name;
  group.userData = { generator: name, params };
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

export const PROP_LIBRARY = [
  { id: 'banner', name: 'PVC Banner', make: banner, desc: '2.0 × 1.3 m, wrinkles, artwork' },
  { id: 'cone', name: 'Traffic Cone', make: trafficCone, desc: '0.75 m' },
  { id: 'tires', name: 'Tire Wall', make: tireStack, desc: 'stacked, belted' },
  { id: 'armco', name: 'Armco Barrier', make: armco, desc: '4 m W-beam + posts' },
  { id: 'kerb', name: 'Kerb', make: kerb, desc: '5 m red/white' },
  { id: 'asphalt', name: 'Asphalt Patch', make: asphaltPatch, desc: '10 × 10 m' },
];
