import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { el, field, select, checkbox, toast, pickFiles } from '../ui/dom.js';
import { parseKML, toKML, routeAlongRoads, geocode, suggestPlaces, fetchElevations, routeLength, fmtDistance, resample, haversine } from '../track/geo.js';
import { buildTrack, TRACK_DEFAULTS } from '../track/trackBuilder.js';
import { download } from '../editor/io.js';
import { api } from '../api.js';
import { ensureOrigin, originOffset, sceneOrigin } from '../track/geoFrame.js';

const STORE_KEY = 'tps.route.v1';

/**
 * Terrain heights for every point of `pts`, looked up on a coarser grid (the DEM is ~90 m anyway,
 * and the free API is rate limited) and linearly interpolated by distance along the route.
 */
async function elevationsFor(pts) {
  const total = routeLength(pts);
  const spacing = Math.max(30, total / 900); // at most ~9 API calls
  const coarse = resample(pts, spacing);
  const coarseElev = await fetchElevations(coarse);
  const cd = [0];
  for (let i = 1; i < coarse.length; i += 1) cd.push(cd[i - 1] + haversine(coarse[i - 1], coarse[i]));
  const out = [];
  let d = 0; let k = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) d += haversine(pts[i - 1], pts[i]);
    while (k < cd.length - 2 && cd[k + 1] < d) k += 1;
    const span = cd[k + 1] - cd[k] || 1;
    const f = Math.min(1, Math.max(0, (d - cd[k]) / span));
    out.push(coarseElev[k] + (coarseElev[Math.min(k + 1, coarseElev.length - 1)] - coarseElev[k]) * f);
  }
  return out;
}

/**
 * Define a route like in Google Maps (click waypoints, follows roads) or import a KML, then:
 *  - build a procedural 3D track from it instantly, and/or
 *  - download Google Street View along it and reconstruct the real place in 3D (backend job).
 */
export class StreetViewPanel {
  constructor(app) {
    this.app = app;
    this.waypoints = [];
    this.route = [];
    this.imported = false;
    this.routing = 'roads';
    this.track = { ...TRACK_DEFAULTS, elevation: true };
    this.sv = { source: 'panorama', step_m: 8, zoom: 4, min_year: 2018, split_views: true, reconstruct: true, quality: 'standard', output: 'both', mask_moving: true, nadir_mask: 0.3, target: 'track' };
    this.restore();
    this.root = el('div', { class: 'panel-body' });
    this.mapBox = el('div', { class: 'map-box' });
    this.buildUI();
  }

