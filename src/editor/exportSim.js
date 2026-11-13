import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { el, field, select, checkbox, toast } from '../ui/dom.js';
import { encodeDDS, textureToRGBA } from './dds.js';
import { download } from './io.js';

/**
 * Export for games / sims: the model (OBJ+MTL or GLB) plus every texture as DDS, in one .zip.
 * DDS: DXT1 (BC1) for opaque maps, DXT5 (BC3) when a map has transparency, or uncompressed;
 * power-of-two sizes and full mipmap chains, which sims such as Assetto Corsa expect.
 */
const SLOT_FILES = [
  ['map', 'color'], ['normalMap', 'normal'], ['roughnessMap', 'roughness'], ['metalnessMap', 'metalness'],
  ['aoMap', 'ao'], ['emissiveMap', 'emissive'], ['alphaMap', 'opacity'], ['bumpMap', 'height'],
];
const safe = (s) => (s || 'item').normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'item';

/** Name of an object, or of its nearest named parent (library props have unnamed parts). */
function nameOf(o) {
  for (let n = o; n; n = n.parent) if (n.name && !n.isScene) return n.name;
  return 'mesh';
}

function exportableMeshes(objects) {
  const out = [];
  objects.forEach((root) => root.traverse((o) => {
    if (!o.visible || o.userData.isSplat || o.userData.cropBox) return;
    if (o.isMesh && o.geometry?.getAttribute('position')) out.push(o);
  }));
  return out;
}

/** Collect materials + textures, encode textures to DDS once each. */
function collectTextures(meshes, opts, files) {
  const matNames = new Map(); // material -> unique name
  const texFile = new Map(); // image -> file name
  const used = new Set();
  let count = 0;
  const uniq = (base) => { let n = base; let k = 2; while (used.has(n)) n = `${base}_${k++}`; used.add(n); return n; };
  const ddsOf = (tex, matName, kind) => {
    if (!tex?.image) return null;
    const key = tex.image;
    if (texFile.has(key)) return texFile.get(key);
    const packed = kind === 'ao' || kind === 'roughness' || kind === 'metalness';
    const name = `${uniq(`${matName}_${packed && tex === tex._armOf ? 'arm' : kind}`)}.dds`;
    try {
      const px = textureToRGBA(tex, { maxSize: opts.maxSize, pot: true });
      const format = opts.format === 'auto' ? (px.hasAlpha ? 'BC3' : 'BC1') : opts.format;
      files[`textures/${name}`] = new Uint8Array(encodeDDS(px.data, px.width, px.height, { format, mipmaps: opts.mipmaps }));
      count += 1;
    } catch (e) { console.warn('texture skipped', e); return null; }
    texFile.set(key, name);
    return name;
  };
  const mats = [];
  meshes.forEach((m) => (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
    if (!mat || matNames.has(mat)) return;
    const name = uniq(safe(mat.name || nameOf(m)));
    matNames.set(mat, name);
    const maps = {};
    if (mat.aoMap && mat.aoMap === mat.roughnessMap) mat.aoMap._armOf = mat.aoMap;
    SLOT_FILES.forEach(([key, kind]) => { if (mat[key]) maps[kind] = ddsOf(mat[key], name, kind); });
    mats.push({ mat, name, maps });
  }));
  return { matNames, mats, count: () => count };
}

