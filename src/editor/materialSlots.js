import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { unzipSync } from 'fflate';
import { el, pickFiles, toast } from '../ui/dom.js';
import { decodeDDS, rgbaToCanvas, textureToRGBA, encodeDDS } from './dds.js';
import { download } from './io.js';

/**
 * Simple PBR texture slots for any object: drop a texture set (files, a folder's files or a .zip
 * from ambientCG / Poly Haven / Substance…) and each map goes to the right slot by its file name.
 */
export const SLOTS = [
  { key: 'map', label: 'Color', srgb: true, words: ['basecolor', 'base_color', 'albedo', 'diffuse', 'diff', 'color', 'colour', 'col', 'alb'] },
  { key: 'normalMap', label: 'Normal', words: ['normalgl', 'normal_gl', 'nor_gl', 'normaldx', 'normal_dx', 'nor_dx', 'normal', 'nrm', 'nor', 'nml', 'norm'] },
  { key: 'roughnessMap', label: 'Roughness', words: ['roughness', 'rough', 'rgh'] },
  { key: 'metalnessMap', label: 'Metalness', words: ['metalness', 'metallic', 'metal', 'mtl'] },
  { key: 'aoMap', label: 'AO', words: ['ambientocclusion', 'ambient_occlusion', 'occlusion', 'ao'] },
  { key: 'bumpMap', label: 'Height', words: ['displacement', 'height', 'disp', 'bump'] },
  { key: 'emissiveMap', label: 'Emissive', srgb: true, words: ['emissive', 'emission', 'emit', 'glow'] },
  { key: 'alphaMap', label: 'Opacity', words: ['opacity', 'alpha', 'transparency', 'mask'] },
];
const PACKED = ['arm', 'orm']; // AO (R) + roughness (G) + metalness (B) in one image
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tga|dds|avif)$/i;

/** Which slot a file name belongs to ('arm' for packed AO/rough/metal), or null. */
export function guessSlot(name) {
  const base = name.toLowerCase().replace(/\.[^.]+$/, '');
  const tokens = base.split(/[\s_\-.]+/).filter(Boolean);
  const last = tokens.filter((t) => !/^\d+k$|^\d+$|^(jpg|png)$/.test(t));
  if (last.some((t) => PACKED.includes(t))) return 'arm';
  // Prefer tokens near the end ("Bricks076_1K_Color", "brick_wall_diff_1k")
  for (let i = last.length - 1; i >= 0; i -= 1) {
    const t = last[i];
    for (const s of SLOTS) if (s.words.includes(t)) return s.key;
    if (t === 'gl' || t === 'dx') { const prev = last[i - 1]; if (prev && ['nor', 'normal', 'nrm'].includes(prev)) return 'normalMap'; }
  }
  const joined = last.join('');
  for (const s of SLOTS) if (s.words.some((w) => w.length > 3 && joined.endsWith(w))) return s.key;
  return null;
}
export const isDirectXNormal = (name) => /(normal|nor|nrm)[_\-.]?dx/i.test(name);

/** Load an image / DDS / TGA file into a texture. */
export async function loadTextureFile(file) {
  const name = file.name || 'texture';
  let tex;
  if (/\.dds$/i.test(name)) {
    tex = new THREE.CanvasTexture(rgbaToCanvas(decodeDDS(await file.arrayBuffer())));
  } else if (/\.tga$/i.test(name)) {
    const url = URL.createObjectURL(file);
    try { tex = await new TGALoader().loadAsync(url); } finally { URL.revokeObjectURL(url); }
  } else {
    const url = URL.createObjectURL(file);
    try { tex = await new THREE.TextureLoader().loadAsync(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  tex.name = name.replace(/\.[^.]+$/, '');
  tex.userData.fileName = name;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Expand dropped files: .zip archives become their image files. */
export async function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => IMAGE_RE.test(e.name) && !/__macosx/i.test(e.name) });
      for (const [path, data] of Object.entries(entries)) out.push(new File([data], path.split('/').pop()));
    } else if (IMAGE_RE.test(f.name)) out.push(f);
  }
  return out;
}

export function meshesOf(object) {
  const list = [];
  object.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.material && !o.userData.cropBox) list.push(o); });
  return list;
}

function toStandard(m) {
  if (m.isMeshStandardMaterial) return m.clone();
  const s = new THREE.MeshStandardMaterial({ color: m.color ? m.color.clone() : 0xffffff, map: m.map || null, side: m.side, transparent: m.transparent, opacity: m.opacity, roughness: 0.8, metalness: 0 });
  s.name = m.name;
  s.vertexColors = !!m.vertexColors;
  return s;
}

/**
 * Undoable material edit on every mesh of `object`: materials are cloned first (so a shared
 * material, e.g. all OSM roofs, isn't changed everywhere) and converted to PBR if needed.
 */
