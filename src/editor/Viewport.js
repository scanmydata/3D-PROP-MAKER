import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { snapshot } from './Editor.js';

/** Interactive 3D viewport: orbit camera, picking, transform gizmo, helpers, keyboard shortcuts. */
export class Viewport {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    editor.viewport = this;

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = editor.scene;
    scene.background = new THREE.Color(0x1d232b);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50000);
    this.camera.position.set(6, 4, 8);
    this.camera.name = 'Camera';

    this.helpers = new THREE.Scene();
    this.grid = new THREE.Group();
    const g1 = new THREE.GridHelper(200, 200, 0x3a4350, 0x2a313a);
    const g2 = new THREE.GridHelper(200, 20, 0x56606d, 0x56606d);
    g1.material.depthWrite = false; g2.material.depthWrite = false;
    this.grid.add(g1, g2);
    this.helpers.add(this.grid);
    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xffb020);
    this.selectionBox.visible = false;
    this.helpers.add(this.selectionBox);

    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = true;

    const tc = new TransformControls(this.camera, renderer.domElement);
    this.transform = tc;
    this.helpers.add(tc.getHelper ? tc.getHelper() : tc);
    let before = null;
    tc.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      const obj = tc.object;
      if (!obj) return;
      if (e.value) before = snapshot(obj);
      else if (before) { editor.recordTransform(obj, before); before = null; }
    });
    tc.addEventListener('objectChange', () => { this.updateSelectionBox(); editor.emit('objectChanged', tc.object); });

    this.raycaster = new THREE.Raycaster();
    this.wireframe = false;
    this._initPicking();
    this._initKeys();

    editor.on('selectionChanged', (obj) => this._onSelect(obj));
    editor.on('objectChanged', () => this.updateSelectionBox());
    editor.on('sceneChanged', () => this.updateSelectionBox());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    renderer.setAnimationLoop(() => this.render());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.orbit.update();
    const r = this.renderer;
    r.clear();
    r.render(this.editor.scene, this.camera);
    r.render(this.helpers, this.camera);
  }

  // ---- selection ------------------------------------------------------
  _onSelect(obj) {
    const tc = this.transform;
    if (obj && obj !== this.editor.scene) tc.attach(obj); else tc.detach();
    this.updateSelectionBox();
  }

  updateSelectionBox() {
    const obj = this.editor.selected;
    if (!obj || obj.userData.isSplat) { this.selectionBox.visible = false; return; }
    this.selectionBox.box.setFromObject(obj, true);
    this.selectionBox.visible = !this.selectionBox.box.isEmpty();
  }

  _initPicking() {
    const el = this.renderer.domElement;
    const down = new THREE.Vector2();
    el.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || this.transform.dragging) return;
      if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
      const hit = this.pick(e);
      if (!hit) { this.editor.select(null); return; }
      // First click selects the top-level object; clicking it again drills into the exact part.
      const top = topLevel(hit.object, this.editor.scene);
      const sel = this.editor.selected;
      const insideSel = sel && sel !== this.editor.scene && isAncestor(sel, hit.object);
      this.editor.select(insideSel && sel !== hit.object ? hit.object : top);
    });
    el.addEventListener('dblclick', (e) => { const hit = this.pick(e); if (hit) this.focus(hit.object); });
    // Drop files onto the viewport to import them.
    el.addEventListener('dragover', (e) => e.preventDefault());
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.raycaster.params.Points.threshold = Math.max(0.01, dist * 0.004);
    this.raycaster.params.Line.threshold = Math.max(0.02, dist * 0.004);
    const targets = [];
    this.editor.scene.traverseVisible((o) => { if ((o.isMesh || o.isPoints || o.isLine) && !o.userData.noPick) targets.push(o); });
    const hits = this.raycaster.intersectObjects(targets, false);
    return hits[0] || null;
  }

  focus(object) {
    const box = new THREE.Box3().setFromObject(object || this.editor.scene, true);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, Math.max(dist, 0.5));
    this.camera.near = Math.max(0.01, dist / 5000);
    this.camera.far = Math.max(1000, dist * 50);
    this.camera.updateProjectionMatrix();
    // Grow the grid for large (track-scale) scenes.
    const s = Math.max(1, 10 ** Math.floor(Math.log10(sphere.radius * 2)) / 100);
    this.grid.scale.setScalar(s);
  }

  setView(name) {
    const t = this.orbit.target;
    const d = this.camera.position.distanceTo(t);
    const v = { top: [0, 1, 0.0001], front: [0, 0, 1], right: [1, 0, 0], persp: [0.6, 0.45, 0.66] }[name];
    this.camera.position.copy(t).add(new THREE.Vector3(...v).normalize().multiplyScalar(d));
  }

  setWireframe(on) {
    this.wireframe = on;
    this.editor.scene.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m) m.wireframe = on; });
    });
  }

  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  _initKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      const ed = this.editor;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
      if (ctrl && k === 'y') { e.preventDefault(); ed.redo(); return; }
      if (ctrl && k === 'd') { e.preventDefault(); ed.duplicate(ed.selected); return; }
      if (ctrl) return;
      if (k === 'w') this.transform.setMode('translate');
      else if (k === 'e') this.transform.setMode('rotate');
      else if (k === 'r') this.transform.setMode('scale');
      else if (k === 'q') this.transform.setSpace(this.transform.space === 'local' ? 'world' : 'local');
      else if (k === 'f') this.focus(ed.selected);
      else if (k === 'delete' || k === 'backspace') ed.removeObject(ed.selected);
      else if (k === 'escape') ed.select(null);
      else return;
      ed.emit('toolChanged');
    });
  }
}

function topLevel(object, scene) {
  let o = object;
  while (o.parent && o.parent !== scene) o = o.parent;
  return o;
}
function isAncestor(a, b) {
  for (let o = b; o; o = o.parent) if (o === a) return true;
  return false;
}
