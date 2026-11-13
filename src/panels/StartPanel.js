import { el, checkbox, toast, pickFiles } from '../ui/dom.js';
import { routeLength, fmtDistance } from '../track/geo.js';

/**
 * Start tab: a two-question guide.
 *   1. What do you want?   a MAP (ground, road, whole area as one environment) or OBJECTS (separate props)
 *   2. From what?          Street View photos, LiDAR, OpenStreetMap, your own photos / video …
 * Then it shows the steps and takes you to the right tab with the options already set.
 */
const GOALS = {
  map: { icon: '🗺', title: 'Map / track', text: 'The ground, the road and the surroundings as one environment to drive on or build around.' },
  objects: { icon: '🏠', title: 'Objects / props', text: 'Separate buildings, trees, signs, barriers… each its own object to move, texture and export alone.' },
};

const SOURCES = [
  {
    id: 'streetview', title: 'Street View photos → 3D mesh', goals: ['map', 'objects'],
    look: 'Real photo textures', accuracy: 'Medium (± 0.5–2 m)', needs: 'A route · Spirula · GPU', time: '20–90 min',
    steps: {
      map: ['Route tab: click along the road (or import a KML).', 'Section B: Make = “Map: the whole street”.', 'Press “Download Street View & build 3D”.', 'Jobs tab: wait; the mesh opens placed on the map.'],
      objects: ['Route tab: click along the road (or import a KML).', 'Section B: Make = “Objects: one per building”.', 'Press “Download Street View & build 3D”.', 'When it loads it is cut into one object per building (OpenStreetMap outlines).'],
    },
    go: (app, goal) => { app.streetview.sv.target = goal === 'map' ? 'track' : 'props'; app.streetview.buildUI(); return ['route', 'streetview']; },
  },
  {
    id: 'lidar', title: 'LiDAR scan (LAS / LAZ)', goals: ['map', 'objects'],
    look: 'Plain colours (photo colours if the scan has RGB)', accuracy: 'High (cm)', needs: 'A LiDAR file', time: 'Seconds–minutes, CPU only',
    steps: {
      map: ['Map data tab → LiDAR: Make = “Map: ground surface”.', 'Pick the coordinate system (Greece: EPSG:2100).', 'Choose the LAS/LAZ file.', 'The terrain mesh opens on the map (buildings and trees removed).'],
      objects: ['Map data tab → LiDAR: Make = “Objects: buildings + trees”.', 'Pick the coordinate system (Greece: EPSG:2100).', 'Choose the LAS/LAZ file.', 'Every building (outline + real roof height) and tree becomes its own object.'],
    },
    go: (app, goal) => { app.mapData.lidar.make = goal === 'map' ? 'map' : 'objects'; app.mapData.render(); return ['data', 'lidar']; },
  },
  {
    id: 'osm', title: 'OpenStreetMap + elevation (procedural)', goals: ['map', 'objects'],
    look: 'Clean, simple shapes', accuracy: 'Outline-level', needs: 'Just a route or map area', time: 'Seconds',
    steps: {
      map: ['Route tab: draw the route.', 'Section A: set width, kerbs, barriers; tick “Real terrain elevation”.', 'Press “Build 3D track”.', 'Optional: Map data → OSM roads / buildings around it.'],
      objects: ['Route tab: draw a route or move the map to the area.', 'Map data tab → OpenStreetMap: tick buildings, trees, street furniture.', 'Press “Import OSM around route”.', 'Each building / tree / lamp is a separate object (real heights when tagged).'],
    },
    go: (app, goal) => (goal === 'map' ? ['route', 'track'] : ['data', 'osm']),
  },
  {
    id: 'photos', title: 'My photos / video', goals: ['map', 'objects'],
    look: 'Real photo textures', accuracy: 'High if well shot', needs: 'Photos or a video · Spirula · GPU', time: '10–60 min',
    steps: {
      map: ['Capture tab → Full 3D.', 'What are you capturing = “A track / street”.', 'Drop the video (driving / walking along) or 50–300 photos.', 'Press “Upload & build 3D”.'],
      objects: ['Capture tab → Full 3D.', 'What are you capturing = “A prop / object”.', 'Walk around the object: 30–150 photos or a slow video.', 'Press “Upload & build 3D”; tidy it with Crop box / Simplify.'],
    },
    go: (app, goal) => { const c = app.capture; c.kind = 'scan'; c.opts.mode = goal === 'map' ? 'track' : 'prop'; c.render(); return ['capture', null]; },
  },
  {
    id: 'relief', title: 'One photo → 3D relief', goals: ['objects'],
    look: 'Photo texture, front side only', accuracy: 'Approximate', needs: 'One photo · GPU', time: '~1 min',
    steps: { objects: ['Capture tab → “1 photo → 3D”.', 'Drop the photo, choose how far to keep.', 'Press “Make 3D”. Good for facades, banners, walls, signs.'] },
    go: (app) => { app.capture.kind = 'relief'; app.capture.render(); return ['capture', null]; },
  },
  {
    id: 'ai', title: 'Photo → AI description → props', goals: ['objects'],
    look: 'Procedural props with estimated sizes', accuracy: 'Rough', needs: 'AI on (Settings → AI)', time: 'Seconds',
    steps: { objects: ['Capture tab → “AI describe”.', 'Drop one or more photos.', 'The AI lists the objects with sizes; press “Build props”.'] },
    go: (app) => { app.capture.kind = 'ai'; app.capture.render(); return ['capture', null]; },
  },
];

