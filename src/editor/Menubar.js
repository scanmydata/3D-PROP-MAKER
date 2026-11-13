import * as THREE from 'three';
import { el, pickFiles, toast } from '../ui/dom.js';
import { loadModel, IMPORT_ACCEPT } from './loaders.js';
import { exportGLB, exportOBJ, saveProject, loadProject, download } from './io.js';
import { centerPivot, dropToGround } from './ops.js';
import { PROP_LIBRARY } from '../generators/props.js';
import { openSimExport } from './exportSim.js';

/** Top menu bar, modelled on the three.js editor (File / Edit / Add / View). */
export function createMenubar(app) {
  const { editor } = app;
  const vp = () => editor.viewport;
  const std = () => new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.6 });
  const addMesh = (name, geo) => {
    const m = new THREE.Mesh(geo, std());
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position'));
    m.position.copy(vp().orbit.target).setY(-box.min.y);
    editor.addObject(m);
  };
  const addLight = (light, name) => {
    light.name = name;
    light.position.set(5, 10, 7);
    if (light.castShadow !== undefined && !light.isAmbientLight && !light.isHemisphereLight) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
    }
    editor.addObject(light);
  };

  async function importFiles(files) {
    for (const f of files) {
      if (/\.tps\.json$|\.json$/i.test(f.name)) {
        try { await loadProject(editor, f); toast(`Project ${f.name} opened`); } catch (e) { toast(e.message, 'error'); }
        continue;
      }
      try {
        toast(`Importing ${f.name}…`);
        const obj = await loadModel(f);
        editor.addObject(obj);
        vp().focus(obj);
      } catch (e) { console.error(e); toast(`${f.name}: ${e.message}`, 'error'); }
    }
  }
  app.importFiles = importFiles;

  const selectionOrAll = () => (editor.selected ? [editor.selected] : editor.scene.children);
  const menus = {
    File: [
      ['New scene', () => { if (confirm('Clear the scene? (cannot be undone)')) { editor.clear(); app.addDefaultLights(); } }],
      ['Open project / import model…', async () => importFiles(await pickFiles({ accept: `${IMPORT_ACCEPT},.json`, multiple: true }))],
      ['Save project (.json)', () => saveProject(editor)],
      null,
      ['Export scene as GLB', async () => { try { await exportGLB(editor.scene.children, 'scene.glb'); toast('GLB exported'); } catch (e) { toast(e.message, 'error'); } }],
      ['Export selection as GLB', async () => {
        if (!editor.selected) { toast('Select an object first', 'error'); return; }
        try { await exportGLB([editor.selected], `${editor.selected.name || 'object'}.glb`); toast('GLB exported'); } catch (e) { toast(e.message, 'error'); }
      }],
      ['Export selection/scene as OBJ', () => exportOBJ(selectionOrAll(), `${editor.selected?.name || 'scene'}.obj`)],
      ['Export for game / sim (OBJ/GLB + DDS textures)…', () => openSimExport(app)],
      ['Screenshot (PNG)', () => fetch(vp().screenshot()).then((r) => r.blob()).then((b) => download(b, 'screenshot.png'))],
    ],
    Edit: [
      ['Undo  (Ctrl+Z)', () => editor.undo()],
      ['Redo  (Ctrl+Y)', () => editor.redo()],
      null,
      ['Duplicate  (Ctrl+D)', () => editor.duplicate(editor.selected)],
      ['Delete  (Del)', () => editor.removeObject(editor.selected)],
      ['Pivot to bottom-centre', () => centerPivot(editor, editor.selected)],
      ['Drop to ground', () => dropToGround(editor, editor.selected)],
      null,
      ['Move  (W)', () => vp().transform.setMode('translate')],
      ['Rotate  (E)', () => vp().transform.setMode('rotate')],
      ['Scale  (R)', () => vp().transform.setMode('scale')],
      ['Toggle local / world  (Q)', () => vp().transform.setSpace(vp().transform.space === 'local' ? 'world' : 'local')],
    ],
    Add: [
      ['Group', () => { const g = new THREE.Group(); g.name = 'Group'; editor.addObject(g); }],
      ['Box', () => addMesh('Box', new THREE.BoxGeometry(1, 1, 1))],
      ['Sphere', () => addMesh('Sphere', new THREE.SphereGeometry(0.5, 32, 16))],
      ['Cylinder', () => addMesh('Cylinder', new THREE.CylinderGeometry(0.5, 0.5, 1, 32))],
      ['Cone', () => addMesh('Cone', new THREE.ConeGeometry(0.5, 1, 32))],
      ['Plane', () => addMesh('Plane', new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2))],
      ['Torus', () => addMesh('Torus', new THREE.TorusGeometry(0.5, 0.15, 16, 48))],
      null,
      ['Directional light', () => addLight(new THREE.DirectionalLight(0xffffff, 2), 'Directional Light')],
      ['Point light', () => addLight(new THREE.PointLight(0xffffff, 30, 0, 2), 'Point Light')],
      ['Spot light', () => addLight(new THREE.SpotLight(0xffffff, 60, 0, Math.PI / 6, 0.3), 'Spot Light')],
      ['Hemisphere light', () => addLight(new THREE.HemisphereLight(0xbfd7ff, 0x404030, 1), 'Hemisphere Light')],
      null,
      ...PROP_LIBRARY.map((p) => [`Prop: ${p.name}`, () => { const o = p.make(); o.position.copy(vp().orbit.target).setY(0); editor.addObject(o); }]),
    ],
    View: [
      ['Focus selection  (F)', () => vp().focus(editor.selected)],
      ['Frame whole scene', () => vp().focus(null)],
      ['Top view', () => vp().setView('top')],
      ['Front view', () => vp().setView('front')],
      ['Side view', () => vp().setView('right')],
      ['Perspective', () => vp().setView('persp')],
      null,
      ['Toggle grid', () => { vp().grid.visible = !vp().grid.visible; }],
      ['Toggle wireframe', () => vp().setWireframe(!vp().wireframe)],
      ['Toggle shadows', () => { vp().renderer.shadowMap.enabled = !vp().renderer.shadowMap.enabled; editor.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }],
      ['Background: dark / sky', () => { const bg = editor.scene.background; bg.set(bg.getHex() === 0x1d232b ? 0x9cc3e6 : 0x1d232b); }],
    ],
    Help: [
      ['User manual (Εγχειρίδιο)', () => app.openManual()],
      ['Keyboard shortcuts', () => alert('W move · E rotate · R scale · Q local/world\nF focus · Double-click focus\nDel delete · Ctrl+D duplicate\nCtrl+Z undo · Ctrl+Y / Ctrl+Shift+Z redo\nClick selects object, click again selects the part.\nDrop files on the viewport to import.')],
      ['Spirula Studio (3D engine)', () => window.open('https://github.com/harry7557558/spirula-studio', '_blank', 'noopener')],
    ],
  };

  const bar = el('nav', { class: 'menubar' });
  Object.entries(menus).forEach(([title, items]) => {
    const dropdown = el('div', { class: 'menu-items' }, ...items.map((it) => (it ? el('div', {
      class: 'menu-item', onclick: () => { bar.classList.remove('open'); it[1](); },
    }, it[0]) : el('hr'))));
    bar.append(el('div', { class: 'menu' }, el('div', { class: 'menu-title' }, title), dropdown));
  });

  // Drag & drop anywhere on the viewport.
  app.viewportEl.addEventListener('drop', (e) => { e.preventDefault(); importFiles([...e.dataTransfer.files]); });
  app.viewportEl.addEventListener('dragover', (e) => e.preventDefault());
  return bar;
}