function mtlText(mats) {
  const f = (x) => x.toFixed(4);
  return `# Track & Props Studio — PBR MTL (map_Pr / map_Pm = roughness / metalness)\n${mats.map(({ mat, name, maps }) => {
    const c = mat.color && !maps.color ? mat.color : new THREE.Color(1, 1, 1);
    const lines = [`newmtl ${name}`, `Kd ${f(c.r)} ${f(c.g)} ${f(c.b)}`, 'Ka 0 0 0', 'Ks 0.04 0.04 0.04',
      `Ns ${Math.round((1 - (mat.roughness ?? 0.8)) ** 2 * 900 + 10)}`, `d ${f(mat.opacity ?? 1)}`, 'illum 2'];
    if (mat.roughness !== undefined) lines.push(`Pr ${f(mat.roughness)}`);
    if (mat.metalness !== undefined) lines.push(`Pm ${f(mat.metalness)}`);
    if (mat.emissive && (mat.emissive.r || mat.emissive.g || mat.emissive.b)) lines.push(`Ke ${f(mat.emissive.r)} ${f(mat.emissive.g)} ${f(mat.emissive.b)}`);
    const t = (k) => `textures/${maps[k]}`;
    if (maps.color) lines.push(`map_Kd ${t('color')}`);
    if (maps.normal) lines.push(`map_Bump -bm ${f(Math.abs(mat.normalScale?.x ?? 1))} ${t('normal')}`, `norm ${t('normal')}`);
    else if (maps.height) lines.push(`map_Bump ${t('height')}`);
    if (maps.roughness) lines.push(`map_Pr ${t('roughness')}`);
    if (maps.metalness) lines.push(`map_Pm ${t('metalness')}`);
    if (maps.ao) lines.push(`map_Ka ${t('ao')}`);
    if (maps.emissive) lines.push(`map_Ke ${t('emissive')}`);
    if (maps.opacity) lines.push(`map_d ${t('opacity')}`);
    return lines.join('\n');
  }).join('\n\n')}\n`;
}

/** OBJ with world transforms, normals, UVs and one `usemtl` per material group. */
function objText(meshes, matNames, mtlName) {
  const out = [`# Track & Props Studio\nmtllib ${mtlName}\n`];
  let vOff = 1; let tOff = 1; let nOff = 1;
  const v = new THREE.Vector3(); const n = new THREE.Vector3(); const nm = new THREE.Matrix3();
  const usedNames = new Set();
  meshes.forEach((m) => {
    m.updateMatrixWorld(true);
    nm.getNormalMatrix(m.matrixWorld);
    const g = m.geometry;
    const pos = g.getAttribute('position'); const nor = g.getAttribute('normal'); const uv = g.getAttribute('uv');
    const baseName = safe(nameOf(m));
    let name = baseName; let k = 2;
    while (usedNames.has(name)) name = `${baseName}_${k++}`;
    usedNames.add(name);
    const lines = [`o ${name}`];
    for (let i = 0; i < pos.count; i += 1) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); lines.push(`v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}`); }
    if (uv) for (let i = 0; i < uv.count; i += 1) lines.push(`vt ${uv.getX(i).toFixed(5)} ${uv.getY(i).toFixed(5)}`);
    if (nor) for (let i = 0; i < nor.count; i += 1) { n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); lines.push(`vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}`); }
    const index = g.index ? g.index.array : null;
    const triCount = index ? index.length : pos.count;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const groups = Array.isArray(m.material) && g.groups.length ? g.groups : [{ start: 0, count: triCount, materialIndex: 0 }];
    const flip = m.matrixWorld.determinant() < 0;
    groups.forEach((gr) => {
      const mat = mats[gr.materialIndex] || mats[0];
      if (mat && matNames.has(mat)) lines.push(`usemtl ${matNames.get(mat)}`);
      const end = Math.min(triCount, gr.start + gr.count);
      for (let i = gr.start; i + 2 < end; i += 3) {
        let a = index ? index[i] : i; let b = index ? index[i + 1] : i + 1; const c = index ? index[i + 2] : i + 2;
        if (flip) [a, b] = [b, a];
        const vert = (x) => `${x + vOff}/${uv ? x + tOff : ''}/${nor ? x + nOff : ''}`.replace(/\/\/$/, '').replace(/\/$/, '');
        lines.push(`f ${vert(a)} ${vert(b)} ${vert(c)}`);
      }
    });
    vOff += pos.count; if (uv) tOff += uv.count; if (nor) nOff += nor.count;
    out.push(lines.join('\n'));
  });
  return `${out.join('\n')}\n`;
}

function glbBytes(objects) {
  return new Promise((resolve, reject) => new GLTFExporter().parse(objects.filter((o) => !o.userData.isSplat && !o.userData.cropBox),
    (r) => resolve(new Uint8Array(r)), reject, { binary: true, onlyVisible: true, maxTextureSize: 8192 }));
}