export class StartPanel {
  constructor(app) {
    this.app = app;
    this.goal = null;
    this.source = null;
    this.quick = { goal: 'map', osm: true, ground: true, streetview: true, lidarFiles: [] };
    this.root = el('div', { class: 'panel-body start' });
    this.render();
  }

  /** One click: use every free source for the current route, all in one map frame. */
  quickCard() {
    const q = this.quick;
    const sv = this.app.streetview;
    const hasRoute = sv.route.length > 1;
    const spirula = !!this.app.health?.spirula;
    const seg = el('div', { class: 'seg' }, ...[['map', '🗺 Map / track'], ['objects', '🏠 Objects / props']].map(([id, label]) => el('button', {
      class: q.goal === id ? 'active' : '', onclick: () => { q.goal = id; this.render(); },
    }, label)));
    return el('div', { class: 'quick' },
      el('div', { class: 'quick-head' }, el('strong', {}, '⚡ Everything for my route'),
        el('span', { class: 'muted small' }, 'Uses all free data at once')),
      el('div', { class: `route-status${hasRoute ? ' ok' : ''}` }, hasRoute
        ? `Route: ${fmtDistance(routeLength(sv.route))} — change it in Route & Street View`
        : el('span', {}, 'No route yet — ', el('button', { class: 'link', onclick: () => this.app.focusSection('route', null) }, 'draw one or search a street'))),
      seg,
      checkbox(q.goal === 'map' ? 'OpenStreetMap: buildings, trees, lamps, walls around it (instant)' : 'OpenStreetMap: each building, tree, lamp, wall as an object (instant)', q.osm, (v) => { q.osm = v; }),
      q.goal === 'map' ? checkbox('Road surface with real terrain elevation (instant)', q.ground, (v) => { q.ground = v; }) : null,
      checkbox(spirula ? 'Street View photos → real 3D (GPU, 20–90 min)' : 'Street View photos → real 3D (needs Spirula — see Settings)', q.streetview && spirula, (v) => { q.streetview = v; }),
      el('div', { class: 'button-row' },
        el('button', { class: 'small', onclick: async () => { q.lidarFiles = await pickFiles({ accept: '.las,.laz,.ply', multiple: true }); this.render(); } },
          q.lidarFiles.length ? `LiDAR: ${q.lidarFiles.map((f) => f.name).join(', ')}` : '+ LiDAR file (optional)'),
        q.lidarFiles.length ? el('button', { class: 'icon', onclick: () => { q.lidarFiles = []; this.render(); } }, '×') : null),
      el('button', { class: 'primary wide', disabled: !hasRoute, onclick: () => this.buildAll() }, 'Build everything'),
      el('p', { class: 'hint' }, 'Instant parts appear right away; Street View and LiDAR run as jobs and drop into the same place when ready.'));
  }

