import { el, toast, pickFiles } from '../ui/dom.js';
import { api } from '../api.js';
import { loadModel } from '../editor/loaders.js';
import { applyGeoref, georefMatrix, ensureOrigin, sceneOrigin } from '../track/geoFrame.js';
import { buildLidarObjects } from '../track/lidarObjects.js';
import { bboxAround, fetchOSM, buildOSM } from '../track/osm.js';
import { splitByFootprints, sceneFootprints } from '../editor/ops.js';

const KIND_LABEL = { media: 'Photos / video', streetview: 'Street View', photo3d: 'Photo → 3D', pointcloud: 'LiDAR', lidar: 'LiDAR alignment' };

const STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const LOAD_PRIORITY = ['mesh', 'splat', 'pointcloud'];

/** Backend jobs: progress, logs, outputs -> load into the editor. */
export class JobsPanel {
  constructor(app) {
    this.app = app;
    this.jobs = [];
    this.openLogs = new Set();
    this.logs = {};
    this.prevStatus = {};
    this.root = el('div', { class: 'panel-body' });
    this.list = el('div', { class: 'jobs' });
    this.root.append(this.list);
    this.loop();
  }

  async loop() {
    await this.refresh();
    const busy = this.jobs.some((j) => j.status === 'running' || j.status === 'queued');
    setTimeout(() => this.loop(), busy || this.openLogs.size ? 1500 : 6000);
  }

  async refresh() {
    try {
      this.jobs = await api.jobs();
      this.error = null;
    } catch (e) { this.error = e.message; }
    for (const id of this.openLogs) {
      try { this.logs[id] = (await api.job(id, 400)).log; } catch { /* job gone */ }
    }
    // Auto-load the best output when a job finishes while the app is open.
    for (const j of this.jobs) {
      const prev = this.prevStatus[j.id];
      if (prev && prev !== 'done' && j.status === 'done') {
        if (j.kind === 'photo3d' || j.kind === 'pointcloud') {
          j.outputs.filter((o) => ['mesh', 'pointcloud', 'objects'].includes(o.type)).forEach((o) => this.load(j, o));
        } else {
          const best = LOAD_PRIORITY.map((t) => j.outputs.find((o) => o.type === t)).find(Boolean);
          if (best) this.load(j, best);
        }
        toast(`Job "${j.title}" finished`);
      } else if (prev && prev !== 'failed' && j.status === 'failed') toast(`Job "${j.title}" failed — open its log`, 'error');
      this.prevStatus[j.id] = j.status;
    }
    this.render();
    this.app.setJobBadge(this.jobs.filter((j) => j.status === 'running').length);
  }

  async load(job, out) {
    const url = api.fileUrl(job.id, out.path);
    try {
      if (out.type === 'streetview') {
        const metas = await api.streetviewMeta(job.id);
        this.app.showTab('route');
        this.app.streetview.showPanos(metas);
        return;
      }
      if (out.type === 'route') {
        const text = await (await fetch(url)).text();
        const { parseKML } = await import('../track/geo.js');
        this.app.showTab('route');
        const sv = this.app.streetview;
        sv.activate(); sv.waypoints = []; sv.route = parseKML(text); sv.imported = true; sv.draw();
        return;
      }
      if (out.type === 'objects') {
        const data = await api.json(job.id, out.path);
        const geo = job.outputs.find((o) => o.type === 'georef');
        if (!geo) throw new Error('This job has no map placement');
        const ed = this.app.editor;
        const { root, buildings, trees } = buildLidarObjects(data, georefMatrix(ed, await api.json(job.id, geo.path)), job.title.replace(/^LiDAR [^·]*· /, ''));
        if (!buildings && !trees) { toast('No buildings or trees found in this scan', 'error'); return; }
        root.userData.geo = { origin: sceneOrigin(ed), georeferenced: true };
        ed.addObject(root);
        ed.viewport.focus(root);
        toast(`${buildings} building(s) and ${trees} tree(s) added as separate objects (${data.mode === 'classes' ? 'from the file’s LAS classes' : 'detected automatically'})`);
        return;
      }
      if (out.type === 'georef') {
        const g = await api.json(job.id, out.path);
        toast(`Placed on the map automatically (fit error ${g.rmse_m != null ? `${g.rmse_m.toFixed(1)} m` : 'n/a'}).`);
        return;
      }
      toast(`Loading ${out.label}…`);
      const obj = await loadModel(url, { name: out.path.split('/').pop(), type: out.type });
      obj.name = `${job.title} · ${out.label}`;
      const ed = this.app.editor;
      const geo = job.outputs.find((o) => o.type === 'georef');
      let placed = false;
      if (geo) {
        try { placed = applyGeoref(ed, obj, await api.json(job.id, geo.path), out.type === 'mesh' || out.type === 'splat' ? 'train' : 'world'); } catch (e) { console.warn('georef', e); }
      }
      ed.addObject(obj);
      ed.viewport.focus(obj);
      toast(`${out.label} loaded${placed ? ' and placed on the map' : ''}`);
      if (placed && out.type === 'mesh' && job.params?.target === 'props') await this.splitIntoProps(job, obj);
    } catch (e) { console.error(e); toast(`Could not load: ${e.message}`, 'error'); }
  }

