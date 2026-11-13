/**
 * DDS textures (DirectDraw Surface), the format most racing sims and game engines load
 * (Assetto Corsa, rFactor 2, BeamNG, Unreal/Unity imports…).
 *
 *  encodeDDS(rgba, w, h, { format, mipmaps })  -> ArrayBuffer
 *     format: 'BC1' (DXT1, no alpha, 4 bpp) | 'BC3' (DXT5, alpha, 8 bpp) | 'RGBA' (uncompressed 32 bpp)
 *  decodeDDS(arrayBuffer) -> { width, height, data: Uint8ClampedArray RGBA } (top mip; DXT1/3/5, BC4/5, RGBA/BGRA)
 *  textureToRGBA(texture, maxSize, pot) -> { data, width, height, hasAlpha }
 *
 * Rows are stored top row first, as image editors and DirectX tools write them.
 */

const DDSD = { CAPS: 0x1, HEIGHT: 0x2, WIDTH: 0x4, PITCH: 0x8, PIXELFORMAT: 0x1000, MIPMAPCOUNT: 0x20000, LINEARSIZE: 0x80000 };
const DDPF = { ALPHAPIXELS: 0x1, FOURCC: 0x4, RGB: 0x40, LUMINANCE: 0x20000 };
const fourCC = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

// ---------------------------------------------------------------- encode
function to565(r, g, b) {
  return ((Math.round(r * 31 / 255) & 31) << 11) | ((Math.round(g * 63 / 255) & 63) << 5) | (Math.round(b * 31 / 255) & 31);
}
function from565(c, out, o) {
  const r = (c >> 11) & 31; const g = (c >> 5) & 63; const b = c & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

/** Colour part of a BC1/BC3 block: endpoints along the block's principal axis. */
function encodeColorBlock(px, view, off, allow3) {
  // mean + covariance
  let mr = 0; let mg = 0; let mb = 0;
  for (let i = 0; i < 16; i += 1) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  let crr = 0; let crg = 0; let crb = 0; let cgg = 0; let cgb = 0; let cbb = 0;
  for (let i = 0; i < 16; i += 1) {
    const r = px[i * 4] - mr; const g = px[i * 4 + 1] - mg; const b = px[i * 4 + 2] - mb;
    crr += r * r; crg += r * g; crb += r * b; cgg += g * g; cgb += g * b; cbb += b * b;
  }
  let ax = 1; let ay = 1; let az = 1;
  for (let k = 0; k < 6; k += 1) { // power iteration
    const x = crr * ax + crg * ay + crb * az; const y = crg * ax + cgg * ay + cgb * az; const z = crb * ax + cgb * ay + cbb * az;
    const n = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (n < 1e-6) break;
    ax = x / n; ay = y / n; az = z / n;
  }
  let lo = Infinity; let hi = -Infinity; let iLo = 0; let iHi = 0;
  for (let i = 0; i < 16; i += 1) {
    const d = px[i * 4] * ax + px[i * 4 + 1] * ay + px[i * 4 + 2] * az;
    if (d < lo) { lo = d; iLo = i; }
    if (d > hi) { hi = d; iHi = i; }
  }
  // inset the endpoints slightly (less error than the raw extremes)
  const inset = (a, b) => a + (b - a) / 16;
  let c0 = to565(inset(px[iHi * 4], px[iLo * 4]), inset(px[iHi * 4 + 1], px[iLo * 4 + 1]), inset(px[iHi * 4 + 2], px[iLo * 4 + 2]));
  let c1 = to565(inset(px[iLo * 4], px[iHi * 4]), inset(px[iLo * 4 + 1], px[iHi * 4 + 1]), inset(px[iLo * 4 + 2], px[iHi * 4 + 2]));
  if (c0 < c1) [c0, c1] = [c1, c0]; // 4-colour mode needs c0 > c1
  const pal = new Uint8Array(12);
  from565(c0, pal, 0); from565(c1, pal, 3);
  for (let k = 0; k < 3; k += 1) {
    pal[6 + k] = Math.round((2 * pal[k] + pal[3 + k]) / 3);
    pal[9 + k] = Math.round((pal[k] + 2 * pal[3 + k]) / 3);
  }
  let indices = 0;
  if (c0 !== c1) {
    for (let i = 0; i < 16; i += 1) {
      let best = 0; let bestD = Infinity;
      for (let p = 0; p < 4; p += 1) {
        const dr = px[i * 4] - pal[p * 3]; const dg = px[i * 4 + 1] - pal[p * 3 + 1]; const db = px[i * 4 + 2] - pal[p * 3 + 2];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bestD) { bestD = d; best = p; }
      }
      indices |= best << (i * 2);
    }
  }
  view.setUint16(off, c0, true);
  view.setUint16(off + 2, c1, true);
  view.setUint32(off + 4, indices >>> 0, true);
  return allow3; // (3-colour/1-bit-alpha mode not used)
}