  async buildAll() {
    const q = this.quick;
    const { app } = this;
    const done = [];
    try {
      if (q.goal === 'map' && q.ground) { await app.streetview.buildTrack(); done.push('road + terrain'); }
      if (q.osm) {
        const layers = { buildings: true, roads: q.goal === 'map' && !q.ground, trees: true, furniture: true, barriers: true };
        await app.mapData.importOSM(layers);
        done.push('OpenStreetMap');
      }
      if (q.lidarFiles.length) {
        await app.mapData.importLidar(q.lidarFiles, { make: q.goal === 'map' ? 'both' : 'objects', stay: true });
        done.push('LiDAR job');
      }
      if (q.streetview && app.health?.spirula) {
        await app.streetview.startStreetView({ target: q.goal === 'map' ? 'track' : 'props', stay: true });
        done.push('Street View job');
      }
      toast(done.length ? `Started: ${done.join(' · ')}` : 'Nothing selected');
      if (done.some((d) => d.endsWith('job'))) app.jobs.refresh();
    } catch (e) { console.error(e); toast(e.message, 'error'); }
  }

  render() {
    const goalCards = Object.entries(GOALS).map(([id, g]) => el('button', {
      class: `choice${this.goal === id ? ' active' : ''}`, onclick: () => { this.goal = id; if (this.source && !SOURCES.find((s) => s.id === this.source).goals.includes(id)) this.source = null; this.render(); },
    }, el('span', { class: 'choice-icon' }, g.icon), el('strong', {}, g.title), el('span', {}, g.text)));

    const parts = [
      this.quickCard(),
      el('div', { class: 'or-line' }, '— or pick one source yourself —'),
      el('div', { class: 'step-title' }, el('span', { class: 'step-no' }, '1'), 'What do you want to make?'),
      el('div', { class: 'choices two' }, ...goalCards),
    ];
    if (this.goal) {
      parts.push(el('div', { class: 'step-title' }, el('span', { class: 'step-no' }, '2'), 'From what?'));
      parts.push(el('div', { class: 'sources' }, ...SOURCES.filter((s) => s.goals.includes(this.goal)).map((s) => el('button', {
        class: `source-card${this.source === s.id ? ' active' : ''}`, onclick: () => { this.source = s.id; this.render(); },
      },
      el('strong', {}, s.title),
      el('div', { class: 'facts' },
        el('span', {}, el('em', {}, 'Look '), s.look),
        el('span', {}, el('em', {}, 'Accuracy '), s.accuracy),
        el('span', {}, el('em', {}, 'Needs '), s.needs),
        el('span', {}, el('em', {}, 'Time '), s.time))))));
    }
    const src = SOURCES.find((s) => s.id === this.source);
    if (this.goal && src) {
      parts.push(el('div', { class: 'step-title' }, el('span', { class: 'step-no' }, '3'), 'Do this'));
      parts.push(el('ol', { class: 'recipe' }, ...src.steps[this.goal].map((t) => el('li', {}, t))));
      parts.push(el('button', { class: 'primary wide', onclick: () => { const [tab, section] = src.go(this.app, this.goal); this.app.focusSection(tab, section); } }, 'Take me there →'));
    }
    parts.push(el('details', { class: 'section tips' },
      el('summary', {}, 'Which source is better?'),
      el('ul', { class: 'plain' },
        el('li', {}, el('strong', {}, 'LiDAR'), ' gives the most accurate shapes and heights, fast and without a GPU, but no photo look (unless the scan is coloured).'),
        el('li', {}, el('strong', {}, 'Street View / photos'), ' give the real look (textures) but softer, less exact geometry and need the GPU for a while.'),
        el('li', {}, el('strong', {}, 'OpenStreetMap'), ' is instant and clean, good as a base or where there is no imagery.'),
        el('li', {}, el('strong', {}, 'Best of both: '), 'build the Street View model, then press “Align with LiDAR” on its job (Jobs tab) to snap it onto the scan.'))),
    el('button', { class: 'link', onclick: () => this.app.openManual() }, '📖 Open the full manual (Ελληνικά)'));
    this.root.replaceChildren(...parts);
  }
}
