import './styles.css';
import * as THREE from 'three';
import { Editor } from './editor/Editor.js';
import { Viewport } from './editor/Viewport.js';
import { Outliner } from './editor/Outliner.js';
import { Inspector } from './editor/Inspector.js';
import { createMenubar } from './editor/Menubar.js';
import { CapturePanel } from './panels/CapturePanel.js';
import { StreetViewPanel } from './panels/StreetViewPanel.js';
import { PropsPanel } from './panels/PropsPanel.js';
import { JobsPanel } from './panels/JobsPanel.js';
import { MapDataPanel } from './panels/MapDataPanel.js';
import { StartPanel } from './panels/StartPanel.js';
import { openSettings } from './panels/Settings.js';
import { el } from './ui/dom.js';
import { api } from './api.js';

THREE.Cache.enabled = true;

const TABS = [
  ['start', 'Start'],
  ['capture', 'Capture'],
  ['route', 'Route & Street View'],
  ['data', 'Map data'],
  ['props', 'Props'],
  ['jobs', 'Jobs'],
];

class App {
  constructor(root) {
    this.editor = new Editor();
    this.viewportEl = el('main', { class: 'viewport' });
    this.mapOverlay = el('div', { class: 'map-overlay hidden' });
    this.viewportEl.append(this.mapOverlay);
    this.statusEl = el('div', { class: 'statusbar' });
    this.healthEl = el('button', { class: 'health', onclick: () => this.openSettings() }, 'Backend …');
    this.tabButtons = {};
    this.tabBodies = {};

    const sidebar = el('aside', { class: 'sidebar left' });
    const tabbar = el('div', { class: 'tabs' });
    const bodies = el('div', { class: 'tab-bodies' });
    sidebar.append(tabbar, bodies);

    const outlinerEl = el('div', { class: 'outliner' });
    const inspectorEl = el('div', { class: 'inspector' });
    const right = el('aside', { class: 'sidebar right' },
      el('div', { class: 'side-title' }, 'Scene'), outlinerEl,
      el('div', { class: 'side-title' }, 'Properties'), inspectorEl);

    const header = el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, 'TP'), el('span', {}, 'Track & Props Studio')));
    root.append(el('div', { class: 'app' }, header, sidebar, this.viewportEl, right, this.statusEl));

    new Viewport(this.editor, this.viewportEl);
    header.append(createMenubar(this), el('div', { class: 'spacer' }), this.healthEl,
      el('button', { class: 'icon-btn', title: 'User manual', onclick: () => this.openManual() }, '?'),
      el('button', { class: 'icon-btn', title: 'Settings', onclick: () => this.openSettings() }, '⚙'));
    new Outliner(this.editor, outlinerEl);
    new Inspector(this.editor, inspectorEl);

    this.capture = new CapturePanel(this);
    this.streetview = new StreetViewPanel(this);
    this.props = new PropsPanel(this);
    this.jobs = new JobsPanel(this);
    this.mapData = new MapDataPanel(this);
    this.start = new StartPanel(this);
    const panels = { start: this.start, capture: this.capture, route: this.streetview, data: this.mapData, props: this.props, jobs: this.jobs };
    TABS.forEach(([id, label]) => {
      this.tabButtons[id] = el('button', { class: 'tab', onclick: () => this.showTab(id) }, label);
      tabbar.append(this.tabButtons[id]);
      this.tabBodies[id] = el('div', { class: 'tab-body hidden' }, panels[id].root);
      bodies.append(this.tabBodies[id]);
    });
    this.panels = panels;
    this.showTab('start');

    this.addDefaultLights();
    this.editor.on('sceneChanged', () => this.updateStatus());
    this.editor.on('selectionChanged', () => this.updateStatus());
    this.editor.on('toolChanged', () => this.updateStatus());
    this.updateStatus();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 15000);
  }

  addDefaultLights() {
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.name = 'Sun';
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 200 });
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3a3a30, 0.8);
    hemi.name = 'Sky';
    this.editor.scene.add(sun, hemi);
    this.editor.emit('sceneChanged');
  }

  openSettings(tab) { openSettings(this, tab); }

  /** Switch to a tab and bring one of its sections (data-guide="…") into view. */
  focusSection(tab, key) {
    this.showTab(tab);
    if (!key) return;
    const node = this.tabBodies[tab].querySelector(`[data-guide="${key}"]`);
    if (!node) return;
    if (node.tagName === 'DETAILS') node.open = true;
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  /** The user manual (docs/MANUAL.md, Greek) in a reading dialog. */
  async openManual() {
    const [{ marked }, md] = await Promise.all([import('marked'), import('../docs/MANUAL.md?raw')]);
    const body = el('article', { class: 'manual', html: marked.parse(md.default) });
    const dlg = el('dialog', { class: 'dialog manual-dialog' },
      el('div', { class: 'manual-head' }, el('strong', {}, 'Εγχειρίδιο χρήσης'), el('button', { class: 'icon-btn', onclick: () => dlg.close() }, '×')),
      body);
    body.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  showTab(id) {
    Object.entries(this.tabButtons).forEach(([k, b]) => b.classList.toggle('active', k === id));
    Object.entries(this.tabBodies).forEach(([k, b]) => b.classList.toggle('hidden', k !== id));
    if (id === 'start') this.start.render(); // route / Spirula status may have changed
    if (id === 'route') this.streetview.activate();
    else if (!this.mapOverlay.classList.contains('hidden')) this.streetview.toggleLarge();
  }

  setJobBadge(n) {
    this.tabButtons.jobs.textContent = n ? `Jobs (${n})` : 'Jobs';
  }

  async checkHealth() {
    try {
      const h = await api.health();
      const prevAi = this.health?.ai_enabled;
      const prevSpirula = !!this.health?.spirula;
      this.health = h;
      this.healthEl.className = `health ${h.spirula ? 'ok' : 'warn'}`;
      const gpu = h.gpu_active ? ` · GPU busy${h.gpu_waiting ? ` (+${h.gpu_waiting} waiting)` : ''}` : '';
      this.healthEl.textContent = `${h.spirula ? '● Spirula ready' : '● Spirula not set'}${h.ai_enabled ? ` · AI: ${h.ai_provider}` : ''}${gpu}`;
      if (prevAi !== h.ai_enabled && this.capture.kind === 'ai') this.capture.render();
      if (!this.tabBodies.start.classList.contains('hidden') && prevSpirula !== !!h.spirula) this.start.render();
      this.healthEl.title = h.spirula ? h.spirula : 'Click to set the Spirula Studio path (needed for 3D reconstruction)';
    } catch {
      this.health = null;
      this.healthEl.className = 'health bad';
      this.healthEl.textContent = '● Backend offline';
      this.healthEl.title = 'Start it with: npm run server';
    }
  }

  updateStatus() {
    let objects = 0; let tris = 0; let points = 0;
    this.editor.scene.traverse((o) => {
      if (o === this.editor.scene) return;
      objects += 1;
      if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position')?.count || 0) / 3 * (o.isInstancedMesh ? o.count : 1);
      if (o.isPoints && o.geometry) points += o.geometry.getAttribute('position')?.count || 0;
    });
    const tc = this.editor.viewport.transform;
    this.statusEl.textContent = `${objects} objects · ${Math.round(tris).toLocaleString()} triangles${points ? ` · ${points.toLocaleString()} points` : ''} · tool: ${tc.mode} (${tc.space})${this.editor.selected ? ` · selected: ${this.editor.selected.name || this.editor.selected.type}` : ''}`;
  }
}

window.app = new App(document.querySelector('#app'));