function encodeAlphaBlock(px, bytes, off) {
  let a0 = 0; let a1 = 255;
  for (let i = 0; i < 16; i += 1) { a0 = Math.max(a0, px[i * 4 + 3]); a1 = Math.min(a1, px[i * 4 + 3]); }
  bytes[off] = a0; bytes[off + 1] = a1;
  if (a0 === a1) { for (let k = 2; k < 8; k += 1) bytes[off + k] = 0; return; }
  // 8-alpha mode (a0 > a1): palette a0, a1, then 6 interpolated
  const pal = [a0, a1];
  for (let k = 1; k <= 6; k += 1) pal.push(Math.round(((7 - k) * a0 + k * a1) / 7));
  let bits = 0n;
  for (let i = 0; i < 16; i += 1) {
    let best = 0; let bestD = Infinity;
    for (let p = 0; p < 8; p += 1) { const d = Math.abs(px[i * 4 + 3] - pal[p]); if (d < bestD) { bestD = d; best = p; } }
    bits |= BigInt(best) << BigInt(i * 3);
  }
  for (let k = 0; k < 6; k += 1) bytes[off + 2 + k] = Number((bits >> BigInt(k * 8)) & 0xffn);
}

function compressLevel(rgba, w, h, format) {
  const bw = Math.max(1, Math.ceil(w / 4)); const bh = Math.max(1, Math.ceil(h / 4));
  const blockBytes = format === 'BC1' ? 8 : 16;
  const out = new Uint8Array(bw * bh * blockBytes);
  const view = new DataView(out.buffer);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      for (let y = 0; y < 4; y += 1) {
        const sy = Math.min(h - 1, by * 4 + y);
        for (let x = 0; x < 4; x += 1) {
          const sx = Math.min(w - 1, bx * 4 + x);
          const s = (sy * w + sx) * 4; const d = (y * 4 + x) * 4;
          px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
        }
      }
      const off = (by * bw + bx) * blockBytes;
      if (format === 'BC3') { encodeAlphaBlock(px, out, off); encodeColorBlock(px, view, off + 8, false); } else encodeColorBlock(px, view, off, false);
    }
  }
  return out;
}

function downsample(rgba, w, h) {
  const nw = Math.max(1, w >> 1); const nh = Math.max(1, h >> 1);
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const x0 = Math.min(w - 1, x * 2); const x1 = Math.min(w - 1, x * 2 + 1);
      const y0 = Math.min(h - 1, y * 2); const y1 = Math.min(h - 1, y * 2 + 1);
      for (let c = 0; c < 4; c += 1) {
        out[(y * nw + x) * 4 + c] = (rgba[(y0 * w + x0) * 4 + c] + rgba[(y0 * w + x1) * 4 + c] + rgba[(y1 * w + x0) * 4 + c] + rgba[(y1 * w + x1) * 4 + c] + 2) >> 2;
      }
    }
  }
  return { data: out, width: nw, height: nh };
}

export function encodeDDS(rgba, width, height, { format = 'BC1', mipmaps = true } = {}) {
  const levels = [];
  let cur = { data: rgba, width, height };
  for (;;) {
    levels.push(format === 'RGBA' ? toBGRA(cur.data) : compressLevel(cur.data, cur.width, cur.height, format));
    if (!mipmaps || (cur.width === 1 && cur.height === 1)) break;
    cur = downsample(cur.data, cur.width, cur.height);
  }
  const header = new ArrayBuffer(128);
  const v = new DataView(header);
  const u32 = (i, x) => v.setUint32(i, x >>> 0, true);
  u32(0, fourCC('DDS '));
  u32(4, 124);
  const compressed = format !== 'RGBA';
  u32(8, DDSD.CAPS | DDSD.HEIGHT | DDSD.WIDTH | DDSD.PIXELFORMAT | (mipmaps ? DDSD.MIPMAPCOUNT : 0) | (compressed ? DDSD.LINEARSIZE : DDSD.PITCH));
  u32(12, height);
  u32(16, width);
  u32(20, compressed ? levels[0].length : width * 4);
  u32(28, levels.length);
  // pixel format @76
  u32(76, 32);
  if (compressed) {
    u32(80, DDPF.FOURCC);
    u32(84, fourCC(format === 'BC1' ? 'DXT1' : 'DXT5'));
  } else {
    u32(80, DDPF.RGB | DDPF.ALPHAPIXELS);
    u32(88, 32);
    u32(92, 0x00ff0000); u32(96, 0x0000ff00); u32(100, 0x000000ff); u32(104, 0xff000000);
  }
  u32(108, 0x1000 | (mipmaps ? 0x400008 : 0)); // TEXTURE | MIPMAP | COMPLEX
  const total = 128 + levels.reduce((s, l) => s + l.length, 0);
  const out = new Uint8Array(total);
  out.set(new Uint8Array(header), 0);
  let o = 128;
  levels.forEach((l) => { out.set(l, o); o += l.length; });
  return out.buffer;
}

