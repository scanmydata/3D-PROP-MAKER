// Deterministic random helpers for repeatable procedural assets.
export function normalizeSeed(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export function createRng(seed) {
  let state = normalizeSeed(seed) || 0x9e3779b9;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNoise2D(seed) {
  const random = createRng(seed);
  const gradients = Array.from({ length: 256 }, () => {
    const angle = random() * Math.PI * 2;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const perm = Array.from({ length: 512 }, (_, i) => i & 255).sort(() => random() - 0.5);
  for (let i = 0; i < 256; i += 1) perm[i + 256] = perm[i];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dot = (ix, iy, x, y) => {
    const g = gradients[perm[(ix + perm[iy & 255]) & 255]];
    return (x - ix) * g[0] + (y - iy) * g[1];
  };
  return (x, y) => {
    const x0 = Math.floor(x); const y0 = Math.floor(y);
    const x1 = x0 + 1; const y1 = y0 + 1;
    const sx = fade(x - x0); const sy = fade(y - y0);
    const nx0 = lerp(dot(x0, y0, x, y), dot(x1, y0, x, y), sx);
    const nx1 = lerp(dot(x0, y1, x, y), dot(x1, y1, x, y), sx);
    return lerp(nx0, nx1, sy) * 1.45;
  };
}