  /** Street View "props" mode: cut the scan into one object per OSM building. */
  async splitIntoProps(job, obj) {
    const ed = this.app.editor;
    if (!sceneFootprints(ed).length && job.params?.route?.length) {
      try {
        toast('Fetching OSM buildings to split the scan…');
        const origin = ensureOrigin(ed, job.params.route[0]);
        const data = await fetchOSM(bboxAround(job.params.route, 40), { buildings: true });
        buildOSM(data, origin, { buildings: true }).groups.forEach((g) => { g.visible = false; ed.addObject(g, ed.scene, { select: false }); });
      } catch (e) { toast(`OSM: ${e.message}`, 'error'); return; }
    }
    const n = splitByFootprints(ed, obj, sceneFootprints(ed));
    toast(n ? `Scan split into ${n} building prop(s) + street` : 'No building outlines overlap the scan', n ? 'info' : 'error');
  }

  async alignLidar(job) {
    const files = await pickFiles({ accept: '.las,.laz,.ply,.e57', multiple: true });
    if (!files.length) return;
    const epsg = prompt('Coordinate system (EPSG code) of the scan — 2100 = ΕΓΣΑ87 (Greece):', '2100');
    if (!epsg) return;
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    form.append('epsg', epsg);
    const origin = sceneOrigin(this.app.editor);
    if (origin) { form.append('origin_lat', String(origin[0])); form.append('origin_lon', String(origin[1])); }
    try {
      await api.createLidarAlignJob(job.id, form);
      toast('Aligning to the scan, then retraining — follow it here.');
      this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  render() {
    if (this.error) {
      this.list.replaceChildren(el('div', { class: 'notice error' }, this.error));
      return;
    }
    if (!this.jobs.length) {
      this.list.replaceChildren(el('div', { class: 'empty' }, 'No jobs yet. Start one from Capture or Route & Street View.'));
      return;
    }
    const scroll = {};
    this.list.querySelectorAll('pre.log').forEach((p) => { scroll[p.dataset.id] = p.scrollTop + p.clientHeight >= p.scrollHeight - 4; });
    this.list.replaceChildren(...this.jobs.map((j) => this.card(j)));
    this.list.querySelectorAll('pre.log').forEach((p) => { if (scroll[p.dataset.id] !== false) p.scrollTop = p.scrollHeight; });
  }

  card(j) {
    const running = j.status === 'running' || j.status === 'queued';
    const logOpen = this.openLogs.has(j.id);
    return el('div', { class: `job-card ${j.status}` },
      el('div', { class: 'job-head' },
        el('strong', {}, j.title),
        el('span', { class: `chip ${j.status}` }, STATUS_LABEL[j.status] || j.status)),
      el('div', { class: 'muted small' }, `${KIND_LABEL[j.kind] || j.kind} · ${new Date(j.created * 1000).toLocaleString()}`),
      running || j.progress < 1 ? el('div', { class: 'progress' }, el('div', { class: 'bar', style: `width:${Math.round(j.progress * 100)}%` })) : null,
      j.stage ? el('div', { class: 'small' }, `${j.stage}${running ? ` — ${Math.round(j.progress * 100)}%` : ''}`) : null,
      j.error ? el('div', { class: 'notice error small' }, j.error) : null,
      j.outputs.length ? el('div', { class: 'outputs' }, ...j.outputs.map((o) => el('div', { class: 'output-row' },
        el('span', {}, o.label),
        el('button', { class: 'small', onclick: () => this.load(j, o) }, ['streetview', 'route'].includes(o.type) ? 'Show on map' : o.type === 'georef' ? 'Info' : 'Load'),
        el('a', { class: 'small-link', href: api.fileUrl(j.id, o.path), download: o.path.split('/').pop() }, '⬇')))) : null,
      el('div', { class: 'button-row' },
        running ? el('button', { class: 'small', onclick: async () => { await api.cancel(j.id); this.refresh(); } }, 'Cancel') : null,
        !running ? el('button', { class: 'small', onclick: async () => { try { await api.rerun(j.id); this.refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Re-run') : null,
        !running && (j.kind === 'media' || j.kind === 'streetview') && j.outputs.some((o) => o.type === 'pointcloud')
          ? el('button', { class: 'small', title: 'Snap this reconstruction onto a laser scan (LAS/LAZ/PLY/E57) and retrain', onclick: () => this.alignLidar(j) }, 'Align with LiDAR') : null,
        el('button', {
          class: 'small', onclick: () => { if (logOpen) this.openLogs.delete(j.id); else this.openLogs.add(j.id); this.refresh(); },
        }, logOpen ? 'Hide log' : 'Log'),
        !running ? el('button', { class: 'small danger', onclick: async () => { if (confirm(`Delete job "${j.title}" and its files?`)) { await api.remove(j.id); this.refresh(); } } }, 'Delete') : null),
      logOpen ? el('pre', { class: 'log', 'data-id': j.id }, (this.logs[j.id] || []).join('\n')) : null);
  }
}
