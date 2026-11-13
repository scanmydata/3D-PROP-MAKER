import * as THREE from 'three';
import { createRng } from '../random.js';

function canvasTexture(size, draw, { srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cache = new Map();
function cached(key, make) {
  // One canvas per texture kind; each caller gets its own Texture (own repeat/offset).
  if (!cache.has(key)) cache.set(key, make());
  const t = cache.get(key).clone();
  t.needsUpdate = true;
  return t;
}

/** Asphalt: grey base with aggregate speckle. Repeats every 4 m when repeat = length/4. */
export function asphaltTexture() {
  return cached('asphalt', () => canvasTexture(512, (ctx, s) => {
    const rng = createRng(1234);
    ctx.fillStyle = '#3b3d40'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 26000; i += 1) {
      const v = 40 + rng() * 60;
      ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
      ctx.fillRect(rng() * s, rng() * s, 1 + rng() * 2, 1 + rng() * 2);
    }
  }));
}

export function grassTexture() {
  return cached('grass', () => canvasTexture(512, (ctx, s) => {
    const rng = createRng(99);
    ctx.fillStyle = '#41662c'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 30000; i += 1) {
      const g = 80 + rng() * 70;
      ctx.fillStyle = `rgb(${40 + rng() * 30},${g},${25 + rng() * 20})`;
      ctx.fillRect(rng() * s, rng() * s, 1, 2 + rng() * 3);
    }
  }));
}

/** Alternating colour stripes along U (one stripe pair per texture repeat). */
export function stripeTexture(colors = ['#d01818', '#f4f4f4']) {
  return canvasTexture(256, (ctx, s) => {
    const w = s / colors.length;
    colors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * w, 0, w, s); });
  });
}

/** Road markings: white edge lines on asphalt, used across the road width (V axis). */
export function roadTexture() {
  return cached('road', () => canvasTexture(1024, (ctx, s) => {
    const rng = createRng(4321);
    ctx.fillStyle = '#3a3c3f'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 90000; i += 1) {
      const v = 38 + rng() * 62;
      ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
      ctx.fillRect(rng() * s, rng() * s, 1 + rng() * 2, 1 + rng() * 2);
    }
    // racing line wear in the middle
    const grad = ctx.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0.35, 'rgba(15,15,15,0)'); grad.addColorStop(0.5, 'rgba(15,15,15,0.35)'); grad.addColorStop(0.65, 'rgba(15,15,15,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#e9e9e9';
    ctx.fillRect(0, s * 0.012, s, s * 0.012);
    ctx.fillRect(0, s * 0.976, s, s * 0.012);
  }));
}