function toBGRA(rgba) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = rgba[i + 3]; }
  return out;
}

// ---------------------------------------------------------------- decode
function decodeColorBlock(src, so, out, w, h, bx, by, alphaMode) {
  const v = new DataView(src.buffer, src.byteOffset + so, 8);
  const c0 = v.getUint16(0, true); const c1 = v.getUint16(2, true); const idx = v.getUint32(4, true);
  const pal = new Uint8Array(16);
  from565(c0, pal, 0); from565(c1, pal, 4);
  pal[3] = 255; pal[7] = 255;
  if (c0 > c1 || alphaMode) {
    for (let k = 0; k < 3; k += 1) { pal[8 + k] = (2 * pal[k] + pal[4 + k]) / 3; pal[12 + k] = (pal[k] + 2 * pal[4 + k]) / 3; }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k += 1) { pal[8 + k] = (pal[k] + pal[4 + k]) / 2; pal[12 + k] = 0; }
    pal[11] = 255; pal[15] = 0;
  }
  for (let i = 0; i < 16; i += 1) {
    const x = bx * 4 + (i & 3); const y = by * 4 + (i >> 2);
    if (x >= w || y >= h) continue;
    const p = (idx >>> (i * 2)) & 3; const d = (y * w + x) * 4;
    out[d] = pal[p * 4]; out[d + 1] = pal[p * 4 + 1]; out[d + 2] = pal[p * 4 + 2]; out[d + 3] = pal[p * 4 + 3];
  }
}

function decodeAlpha8(src, so) { // BC3/BC4 style: 2 endpoints + 3-bit indices -> 16 values
  const a0 = src[so]; const a1 = src[so + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let k = 1; k <= 6; k += 1) pal.push(((7 - k) * a0 + k * a1) / 7);
  else { for (let k = 1; k <= 4; k += 1) pal.push(((5 - k) * a0 + k * a1) / 5); pal.push(0, 255); }
  let bits = 0n;
  for (let k = 0; k < 6; k += 1) bits |= BigInt(src[so + 2 + k]) << BigInt(k * 8);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = pal[Number((bits >> BigInt(i * 3)) & 7n)];
  return out;
}