export async function exportForSim(objects, opts) {
  const meshes = exportableMeshes(objects);
  if (!meshes.length) throw new Error('Nothing to export (select an object, or leave nothing selected for the whole scene).');
  const base = safe(opts.name || 'export');
  const files = {};
  const tex = collectTextures(meshes, opts, files);
  if (opts.model === 'obj') {
    files[`${base}.obj`] = strToU8(objText(meshes, tex.matNames, `${base}.mtl`));
    files[`${base}.mtl`] = strToU8(mtlText(tex.mats));
  } else if (opts.model === 'glb') {
    files[`${base}.glb`] = await glbBytes(objects);
  }
  files['README.txt'] = strToU8(`Exported from Track & Props Studio\n\nModel: ${opts.model === 'none' ? '(textures only)' : `${base}.${opts.model}`}\nTextures: textures/*.dds (${opts.format === 'auto' ? 'DXT1, or DXT5 when transparent' : opts.format === 'RGBA' ? 'uncompressed RGBA' : opts.format === 'BC3' ? 'DXT5' : 'DXT1'}${opts.mipmaps ? ', mipmaps' : ''}, max ${opts.maxSize}px)\nUnits: meters, Y up.\n`);
  const zip = zipSync(files, { level: 6 });
  download(new Blob([zip], { type: 'application/zip' }), `${base}_${opts.model === 'none' ? 'dds' : opts.model}_dds.zip`);
  return { textures: tex.count(), meshes: meshes.length };
}

/** Small dialog: what to export and how. */
export function openSimExport(app) {
  const ed = app.editor;
  const sel = ed.selected;
  const o = { scope: sel ? 'selection' : 'scene', model: 'obj', format: 'auto', maxSize: 2048, mipmaps: true, name: sel?.name || 'scene' };
  const dlg = el('dialog', { class: 'dialog' },
    el('h2', {}, 'Export for game / sim (DDS)'),
    el('p', { class: 'hint' }, 'One .zip with the model and all its textures converted to DDS — the texture format of Assetto Corsa, rFactor, BeamNG, Unreal / Unity imports and most sims.'),
    sel ? field('What', select([['selection', `Selected: ${sel.name || sel.type}`], ['scene', 'Whole scene']], o.scope, (v) => { o.scope = v; })) : null,
    field('Model format', select([['obj', 'OBJ + MTL (Blender, ksEditor via FBX, any 3D tool)'], ['glb', 'GLB (+ DDS copies of its textures)'], ['none', 'Textures only']], o.model, (v) => { o.model = v; })),
    field('DDS compression', select([['auto', 'Auto: DXT1, DXT5 if transparent (recommended)'], ['BC3', 'DXT5 / BC3 for everything'], ['BC1', 'DXT1 / BC1 for everything (smallest)'], ['RGBA', 'Uncompressed RGBA (largest, exact)']], o.format, (v) => { o.format = v; })),
    field('Max texture size', select([[4096, '4096 px'], [2048, '2048 px'], [1024, '1024 px'], [512, '512 px']], o.maxSize, (v) => { o.maxSize = Number(v); }), 'Sizes are rounded to powers of two (512, 1024, 2048…).'),
    checkbox('Mipmaps (recommended)', o.mipmaps, (v) => { o.mipmaps = v; }),
    field('File name', el('input', { type: 'text', value: o.name, oninput: (e) => { o.name = e.target.value; } })),
    el('div', { class: 'button-row end' },
      el('button', { onclick: () => dlg.close() }, 'Cancel'),
      el('button', {
        class: 'primary', onclick: async (e) => {
          e.target.disabled = true;
          toast('Converting textures to DDS…');
          try {
            await new Promise((r) => setTimeout(r, 30));
            const objs = o.scope === 'selection' && sel ? [sel] : ed.scene.children;
            const r = await exportForSim(objs, o);
            toast(`Exported ${r.meshes} mesh(es) and ${r.textures} DDS texture(s)`);
            dlg.close();
          } catch (err) { console.error(err); toast(err.message, 'error'); e.target.disabled = false; }
        },
      }, 'Export .zip')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
