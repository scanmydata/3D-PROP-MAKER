import { el, field, select, checkbox, toast, pickFiles } from '../ui/dom.js';
import { OSM_LAYERS, bboxAround, fetchOSM, buildOSM } from '../track/osm.js';
import { ensureOrigin, sceneOrigin } from '../track/geoFrame.js';
import { api } from '../api.js';

const CRS = [
  [0, 'Auto — read it from the file (falls back to ΕΓΣΑ87)'],
  [2100, 'EPSG:2100 — ΕΓΣΑ87 / Greek Grid (Κτηματολόγιο, most Greek data)'],
  [32634, 'EPSG:32634 — UTM 34N (western Greece)'],
  [32635, 'EPSG:32635 — UTM 35N (eastern Greece, islands)'],
  [3857, 'EPSG:3857 — Web Mercator'],
];

/** Real-world data around the route: OpenStreetMap props and LiDAR / point-cloud scans. */
export class MapDataPanel {
  constructor(app) {
    this.app = app;
    this.layers = { buildings: true, roads: false, trees: true, furniture: true, barriers: true };
    this.buffer = 60;
    this.lidar = { epsg: 0, max_points: 3000000, make: 'both', keep_points: false, cell_m: 0 };
    this.root = el('div', { class: 'panel-body' });
    this.render();
  }

  render() {
    const L = this.lidar;
    const sources = el('div', { class: 'source-list' }, el('span', { class: 'muted' }, 'Loading…'));
    api.lidarSources().then((list) => sources.replaceChildren(...list.map((s) => el('div', { class: 'source' },
      s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name) : el('strong', {}, s.name),
      el('span', { class: 'muted' }, ` · ${s.type}`))))).catch(() => sources.replaceChildren(el('span', { class: 'muted' }, 'Backend offline')));

    this.root.replaceChildren(
      el('p', { class: 'intro' }, 'Real map data in the same frame as your track and Street View scans. Not sure which source to use? See the Start tab.'),
      el('details', { class: 'section', open: true, 'data-guide': 'osm' },
        el('summary', {}, 'OpenStreetMap → map / objects (instant)'),
        ...Object.entries(OSM_LAYERS).map(([k, label]) => checkbox(label, this.layers[k], (v) => { this.layers[k] = v; })),
        field('Distance around the route (m)', el('input', { type: 'number', min: '10', max: '500', step: '10', value: String(this.buffer), onchange: (e) => { this.buffer = Number(e.target.value); } })),
        el('button', { class: 'primary wide', onclick: () => this.importOSM() }, 'Import OSM around route'),
        el('p', { class: 'hint' }, 'Each building is its own object (named from OSM) with its real height when tagged. Select a Street View scan and use “Split by OSM buildings” to cut it into per-building props. Data © OpenStreetMap contributors (ODbL).')),
      el('details', { class: 'section', open: true, 'data-guide': 'lidar' },
        el('summary', {}, 'LiDAR scan → map / objects'),
        field('Make from the scan', select([
          ['map', 'Map: ground surface (terrain mesh)'],
          ['objects', 'Objects: buildings + trees, each separate'],
          ['both', 'Both: terrain + buildings + trees'],
          ['points', 'Only the raw point cloud'],
        ], L.make, (v) => { L.make = v; this.render(); }), {
          map: 'Bare earth without buildings/trees, coloured from the scan (or by height) — the base of a track or area.',
          objects: 'Buildings get their outline and roof height from the scan; trees their height and crown. Each one can be moved, textured and exported alone.',
          both: 'Terrain + objects, already lined up.',
          points: 'Just the points, e.g. to compare with a reconstruction.',
        }[L.make]),
        L.make !== 'points' ? checkbox('Also show the raw points', L.keep_points, (v) => { L.keep_points = v; }) : null,
        field('Coordinate system of the file', select(CRS, L.epsg, (v) => { L.epsg = Number(v); })),
        L.make !== 'points' ? field('Terrain detail', select([[0, 'Auto (from point density)'], [0.5, '0.5 m'], [1, '1 m'], [2, '2 m'], [5, '5 m (large areas)']], L.cell_m, (v) => { L.cell_m = Number(v); })) : null,
        field('Max points to show', select([[1000000, '1 million'], [3000000, '3 million'], [8000000, '8 million (needs RAM)']], L.max_points, (v) => { L.max_points = Number(v); })),
        el('button', { class: 'primary wide', onclick: () => this.importLidar() }, 'Choose LAS / LAZ / PLY file(s)…'),
        el('p', { class: 'hint' }, 'Runs on the CPU in seconds to a few minutes and lands in the scene’s map frame, next to the track / OSM. Files with ground/building/vegetation classes (most national LiDAR) give the best split. To make a Street View / photo reconstruction match a scan exactly, use “Align with LiDAR” on its job in the Jobs tab.'),
        el('div', { class: 'insp-subtitle' }, 'Free data for Greece'),
        sources,
        el('p', { class: 'hint' }, 'No open nationwide airborne LiDAR for mainland Greece was found (checked Nov 2026); open point clouds cover only specific sites. For a track, a phone/tablet LiDAR scan or the 30 m Copernicus DEM are the realistic free options.')),
    );
  }

  routeOrRegion() {
    const sv = this.app.streetview;
    if (sv.route.length > 1) return sv.route;
    if (sv.map) { const b = sv.map.getBounds(); return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]; }
    return null;
  }

  async importOSM(layers = this.layers) {
    const pts = this.routeOrRegion();
    if (!pts) { toast('Draw a route (or open the Route tab map) first', 'error'); return; }
    const ed = this.app.editor;
    const origin = ensureOrigin(ed, pts[0]);
    try {
      toast('Downloading OpenStreetMap data…');
      const data = await fetchOSM(bboxAround(pts, this.buffer), layers);
      const { groups, counts } = buildOSM(data, origin, layers);
      if (!groups.length) { toast('No OSM features here for the chosen layers', 'error'); return; }
      groups.forEach((g) => ed.addObject(g, ed.scene, { select: false }));
      ed.viewport.focus(groups[0]);
      toast(`OSM: ${Object.entries(counts).map(([k, n]) => `${n} ${OSM_LAYERS[k].toLowerCase()}`).join(', ')}`);
    } catch (e) { console.error(e); toast(e.message, 'error'); }
  }

  async importLidar(picked, { make = this.lidar.make, stay = false } = {}) {
    const files = picked || await pickFiles({ accept: '.las,.laz,.ply', multiple: true });
    if (!files.length) return;
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    form.append('epsg', String(this.lidar.epsg));
    form.append('max_points', String(this.lidar.max_points));
    form.append('make', make);
    form.append('keep_points', String(!!this.lidar.keep_points));
    if (this.lidar.cell_m) form.append('cell_m', String(this.lidar.cell_m));
    const origin = sceneOrigin(this.app.editor);
    if (origin) { form.append('origin_lat', String(origin[0])); form.append('origin_lon', String(origin[1])); }
    try {
      toast(`Uploading ${files.length} scan(s)…`);
      await api.createPointCloudJob(form);
      toast('Processing the scan — the result opens in the scene when ready (Jobs tab).');
      if (!stay) this.app.showTab('jobs');
      this.app.jobs.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
}
