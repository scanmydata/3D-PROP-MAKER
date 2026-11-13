import * as THREE from 'three';
import { banner, trafficCone, tireStack, armco, kerb } from '../generators/props.js';
import { makeTree, makePole } from '../track/osm.js';

/**
 * Turn an AI description ({objects: [{category, count, dimensions_m, color, ...}]}) into
 * procedural props at the estimated real-world size. `photoTexture` (optional) is used on
 * banners, signs and building facades so the result looks like the photo.
 */
export function propsFromDescription(desc, photoTexture = null) {
  const root = new THREE.Group();
  root.name = `AI · ${(desc.objects?.[0]?.name || desc.scene_type || 'scene').slice(0, 40)}`;
  let x = 0;
  (desc.objects || []).forEach((o) => {
    const count = Math.max(1, Math.min(20, Math.round(o.count || 1)));
    const d = o.dimensions_m || {};
    const def = DEFAULT_SIZE[o.category] || DEFAULT_SIZE.other;
    const w = num(d.width, def[0]); const h = num(d.height, def[1]); const dep = num(d.depth, def[2]);
    const row = new THREE.Group();
    row.name = o.name || o.category;
    for (let i = 0; i < count; i += 1) {
      const obj = makeOne(o.category, { w, h, d: dep, color: o.color, texture: photoTexture, text: o.text_on_it });
      obj.position.x = i * (w + 0.3);
      row.add(obj);
    }
    row.position.x = x;
    row.userData = { ai: o };
    x += count * (w + 0.3) + 1.5;
    root.add(row);
  });
  // centre the row of props on the origin
  root.children.forEach((c) => { c.position.x -= x / 2; });
  root.userData = { ai: { summary: desc.summary, model: desc.model } };
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// Typical real sizes (width, height, depth in m) when the AI gives none.
const DEFAULT_SIZE = {
  banner: [3, 1, 0.05], traffic_cone: [0.4, 0.75, 0.4], tire_wall: [3, 0.8, 0.6], armco: [4, 0.8, 0.3], kerb: [5, 0.08, 1],
  concrete_wall: [4, 1, 0.6], fence: [4, 1.8, 0.05], building: [10, 7, 10], tree: [4, 7, 4], pole: [0.3, 6, 0.3],
  street_lamp: [1.5, 8, 0.3], sign: [1, 2.2, 0.1], flag: [1, 3, 0.1], tent: [3, 3, 3], grandstand: [20, 5, 8],
  box: [1, 1, 1], cylinder: [1, 1, 1], road: [7, 0.02, 20], other: [1, 1, 1],
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : fallback;
}

function color(c, fallback) {
  try { return new THREE.Color(c || fallback); } catch { return new THREE.Color(fallback); }
}

function makeOne(category, { w, h, d, color: c, texture }) {
  switch (category) {
    case 'banner': {
      const b = banner({ texture });
      b.scale.set(w / 2, h / 1.3, 1);
      return b;
    }
    case 'traffic_cone': { const o = trafficCone({ height: h }); return o; }
    case 'tire_wall': return tireStack({ columns: Math.max(1, Math.round(w / 0.76)), tires: Math.max(1, Math.round(h / 0.215)) });
    case 'armco': return armco({ length: Math.max(1, w) });
    case 'kerb': return kerb({ length: Math.max(1, w), width: Math.max(0.3, d) });
    case 'tree': { const t = makeTree(h); return t; }
    case 'street_lamp': return makePole('lamp');
    case 'pole': case 'sign': case 'flag': {
      const p = makePole('sign');
      if (texture && category === 'sign') {
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w, 2), Math.min(w, 2) * 0.66), new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide }));
        plate.position.y = Math.max(1.5, h - 0.4);
        p.add(plate);
      }
      return p;
    }
    case 'tent': {
      const g = new THREE.Group();
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, Math.max(0.6, h * 0.25), 4, 1), new THREE.MeshStandardMaterial({ color: color(c, '#e8e8e8'), roughness: 0.8 }));
      roof.rotation.y = Math.PI / 4;
      roof.position.y = h * 0.875;
      g.add(roof);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h * 0.75), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.7 }));
        leg.position.set((sx * w) / 2, (h * 0.75) / 2, (sz * d) / 2);
        g.add(leg);
      });
      return g;
    }
    case 'grandstand': {
      const g = new THREE.Group();
      const steps = Math.max(3, Math.round(h / 0.45));
      for (let i = 0; i < steps; i += 1) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d / steps), new THREE.MeshStandardMaterial({ color: color(c, '#9aa3ad'), roughness: 0.8 }));
        s.position.set(0, 0.225 + i * 0.45, -d / 2 + (i + 0.5) * (d / steps));
        s.scale.y = 1;
        g.add(s);
        const base = new THREE.Mesh(new THREE.BoxGeometry(w, i * 0.45 + 0.01, d / steps), s.material);
        base.position.set(0, (i * 0.45) / 2, s.position.z);
        if (i > 0) g.add(base);
      }
      return g;
    }
    case 'cylinder': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 32), new THREE.MeshStandardMaterial({ color: color(c, '#bbbbbb'), roughness: 0.6 }));
      m.position.y = h / 2;
      return wrap(m);
    }
    case 'concrete_wall': case 'fence': case 'building': case 'box': case 'road': case 'other': default: {
      const mats = new THREE.MeshStandardMaterial({ color: color(c, category === 'concrete_wall' ? '#c9c7c0' : '#c8c3bb'), roughness: 0.85 });
      const geo = new THREE.BoxGeometry(w, category === 'road' ? 0.05 : h, category === 'fence' ? 0.05 : d);
      let material = mats;
      if (texture && (category === 'building' || category === 'concrete_wall' || category === 'other')) {
        const front = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 });
        material = [mats, mats, mats, mats, front, mats]; // +Z face shows the photo
      }
      const m = new THREE.Mesh(geo, material);
      m.position.y = (category === 'road' ? 0.05 : h) / 2;
      if (category === 'fence') m.material = new THREE.MeshStandardMaterial({ color: color(c, '#7d7468'), transparent: true, opacity: 0.6 });
      return wrap(m);
    }
  }
}

function wrap(mesh) {
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}