  // ---- keep the route, map view and options across reloads ----
  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!saved) return;
      this.waypoints = saved.waypoints || [];
      this.route = saved.route || [];
      this.imported = !!saved.imported;
      this.routing = saved.routing || this.routing;
      Object.assign(this.track, saved.track || {});
      Object.assign(this.sv, saved.sv || {});
      this.savedView = saved.view;
      this.recent = saved.recent || [];
    } catch { /* storage blocked or corrupt: start fresh */ }
  }

  save() {
    try {
      const view = this.map ? { center: [this.map.getCenter().lat, this.map.getCenter().lng], zoom: this.map.getZoom() } : this.savedView;
      localStorage.setItem(STORE_KEY, JSON.stringify({
        waypoints: this.waypoints, route: this.route, imported: this.imported, routing: this.routing,
        track: this.track, sv: this.sv, view, recent: (this.recent || []).slice(0, 8),
      }));
    } catch { /* ignore */ }
  }

  buildUI() {
    const searchInput = this.searchBox();
    this.info = el('div', { class: 'route-info' });
    const t = this.track; const sv = this.sv;
    const setT = (k, num) => (v) => { t[k] = num ? Number(v) : v; this.save(); };
    const setS = (k, num) => (v) => { sv[k] = num ? Number(v) : v; this.save(); };
    const num = (obj, k, step, min, max) => el('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: String(obj[k]), onchange: (e) => { obj[k] = Number(e.target.value); } });

    this.root.replaceChildren(
      el('div', { class: 'search-row' }, searchInput.wrap, el('button', { class: 'small', onclick: () => this.search(searchInput.input.value) }, 'Go')),
      el('div', { class: 'map-wrap' }, this.mapBox,
        el('button', { class: 'map-expand', title: 'Large map', onclick: () => this.toggleLarge() }, '⤢')),
      el('div', { class: 'button-row' },
        select([['roads', 'Follow roads'], ['straight', 'Straight lines']], this.routing, (v) => { this.routing = v; this.save(); this.recompute(); }),
        el('button', { class: 'small', onclick: () => this.undoPoint() }, 'Undo point'),
        el('button', { class: 'small', onclick: () => this.closeLoop() }, 'Close loop'),
        el('button', { class: 'small', onclick: () => this.clear() }, 'Clear')),
      el('div', { class: 'button-row' },
        el('button', { class: 'small', onclick: () => this.importKML() }, 'Import KML…'),
        el('button', { class: 'small', onclick: () => this.exportKML() }, 'Export KML'),
        el('button', { class: 'small', onclick: () => this.reverse() }, 'Reverse')),
      this.info,
      el('p', { class: 'hint' }, 'Click the map to add waypoints (drag to move, right-click to delete). Or import a KML from Google Maps / My Maps / Google Earth.'),

      el('details', { class: 'section', open: true, 'data-guide': 'track' },
        el('summary', {}, 'A · Procedural 3D track (instant)'),
        field('Asphalt width (m)', num(t, 'width', 0.5, 3, 40)),
        field('Kerbs', select([['corners', 'On corners'], ['all', 'Everywhere'], ['none', 'None']], t.kerbs, setT('kerbs'))),
        field('Run-off each side (m)', num(t, 'runoff', 0.5, 0, 60)),
        field('Barrier', select([['armco', 'Armco guardrail'], ['wall', 'Concrete wall'], ['none', 'None']], t.barrier, setT('barrier'))),
        field('Closed circuit', select([['auto', 'Auto (ends meet)'], ['yes', 'Yes'], ['no', 'No (point-to-point)']], t.closed, setT('closed'))),
        checkbox('Real terrain elevation (Open-Meteo DEM)', t.elevation, (v) => { t.elevation = v; }),
        el('button', { class: 'primary wide', onclick: () => this.buildTrack() }, 'Build 3D track')),

      el('details', { class: 'section', open: true, 'data-guide': 'streetview' },
        el('summary', {}, 'B · Street View photos → real 3D (backend)'),
        field('Make', select([['track', 'Map: the whole street / track as one model'], ['props', 'Objects: one separate object per building']], sv.target, setS('target')),
          'Objects mode cuts the reconstructed mesh along OpenStreetMap building outlines when it loads (the street itself stays as one more object).'),
        field('Source', select([['panorama', '360° panoramas (best for 3D)'], ['static', 'Official Static API (needs key, 640 px)']], sv.source, setS('source'))),
        field('Sample every (m)', num(sv, 'step_m', 1, 2, 100), 'Smaller = more overlap = better 3D, more downloads.'),
        field('Panorama resolution', select([[3, '4096 × 2048'], [4, '8192 × 4096'], [5, '16384 × 8192']], sv.zoom, setS('zoom', true))),
        field('Newest imagery from year', num(sv, 'min_year', 1, 0, 2100)),
        checkbox('Reconstruct 3D with Spirula after download', sv.reconstruct, setS('reconstruct')),
        field('Quality', select([['preview', 'Preview'], ['standard', 'Standard'], ['high', 'High']], sv.quality, setS('quality'))),
        field('Output', select([['both', 'Mesh + splat'], ['mesh', 'Mesh'], ['splat', 'Splat']], sv.output, setS('output'))),
        checkbox('Reconstruct from perspective views (recommended; also usable in RealityScan)', sv.split_views, setS('split_views')),
        field('Ignore bottom of panoramas', select([[0, 'Nothing'], [0.15, '15% (car roof)'], [0.3, '30% (blurred ground)'], [0.45, '45%']], sv.nadir_mask, setS('nadir_mask', true)), 'Google blurs / shows the car below the camera; masked areas are not used for 3D.'),
        checkbox('Hide moving cars / people from the 3D (AI masking, CPU)', sv.mask_moving, setS('mask_moving')),
        el('button', { class: 'primary wide', onclick: () => this.startStreetView() }, 'Download Street View & build 3D'),
        el('p', { class: 'hint' }, 'Panoramas come from Google Street View; make sure your use complies with Google’s terms.')),
    );
    this.updateInfo();
  }

  /** Called when the tab is first shown (Leaflet needs a visible container). */
  activate() {
    if (this.map) { setTimeout(() => this.map.invalidateSize(), 50); return; }
    const v = this.savedView;
    const map = L.map(this.mapBox, { zoomControl: true, attributionControl: true }).setView(v?.center || [37.98, 23.73], v?.zoom || 13);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Map: osm }, {}, { position: 'topright' }).addTo(map);
    this.routeLine = L.polyline([], { color: '#ffb020', weight: 5, opacity: 0.9 }).addTo(map);
    this.markers = L.layerGroup().addTo(map);
    this.panoLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => this.addPoint([e.latlng.lat, e.latlng.lng]));
    map.on('moveend', () => this.save());
    this.searchLayer = L.layerGroup().addTo(map);
    this.map = map;
    this.draw();
    if (!v && this.route.length > 1) map.fitBounds(L.latLngBounds(this.route), { padding: [20, 20] });
    setTimeout(() => map.invalidateSize(), 50);
  }

  toggleLarge() {
    const big = this.app.mapOverlay;
    if (this.mapBox.parentNode === big) {
      this.root.querySelector('.map-wrap').prepend(this.mapBox);
      big.classList.add('hidden');
    } else {
      big.append(this.mapBox);
      big.classList.remove('hidden');
    }
    setTimeout(() => this.map?.invalidateSize(), 60);
  }

  /** Search box with live suggestions (streets, places, addresses) and recent searches. */
  searchBox() {
    const input = el('input', { type: 'search', placeholder: 'Search a street, place or circuit…', autocomplete: 'off' });
    const list = el('div', { class: 'suggest hidden' });
    const wrap = el('div', { class: 'search-wrap' }, input, list);
    let items = []; let active = -1; let timer; let seq = 0;
    const close = () => { list.classList.add('hidden'); active = -1; };
    const show = (arr, title) => {
      items = arr; active = -1;
      if (!arr.length) { close(); return; }
      list.replaceChildren(...(title ? [el('div', { class: 'suggest-title' }, title)] : []), ...arr.map((r) => el('div', {
        class: 'suggest-item', onmousedown: (e) => { e.preventDefault(); this.goTo(r); input.value = r.label; close(); },
      }, el('span', { class: 'suggest-kind' }, r.kind || '📍'), el('span', {}, el('strong', {}, r.name), r.detail ? el('small', {}, r.detail) : null))));
      list.classList.remove('hidden');
    };
    const highlight = () => list.querySelectorAll('.suggest-item').forEach((n, i) => n.classList.toggle('active', i === active));
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { show(q ? [] : (this.recent || []), 'Recent'); return; }
      timer = setTimeout(async () => {
        const my = (seq += 1);
        try {
          const c = this.map?.getCenter();
          const res = await suggestPlaces(q, c ? [c.lat, c.lng] : null);
          if (my === seq) show(res);
        } catch { /* offline: Enter still searches */ }
      }, 300);
    });
    input.addEventListener('focus', () => { if (!input.value.trim() && this.recent?.length) show(this.recent, 'Recent'); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        highlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = items[active >= 0 ? active : 0];
        if (pick && !list.classList.contains('hidden')) { this.goTo(pick); input.value = pick.label; close(); } else this.search(input.value);
      } else if (e.key === 'Escape') close();
    });
    return { wrap, input };
  }

  /** Fly to a search result, mark it, and remember it. */
  goTo(r) {
    this.app.showTab('route');
    if (r.bbox) this.map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]], { maxZoom: 18 });
    else this.map.setView([r.lat, r.lon], 17);
    this.searchLayer.clearLayers();
    const m = L.marker([r.lat, r.lon]).addTo(this.searchLayer);
    const add = el('button', { class: 'small', onclick: () => { this.addPoint([r.lat, r.lon]); this.searchLayer.clearLayers(); } }, '+ Add to route');
    m.bindPopup(el('div', { class: 'popup' }, el('strong', {}, r.name), r.detail ? el('div', { class: 'small' }, r.detail) : null, add)).openPopup();
    this.recent = [r, ...(this.recent || []).filter((x) => x.label !== r.label)].slice(0, 8);
    this.save();
  }

  async search(q) {
    if (!q.trim()) return;
    try {
      const [r] = await geocode(q);
      if (!r) { toast('Place not found', 'error'); return; }
      this.goTo({ ...r, label: r.name, name: r.name.split(',')[0], detail: r.name.split(',').slice(1, 3).join(',').trim() });
    } catch (e) { toast(e.message, 'error'); }
  }

  addPoint(p) {
    if (this.imported) { toast('Route was imported from KML — press Clear to draw a new one.', 'error'); return; }
    this.waypoints.push(p);
    this.recompute();
  }

  undoPoint() { if (!this.imported) { this.waypoints.pop(); this.recompute(); } }

  closeLoop() {
    if (this.imported) {
      if (this.route.length > 2) { this.route.push(this.route[0]); this.draw(); }
      return;
    }
    if (this.waypoints.length > 2) { this.waypoints.push(this.waypoints[0]); this.recompute(); }
  }

  reverse() {
    this.waypoints.reverse();
    this.route.reverse();
    this.draw();
  }

  clear() {
    this.waypoints = []; this.route = []; this.imported = false;
    this.panoLayer?.clearLayers();
    this.draw();
  }

  async recompute() {
    const wps = this.waypoints;
    const token = (this._token = Symbol('route'));
    if (wps.length < 2 || this.routing === 'straight') {
      this.route = wps.slice();
    } else {
      try {
        this.info.textContent = 'Routing…';
        const r = await routeAlongRoads(wps);
        if (token !== this._token) return;
        this.route = r;
      } catch (e) {
        toast(`${e.message} — using straight lines`, 'error');
        this.route = wps.slice();
      }
    }
    this.draw();
  }

  draw() {
    if (!this.map) return;
    this.routeLine.setLatLngs(this.route);
    this.markers.clearLayers();
    this.waypoints.forEach((p, i) => {
      const m = L.marker(p, {
        draggable: true,
        icon: L.divIcon({ className: 'wp-icon', html: `<span>${i + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      });
      m.on('dragend', () => { const ll = m.getLatLng(); this.waypoints[i] = [ll.lat, ll.lng]; this.recompute(); });
      m.on('contextmenu', () => { this.waypoints.splice(i, 1); this.recompute(); });
      m.addTo(this.markers);
    });
    this.updateInfo();
    this.save();
  }

  updateInfo() {
    if (!this.info) return;
    const len = this.route.length > 1 ? routeLength(this.route) : 0;
    this.info.textContent = this.route.length > 1
      ? `Route: ${fmtDistance(len)} · ${this.route.length} pts${this.imported ? ' (KML)' : ` · ${this.waypoints.length} waypoints`} · ~${Math.ceil(len / this.sv.step_m)} Street View samples`
      : 'No route yet.';
  }

  async importKML() {
    const [file] = await pickFiles({ accept: '.kml,.xml,application/vnd.google-earth.kml+xml' });
    if (!file) return;
    try {
      const pts = parseKML(await file.text());
      if (pts.length < 2) throw new Error('No line / track found in this KML');
      this.waypoints = []; this.route = pts; this.imported = true;
      this.activate();
      this.draw();
      this.map.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
      toast(`Imported ${file.name}: ${fmtDistance(routeLength(pts))}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  exportKML() {
    if (this.route.length < 2) { toast('No route to export', 'error'); return; }
    download(new Blob([toKML(this.route, 'Track route')], { type: 'application/vnd.google-earth.kml+xml' }), 'route.kml');
  }

  async buildTrack() {
    if (this.route.length < 2) { toast('Draw or import a route first', 'error'); return; }
    try {
      const pts = resample(this.route, 4);
      let elev = null;
      if (this.track.elevation) {
        toast('Fetching terrain elevation…');
        try { elev = await elevationsFor(pts); } catch (e) { toast(`${e.message} — building flat`, 'error'); }
      }
      const group = buildTrack(pts, elev, { ...this.track, name: `Track ${fmtDistance(routeLength(this.route))}` });
      // Share one map frame with OSM / LiDAR / georeferenced scans already in the scene.
      const ed = this.app.editor;
      ensureOrigin(ed, group.userData.geo.origin);
      group.position.add(originOffset(ed, group.userData.geo.origin));
      group.userData.geo.origin = sceneOrigin(ed);
      ed.addObject(group);
      ed.viewport.focus(group);
      toast(`Track built: ${fmtDistance(group.userData.length_m)}${group.userData.closed ? ', closed circuit' : ''}`);
    } catch (e) { console.error(e); toast(e.message, 'error'); }
  }

  async startStreetView({ stay = false, ...over } = {}) {
    if (this.route.length < 2) { toast('Draw or import a route first', 'error'); return; }
    try {
      const opts = { ...this.sv, ...over };
      await api.createStreetViewJob({ ...opts, title: `Street View ${opts.target === 'props' ? 'objects' : 'map'} ${fmtDistance(routeLength(this.route))}`, route: this.route, mode: 'track' });
      toast('Street View job started — see the Jobs tab.');
      if (!stay) this.app.showTab('jobs');
      this.app.jobs.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Show downloaded panorama positions on the map. */
  showPanos(metas) {
    this.activate();
    this.panoLayer.clearLayers();
    metas.forEach((m) => L.circleMarker([m.lat, m.lon], { radius: 4, color: '#2b8cff', weight: 1, fillOpacity: 0.9 })
      .bindTooltip(`${m.pano_id}${m.date ? ` · ${m.date}` : ''}`).addTo(this.panoLayer));
    if (metas.length) this.map.fitBounds(L.latLngBounds(metas.map((m) => [m.lat, m.lon])), { padding: [20, 20] });
  }
}