export function editMaterials(editor, object, label, change) {
  const meshes = meshesOf(object);
  const before = meshes.map((m) => m.material);
  const after = meshes.map((m) => {
    const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
      const c = toStandard(x);
      change(c);
      c.needsUpdate = true;
      return c;
    });
    return Array.isArray(m.material) ? mats : mats[0];
  });
  editor.execute({
    name: label,
    do() { meshes.forEach((m, i) => { m.material = after[i]; }); editor.emit('objectChanged', object); },
    undo() { meshes.forEach((m, i) => { m.material = before[i]; }); editor.emit('objectChanged', object); },
  });
}

function prepare(tex, slot, opts = {}) {
  const t = tex.clone();
  t.colorSpace = slot.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.repeat.set(opts.repeat ?? 1, opts.repeat ?? 1);
  t.needsUpdate = true;
  return t;
}

/** Assign textures {slotKey|'arm': Texture} to the object (undoable). */
export function assignTextures(editor, object, assigned, { dxNormal = false, repeat = 1 } = {}) {
  editMaterials(editor, object, 'Set textures', (m) => {
    for (const [key, tex] of Object.entries(assigned)) {
      if (key === 'arm') {
        const t = prepare(tex, { srgb: false }, { repeat });
        m.aoMap = t; m.roughnessMap = t; m.metalnessMap = t; m.roughness = 1; m.metalness = 1;
        continue;
      }
      const slot = SLOTS.find((s) => s.key === key);
      if (!slot) continue;
      if (!tex) { m[key] = null; continue; }
      const t = prepare(tex, slot, { repeat });
      m[key] = t;
      if (key === 'map') m.color.set(0xffffff);
      if (key === 'roughnessMap') m.roughness = 1;
      if (key === 'metalnessMap') m.metalness = 1;
      if (key === 'emissiveMap') m.emissive.set(0xffffff);
      if (key === 'alphaMap') { m.transparent = true; m.alphaTest = 0.02; }
      if (key === 'normalMap') m.normalScale.set(1, dxNormal ? -1 : 1); // DirectX normals: green down
      if (key === 'bumpMap') m.bumpScale = 0.02;
    }
  });
}

