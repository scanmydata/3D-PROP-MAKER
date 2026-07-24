import * as THREE from 'three';
import { createNoise2D, createRng, normalizeSeed } from '../random.js';
import { createBannerMaterials } from '../materials.js';

export const BANNER_SIZE = Object.freeze({ width: 2.0, height: 1.3, thickness: 0.002, widthSegments: 120, heightSegments: 80 });

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

export function createPVCBanner(options = {}) {
  const settings = {
    wrinkleStrength: 0.035,
    wrinkleFrequency: 7,
    wrinkleCount: 9,
    sagAmount: 0.08,
    windAmount: 0.025,
    seed: Math.floor(Math.random() * 100000),
    texture: null,
    ...options,
  };
  const seed = normalizeSeed(settings.seed);
  const rng = createRng(seed);
  const noise = createNoise2D(seed);
  const geometry = new THREE.PlaneGeometry(BANNER_SIZE.width, BANNER_SIZE.height, BANNER_SIZE.widthSegments, BANNER_SIZE.heightSegments);
  geometry.rotateX(0);
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const wrinkles = Array.from({ length: Math.max(1, Math.round(settings.wrinkleCount)) }, () => ({
    x: rng(), y: rng(), radius: 0.08 + rng() * 0.24, amp: (rng() * 2 - 1) * settings.wrinkleStrength, angle: rng() * Math.PI * 2,
  }));

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i); const y = positions.getY(i);
    const u = uvs.getX(i); const v = uvs.getY(i);
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const edgeMask = 1 - clamp01(edge / 0.14);
    const freeMask = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const sag = -settings.sagAmount * Math.sin(Math.PI * u) * (1 - v) * 0.55;
    const wind = Math.sin((u * 9.0 + v * 3.4 + rng() * 0.08) * settings.wrinkleFrequency) * settings.windAmount * freeMask;
    let z = noise(u * settings.wrinkleFrequency, v * settings.wrinkleFrequency) * settings.wrinkleStrength * freeMask;
    z += noise(u * settings.wrinkleFrequency * 2.4 + 11, v * settings.wrinkleFrequency * 1.7 - 5) * settings.wrinkleStrength * 0.38;
    wrinkles.forEach((w) => {
      const dx = u - w.x; const dy = v - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < w.radius) z += Math.cos(d / w.radius * Math.PI * 2 + w.angle) * (1 - d / w.radius) * w.amp;
    });
    z += edgeMask * settings.wrinkleStrength * 0.6 * Math.sin((u + v) * 48 + seed * 0.01);
    positions.setXYZ(i, x + wind * 0.12, y + sag, z + wind);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const { front, back } = createBannerMaterials(settings.texture);
  const frontGeometry = geometry;
  const backGeometry = geometry.clone();
  frontGeometry.translate(0, 0, BANNER_SIZE.thickness / 2);
  backGeometry.translate(0, 0, -BANNER_SIZE.thickness / 2);
  const frontMesh = new THREE.Mesh(frontGeometry, front);
  const backMesh = new THREE.Mesh(backGeometry, back);
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84, metalness: 0 });
  const topEdge = new THREE.Mesh(new THREE.BoxGeometry(BANNER_SIZE.width, BANNER_SIZE.thickness, BANNER_SIZE.thickness), edgeMaterial);
  const bottomEdge = topEdge.clone();
  const leftEdge = new THREE.Mesh(new THREE.BoxGeometry(BANNER_SIZE.thickness, BANNER_SIZE.height, BANNER_SIZE.thickness), edgeMaterial);
  const rightEdge = leftEdge.clone();
  topEdge.position.y = BANNER_SIZE.height / 2;
  bottomEdge.position.y = -BANNER_SIZE.height / 2;
  leftEdge.position.x = -BANNER_SIZE.width / 2;
  rightEdge.position.x = BANNER_SIZE.width / 2;
  [frontMesh, backMesh, topEdge, bottomEdge, leftEdge, rightEdge].forEach((mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; });
  const group = new THREE.Group();
  group.name = `PVC_Banner_${seed}`;
  group.add(frontMesh, backMesh, topEdge, bottomEdge, leftEdge, rightEdge);
  group.userData = { generator: 'PVC Banner', dimensionsMeters: BANNER_SIZE, seed, settings };
  return group;
}