export function decodeDDS(buffer) {
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== fourCC('DDS ')) throw new Error('Not a DDS file');
  const height = v.getUint32(12, true); const width = v.getUint32(16, true);
  const pfFlags = v.getUint32(80, true); let cc = v.getUint32(84, true);
  let dataOff = 128;
  if ((pfFlags & DDPF.FOURCC) && cc === fourCC('DX10')) {
    const dxgi = v.getUint32(128, true);
    dataOff = 148;
    const map = { 71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5', 80: 'ATI1', 83: 'ATI2', 28: 'RGBA', 29: 'RGBA', 87: 'BGRA', 91: 'BGRA' };
    if (!map[dxgi]) throw new Error(`DDS format DXGI ${dxgi} (e.g. BC7/BC6H) is not supported here — save it as DXT1/DXT5 or PNG.`);
    cc = map[dxgi].length === 4 && map[dxgi] !== 'RGBA' && map[dxgi] !== 'BGRA' ? fourCC(map[dxgi]) : map[dxgi];
  }
  const src = new Uint8Array(buffer, dataOff);
  const out = new Uint8ClampedArray(width * height * 4);
  const bw = Math.max(1, Math.ceil(width / 4)); const bh = Math.max(1, Math.ceil(height / 4));
  const name = typeof cc === 'string' ? cc : String.fromCharCode(cc & 255, (cc >> 8) & 255, (cc >> 16) & 255, (cc >> 24) & 255);
  if (pfFlags & DDPF.FOURCC && ['DXT1', 'DXT3', 'DXT5', 'ATI1', 'BC4U', 'ATI2', 'BC5U'].includes(name)) {
    const bb = name === 'DXT1' || name === 'ATI1' || name === 'BC4U' ? 8 : 16;
    for (let by = 0; by < bh; by += 1) {
      for (let bx = 0; bx < bw; bx += 1) {
        const so = (by * bw + bx) * bb;
        if (name === 'DXT1') decodeColorBlock(src, so, out, width, height, bx, by, false);
        else if (name === 'DXT3' || name === 'DXT5') {
          decodeColorBlock(src, so + 8, out, width, height, bx, by, true);
          const al = name === 'DXT5' ? decodeAlpha8(src, so) : Uint8Array.from({ length: 16 }, (_, i) => ((src[so + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17);
          for (let i = 0; i < 16; i += 1) { const x = bx * 4 + (i & 3); const y = by * 4 + (i >> 2); if (x < width && y < height) out[(y * width + x) * 4 + 3] = al[i]; }
        } else { // BC4 (one channel) / BC5 (two channels, normal maps: rebuild Z)
          const r = decodeAlpha8(src, so); const g = bb === 16 ? decodeAlpha8(src, so + 8) : r;
          for (let i = 0; i < 16; i += 1) {
            const x = bx * 4 + (i & 3); const y = by * 4 + (i >> 2);
            if (x >= width || y >= height) continue;
            const d = (y * width + x) * 4;
            out[d] = r[i]; out[d + 1] = g[i];
            if (bb === 16) { const nx = r[i] / 127.5 - 1; const ny = g[i] / 127.5 - 1; out[d + 2] = (Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255; } else out[d + 2] = r[i];
            out[d + 3] = 255;
          }
        }
      }
    }
    return { width, height, data: out };
  }
  // uncompressed
  const bits = v.getUint32(88, true);
  if (cc === 'RGBA' || cc === 'BGRA' || (pfFlags & (DDPF.RGB | DDPF.LUMINANCE))) {
    const masks = cc === 'RGBA' ? [0xff, 0xff00, 0xff0000, 0xff000000] : cc === 'BGRA' ? [0xff0000, 0xff00, 0xff, 0xff000000]
      : [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), (pfFlags & DDPF.ALPHAPIXELS) ? v.getUint32(104, true) : 0];
    const bpp = (typeof cc === 'string' ? 32 : bits) / 8;
    const shift = (m) => (m ? Math.log2(m & -m) : 0);
    const scale = (m) => (m ? 255 / (m >>> shift(m)) : 0);
    const sv = new DataView(buffer, dataOff);
    for (let i = 0; i < width * height; i += 1) {
      let p = 0;
      for (let k = 0; k < bpp; k += 1) p |= sv.getUint8(i * bpp + k) << (8 * k);
      p >>>= 0;
      for (let c = 0; c < 3; c += 1) out[i * 4 + c] = masks[c] ? ((p & masks[c]) >>> shift(masks[c])) * scale(masks[c]) : (pfFlags & DDPF.LUMINANCE ? (p & masks[0]) : 0);
      out[i * 4 + 3] = masks[3] ? ((p & masks[3]) >>> shift(masks[3])) * scale(masks[3]) : 255;
    }
    return { width, height, data: out };
  }
  throw new Error(`DDS format "${name}" is not supported here — save it as DXT1/DXT5 or PNG.`);
}

// ---------------------------------------------------------------- texture -> pixels
const nextPow2Down = (n) => 2 ** Math.floor(Math.log2(Math.max(1, n)));
const nearestPow2 = (n) => { const lo = nextPow2Down(n); return n - lo > lo * 2 - n ? lo * 2 : lo; };

/** Pixels of a three.js texture (image, canvas, bitmap or 8-bit DataTexture), optionally resized. */
export function textureToRGBA(texture, { maxSize = 4096, pot = true } = {}) {
  const img = texture.image;
  if (!img) throw new Error('Texture has no image');
  let w = img.width || img.videoWidth; let h = img.height || img.videoHeight;
  let tw = pot ? nearestPow2(w) : w; let th = pot ? nearestPow2(h) : h;
  while (Math.max(tw, th) > maxSize) { tw = Math.max(1, tw >> 1); th = Math.max(1, th >> 1); }
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (img.data) { // DataTexture
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const id = new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, w * h * 4), w, h);
    src.getContext('2d').putImageData(id, 0, 0);
    ctx.drawImage(src, 0, 0, tw, th);
  } else ctx.drawImage(img, 0, 0, tw, th);
  const { data } = ctx.getImageData(0, 0, tw, th);
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { hasAlpha = true; break; }
  w = tw; h = th;
  return { data, width: w, height: h, hasAlpha };
}

/** RGBA pixels -> canvas (for textures decoded from DDS). */
export function rgbaToCanvas({ data, width, height }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4), width, height), 0, 0);
  return c;
}
