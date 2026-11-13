import * as THREE from 'three';
import { el, checkbox, pickFiles, toast } from '../ui/dom.js';
import { textureSection } from './materialSlots.js';
import { centerPivot, dropToGround, rotateFix, levelToGround, simplify, createCropBox, crop, geometryStats, splitByFootprints, sceneFootprints } from './ops.js';

const R2D = THREE.MathUtils.RAD2DEG;

/** Properties of the selected object: transform, material, mesh tools. */
export class Inspector {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    editor.on('selectionChanged', () => this.render());
    editor.on('objectChanged', (o) => { if (o === editor.selected) this.refreshTransform(); });
    editor.on('sceneChanged', () => { if (!editor.selected) this.render(); });
    this.render();
  }

  render() {
    const o = this.editor.selected;
    if (!o) {
      this.container.replaceChildren(el('div', { class: 'empty' },
        el('p', {}, 'Select an object to edit it.'),
        el('p', { class: 'hint' }, 'W move · E rotate · R scale · Q local/world · F focus · Del delete · Ctrl+D duplicate · Ctrl+Z undo')));
      return;
    }
    this.inputs = {};
    const sections = [this.objectSection(o), this.transformSection(o)];
    if (o.isLight) sections.push(this.lightSection(o));
    const mat = firstMaterial(o);
    if (mat) sections.push(this.materialSection(o, mat));
    if (mat && !o.isPoints) sections.push(textureSection(this.editor, o, () => this.render()));
    if (o.isPoints && o.material?.size !== undefined) sections.push(this.pointsSection(o));
    if (!o.isLight) sections.push(this.toolsSection(o));
    if (Object.keys(o.userData || {}).length) sections.push(this.userDataSection(o));
    this.container.replaceChildren(...sections);
  }

  objectSection(o) {
    const ed = this.editor;
    const stats = geometryStats(o);
    return el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, o.userData.isSplat ? 'Gaussian Splat' : o.type),
      el('input', {
        class: 'name-input', value: o.name,
        onchange: (e) => ed.setValue(o, 'Rename', () => o.name, (v) => { o.name = v; ed.emit('sceneChanged'); }, e.target.value),
      }),
      el('div', { class: 'stats' }, stats.tris ? `${stats.tris.toLocaleString()} triangles` : '', stats.points ? ` ${stats.points.toLocaleString()} points` : ''),
      el('div', { class: 'row-checks' },
        checkbox('Visible', o.visible, (v) => ed.setValue(o, 'Visibility', () => o.visible, (x) => { o.visible = x; ed.emit('sceneChanged'); }, v)),
        o.isMesh || o.isGroup ? checkbox('Shadows', !!o.castShadow, (v) => o.traverse((c) => { c.castShadow = v; c.receiveShadow = v; })) : null));
  }

  transformSection(o) {
    const ed = this.editor;
    const vec = (label, key, toUi, fromUi, step) => {
      const inputs = ['x', 'y', 'z'].map((axis) => el('input', {
        type: 'number', step: String(step),
        onchange: () => {
          const before = { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
          const vals = inputs.map((i) => Number(i.value));
          fromUi(vals);
          o.updateMatrixWorld(true);
          ed.recordTransform(o, before);
        },
      }));
      this.inputs[key] = { inputs, toUi };
      return el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, label), ...inputs);
    };
    const uniform = el('input', {
      type: 'number', step: '0.1', title: 'Uniform scale', placeholder: 'uniform',
      onchange: (e) => {
        const s = Number(e.target.value);
        if (!s) return;
        const before = { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
        o.scale.setScalar(s); o.updateMatrixWorld(true); ed.recordTransform(o, before);
      },
    });
    const sec = el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, 'Transform (meters / degrees)'),
      vec('Position', 'p', () => o.position.toArray(), (v) => o.position.set(...v), 0.1),
      vec('Rotation', 'r', () => [o.rotation.x * R2D, o.rotation.y * R2D, o.rotation.z * R2D], (v) => o.rotation.set(v[0] / R2D, v[1] / R2D, v[2] / R2D), 1),
      vec('Scale', 's', () => o.scale.toArray(), (v) => o.scale.set(...v), 0.01),
      el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Uniform'), uniform),
      el('div', { class: 'tool-modes' },
        ...['translate', 'rotate', 'scale'].map((m) => el('button', {
          class: `small${ed.viewport.transform.mode === m ? ' active' : ''}`,
          onclick: (e) => { ed.viewport.transform.setMode(m); e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target)); },
        }, { translate: 'Move (W)', rotate: 'Rotate (E)', scale: 'Scale (R)' }[m]))));
    this.refreshTransform();
    return sec;
  }

  refreshTransform() {
    if (!this.inputs) return;
    for (const { inputs, toUi } of Object.values(this.inputs)) {
      const vals = toUi();
      inputs.forEach((i, k) => { if (document.activeElement !== i) i.value = String(+vals[k].toFixed(4)); });
    }
  }

  lightSection(o) {
    const ed = this.editor;
    return el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, 'Light'),
      el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Color'),
        el('input', { type: 'color', value: `#${o.color.getHexString()}`, oninput: (e) => { o.color.set(e.target.value); } })),
      el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Intensity'),
        el('input', { type: 'number', step: '0.1', value: String(o.intensity), onchange: (e) => ed.setValue(o, 'Intensity', () => o.intensity, (v) => { o.intensity = v; }, Number(e.target.value)) })));
  }

  materialSection(o, mat) {
    const ed = this.editor;
    const prop = (label, key, step, min, max) => (key in mat ? el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, label),
      el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(mat[key]),
        oninput: (e) => { allMaterials(o).forEach((m) => { if (key in m) { m[key] = Number(e.target.value); m.needsUpdate = key === 'opacity'; if (key === 'opacity') m.transparent = m.opacity < 1; } }); } })) : null);
    return el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, `Material · ${mat.type.replace('Material', '')}`),
      mat.color ? el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Color'),
        el('input', { type: 'color', value: `#${mat.color.getHexString()}`, oninput: (e) => allMaterials(o).forEach((m) => m.color?.set(e.target.value)) })) : null,
      prop('Roughness', 'roughness', 0.01, 0, 1),
      prop('Metalness', 'metalness', 0.01, 0, 1),
      prop('Opacity', 'opacity', 0.01, 0, 1),
      el('div', { class: 'row-checks' },
        checkbox('Wireframe', !!mat.wireframe, (v) => allMaterials(o).forEach((m) => { m.wireframe = v; })),
        checkbox('Double sided', mat.side === THREE.DoubleSide, (v) => allMaterials(o).forEach((m) => { m.side = v ? THREE.DoubleSide : THREE.FrontSide; m.needsUpdate = true; })),
        'vertexColors' in mat ? checkbox('Vertex colors', !!mat.vertexColors, (v) => allMaterials(o).forEach((m) => { m.vertexColors = v; m.needsUpdate = true; })) : null));
  }

  pointsSection(o) {
    const m = o.material;
    return el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, 'Point cloud'),
      el('div', { class: 'vec-row' }, el('span', { class: 'vec-label' }, 'Point size'),
        el('input', { type: 'range', min: '0.001', max: String(Math.max(0.2, m.size * 6)), step: '0.001', value: String(m.size), oninput: (e) => { m.size = Number(e.target.value); } })));
  }

  toolsSection(o) {
    const ed = this.editor;
    const crops = [];
    ed.scene.traverse((c) => { if (c.userData.cropBox) crops.push(c); });
    const btn = (label, fn, title) => el('button', { class: 'small', title, onclick: fn }, label);
    return el('div', { class: 'insp-section' },
      el('div', { class: 'insp-title' }, 'Model tools'),
      el('div', { class: 'button-grid' },
        btn('Focus (F)', () => ed.viewport.focus(o)),
        btn('Duplicate', () => ed.duplicate(o)),
        btn('Pivot → bottom', () => centerPivot(ed, o), 'Move the origin to the bottom-centre of the bounds'),
        btn('Drop to ground', () => dropToGround(ed, o), 'Move so the lowest point is at y = 0'),
        btn('Z-up → Y-up', () => rotateFix(ed, o, [1, 0, 0], -90), 'Photogrammetry exports are often Z-up'),
        btn('Flip upside-down', () => rotateFix(ed, o, [1, 0, 0], 180)),
        btn('Level to ground', () => { if (!levelToGround(ed, o)) toast('No geometry to level', 'error'); }, 'Fit a plane to the lowest points (road) and make it horizontal'),
        btn('Delete', () => ed.removeObject(o))),
      el('div', { class: 'insp-subtitle' }, 'Clean-up'),
      el('div', { class: 'button-grid' },
        btn('Simplify 50%', async () => { toast('Simplifying…'); const n = await simplify(ed, o, 0.5); toast(`Simplified ${n} mesh(es)`); this.render(); }),
        btn('Simplify 20%', async () => { toast('Simplifying…'); const n = await simplify(ed, o, 0.2); toast(`Simplified ${n} mesh(es)`); this.render(); }),
        btn('Add crop box', () => { const box = createCropBox(o); ed.addObject(box, ed.scene, { select: true }); toast('Move / scale the blue box over the part to keep, then select the model and press Crop.'); }),
        btn('Split by OSM buildings', () => {
          const fp = sceneFootprints(ed);
          if (!fp.length) { toast('Import OSM buildings first (Map data tab)', 'error'); return; }
          const n = splitByFootprints(ed, o, fp);
          toast(n ? `Split into ${n} building prop(s) + the rest` : 'No part of this model lies on an OSM building outline — is it placed on the map?', n ? 'info' : 'error');
        }, 'Cut a scanned street into one object per building (needs OSM buildings and a model placed on the map)')),
      crops.length && !o.userData.cropBox ? el('div', { class: 'button-grid' },
        btn('Keep inside box', () => { const n = crop(ed, o, crops[crops.length - 1], true); toast(`Cropped ${n} part(s)`); this.render(); }),
        btn('Remove inside box', () => { const n = crop(ed, o, crops[crops.length - 1], false); toast(`Cropped ${n} part(s)`); this.render(); })) : null,
      o.userData.isSplat ? el('p', { class: 'hint' }, 'Splats can be moved/rotated/scaled here. Crop/simplify work on meshes and point clouds.') : null);
  }

  userDataSection(o) {
    const data = { ...o.userData };
    delete data.source;
    const text = JSON.stringify(data, (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v), 1);
    if (!text || text === '{}') return el('div');
    return el('details', { class: 'insp-section' }, el('summary', { class: 'insp-title' }, 'Metadata'), el('pre', { class: 'userdata' }, text.slice(0, 3000)));
  }
}

function allMaterials(o) {
  const out = new Set();
  o.traverse((c) => (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m && out.add(m)));
  return [...out];
}
function firstMaterial(o) {
  if (o.userData.isSplat || o.userData.cropBox) return null;
  return allMaterials(o)[0] || null;
}