/** Box-projected UVs in meters (for meshes without useful UVs: OSM buildings, LiDAR blocks, primitives). */
export function boxUV(editor, object, tile = 1) {
  const meshes = meshesOf(object);
  const before = meshes.map((m) => m.geometry);
  const after = meshes.map((m) => {
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.computeVertexNormals();
    const p = g.getAttribute('position'); const n = g.getAttribute('normal');
    const uv = new Float32Array(p.count * 2);
    const s = new THREE.Vector3(); m.getWorldScale(s);
    for (let i = 0; i < p.count; i += 3) {
      // one projection per triangle (face normal) so faces don't smear
      const nx = Math.abs(n.getX(i) + n.getX(i + 1) + n.getX(i + 2));
      const ny = Math.abs(n.getY(i) + n.getY(i + 1) + n.getY(i + 2));
      const nz = Math.abs(n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2));
      for (let k = i; k < i + 3; k += 1) {
        const x = p.getX(k) * s.x; const y = p.getY(k) * s.y; const z = p.getZ(k) * s.z;
        let u; let v;
        if (ny >= nx && ny >= nz) { u = x; v = z; } else if (nx >= nz) { u = z; v = y; } else { u = x; v = y; }
        uv[k * 2] = u / tile; uv[k * 2 + 1] = v / tile;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  });
  editor.execute({
    name: 'Box UVs',
    do() { meshes.forEach((m, i) => { m.geometry = after[i]; }); editor.emit('objectChanged', object); },
    undo() { meshes.forEach((m, i) => { m.geometry = before[i]; }); editor.emit('objectChanged', object); },
  });
  return meshes.length;
}

function thumb(tex) {
  try {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    c.getContext('2d').drawImage(tex.image, 0, 0, 40, 40);
    return c;
  } catch { return el('span', { class: 'slot-empty' }, '▣'); }
}

export function saveTextureDDS(tex, name) {
  const px = textureToRGBA(tex);
  const format = px.hasAlpha ? 'BC3' : 'BC1';
  download(new Blob([encodeDDS(px.data, px.width, px.height, { format })]), `${name || tex.name || 'texture'}.dds`);
  toast(`Saved ${px.width}×${px.height} ${format === 'BC1' ? 'DXT1' : 'DXT5'} DDS with mipmaps`);
}

const texState = new WeakMap(); // per-object UI state (repeat, tile size)

/** Inspector section: one row per slot + drop zone + tiling. */
export function textureSection(editor, object, rerender) {
  const mat = meshesOf(object).map((m) => (Array.isArray(m.material) ? m.material[0] : m.material))[0];
  if (!mat) return null;
  if (!texState.has(object)) texState.set(object, { repeat: mat.map?.repeat?.x || 1, tile: 1 });
  const state = texState.get(object);
  const dx = { v: false };

  const applyFiles = async (files, forced) => {
    const imgs = await expandFiles(files);
    if (!imgs.length) { toast('No image files (PNG, JPG, TGA, DDS, WebP or a .zip of them)', 'error'); return; }
    const assigned = {};
    const skipped = [];
    for (const f of imgs) {
      const key = forced || guessSlot(f.name) || (imgs.length === 1 ? 'map' : null);
      if (!key) { skipped.push(f.name); continue; }
      try { assigned[key] = await loadTextureFile(f); } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
      if (key === 'normalMap' && isDirectXNormal(f.name)) dx.v = true;
      if (forced) break;
    }
    if (!Object.keys(assigned).length) { toast(`Could not tell which map is which: ${skipped.join(', ')}. Drop it on a slot instead.`, 'error'); return; }
    assignTextures(editor, object, assigned, { dxNormal: dx.v, repeat: state.repeat });
    const names = Object.keys(assigned).map((k) => (k === 'arm' ? 'AO+Rough+Metal' : SLOTS.find((s) => s.key === k).label));
    toast(`Textures set: ${names.join(', ')}${skipped.length ? ` · not recognised: ${skipped.join(', ')}` : ''}`);
    rerender();
  };

  const dropOn = (node, forced) => {
    node.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.add('over'); });
    node.addEventListener('dragleave', () => node.classList.remove('over'));
    node.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.remove('over'); applyFiles([...e.dataTransfer.files], forced); });
    return node;
  };

  const rows = SLOTS.map((s) => {
    const tex = mat[s.key];
    const packed = tex && s.key !== 'aoMap' && mat.aoMap === tex;
    return dropOn(el('div', { class: `tex-slot${tex ? ' set' : ''}` },
      tex ? thumb(tex) : el('span', { class: 'slot-empty' }, '+'),
      el('span', { class: 'slot-label' }, s.label),
      el('span', { class: 'slot-file', title: tex?.userData?.fileName || '' }, tex ? (packed ? '(packed ARM)' : tex.userData?.fileName || tex.name || 'texture') : 'drop or choose'),
      el('button', { class: 'icon', title: `Choose ${s.label} image`, onclick: async () => applyFiles(await pickFiles({ accept: 'image/*,.tga,.dds,.zip' }), s.key) }, '…'),
      tex ? el('button', { class: 'icon', title: 'Save as DDS', onclick: () => saveTextureDDS(tex, `${object.name || 'prop'}_${s.label.toLowerCase()}`) }, 'DDS') : null,
      tex ? el('button', { class: 'icon', title: 'Remove', onclick: () => { assignTextures(editor, object, { [s.key]: null }); rerender(); } }, '×') : null), s.key);
  });

  const zone = dropOn(el('div', { class: 'tex-drop', onclick: async () => applyFiles(await pickFiles({ accept: 'image/*,.tga,.dds,.zip', multiple: true })) },
    el('strong', {}, 'Drop a texture set here'),
    el('span', {}, 'All maps at once (or a .zip) — sorted by name: _color, _normal, _roughness, _metal, _ao, _height, _arm…')));

  const setRepeat = (v) => {
    state.repeat = v;
    meshesOf(object).forEach((m) => (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => SLOTS.forEach((s) => { if (x[s.key]?.repeat) x[s.key].repeat.set(v, v); })));
  };
  const strength = mat.normalMap ? el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Normal'),
    el('input', { type: 'range', min: '0', max: '3', step: '0.05', value: String(Math.abs(mat.normalScale.x)),
      oninput: (e) => meshesOf(object).forEach((m) => (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { if (x.normalScale) x.normalScale.set(+e.target.value, Math.sign(x.normalScale.y || 1) * +e.target.value); })) })) : null;
  const bump = mat.bumpMap ? el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Height'),
    el('input', { type: 'range', min: '0', max: '0.2', step: '0.002', value: String(mat.bumpScale),
      oninput: (e) => meshesOf(object).forEach((m) => (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { x.bumpScale = +e.target.value; })) })) : null;
  const flip = mat.normalMap ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: mat.normalScale.y < 0,
    onchange: (e) => meshesOf(object).forEach((m) => (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { if (x.normalScale) x.normalScale.y = Math.abs(x.normalScale.y) * (e.target.checked ? -1 : 1); })) }),
  el('span', {}, 'DirectX normal map (green flipped)')) : null;

  return el('div', { class: 'insp-section' },
    el('div', { class: 'insp-title' }, 'Textures'),
    zone,
    el('div', { class: 'tex-slots' }, ...rows),
    el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Repeat'),
      el('input', { type: 'number', min: '0.01', step: '0.25', value: String(state.repeat), onchange: (e) => setRepeat(Number(e.target.value) || 1) })),
    strength, bump, flip,
    el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Real size'),
      el('input', { type: 'number', min: '0.05', step: '0.25', value: String(state.tile), title: 'Meters covered by one copy of the texture', onchange: (e) => { state.tile = Number(e.target.value) || 1; } }),
      el('button', { class: 'small', title: 'Re-map UVs so one texture copy covers this many meters (good for buildings, walls, ground)', onclick: () => { boxUV(editor, object, state.tile); setRepeat(1); toast(`UVs set: 1 texture = ${state.tile} m`); rerender(); } }, 'Fit UVs (m)')),
    el('p', { class: 'hint' }, 'Click an object once for all of it, again for one part. Drop maps on a row to set just that one.'));
}
