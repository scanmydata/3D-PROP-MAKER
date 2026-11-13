import * as THREE from 'three';
import { el, field, select, checkbox, toast, fmtBytes } from '../ui/dom.js';
import { api } from '../api.js';
import { propsFromDescription } from '../ai/aiProps.js';

const MODES = [
  ['scan', 'Full 3D', 'Many photos or a video → photogrammetry (Spirula)'],
  ['relief', '1 photo → 3D', 'Depth AI (local) → textured 3D relief of what the photo shows'],
  ['ai', 'AI describe', 'Vision AI describes the photo and builds matching props'],
];

const MEDIA_ACCEPT = 'image/*,video/*,.insv,.360,.mts,.mkv';
const isVideo = (f) => /^video\//.test(f.type) || /\.(insv|360|mts|mkv|mp4|mov)$/i.test(f.name);

/** Upload photos / videos (normal or 360°) and start a reconstruction job. */
export class CapturePanel {
  constructor(app) {
    this.app = app;
    this.files = [];
    this.opts = { title: '', mode: 'prop', camera: 'auto', quality: 'standard', output: 'both', frames: 180, mask_moving: true, mask_nadir: true };
    this.kind = 'scan';
    this.relief = { max_depth: 0, detail: 320 };
    this.aiPrompt = '';
    this.aiResult = null;
    this.root = el('div', { class: 'panel-body' });
    this.render();
  }

  render() {
    const o = this.opts;
    const set = (k) => (v) => { o[k] = v; };
    const drop = el('div', {
      class: 'dropzone',
      onclick: () => this.input.click(),
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); this.add([...e.dataTransfer.files]); },
    },
    el('strong', {}, 'Drop photos or videos here'),
    el('span', {}, 'JPG/PNG photos · MP4/MOV video · 360° equirectangular photos/videos (2:1) · .insv'));
    this.input = el('input', { type: 'file', multiple: true, accept: MEDIA_ACCEPT, class: 'sr-only', onchange: (e) => { this.add([...e.target.files]); e.target.value = ''; } });

    const total = this.files.reduce((s, f) => s + f.size, 0);
    const list = this.files.length ? el('div', { class: 'file-list' },
      ...this.files.slice(0, 50).map((f, i) => el('div', { class: 'file-row' },
        el('span', { class: 'file-name', title: f.name }, `${/^video|\.insv$|\.360$/i.test(f.type || f.name) ? '🎞' : '🖼'} ${f.name}`),
        el('span', { class: 'muted' }, fmtBytes(f.size)),
        el('button', { class: 'icon', title: 'Remove', onclick: () => { this.files.splice(i, 1); this.render(); } }, '×'))),
      this.files.length > 50 ? el('div', { class: 'muted' }, `… and ${this.files.length - 50} more`) : null,
      el('div', { class: 'file-total' }, `${this.files.length} file(s), ${fmtBytes(total)}`,
        el('button', { class: 'link', onclick: () => { this.files = []; this.render(); } }, 'clear'))) : null;

    const modeBar = el('div', { class: 'seg' }, ...MODES.map(([id, label, tip]) => el('button', {
      class: this.kind === id ? 'active' : '', title: tip, onclick: () => { this.kind = id; this.render(); },
    }, label)));
    const intro = el('p', { class: 'intro' }, `${MODES.find((m) => m[0] === this.kind)[2]}. The result opens in the editor.`);
    let body;
    if (this.kind === 'scan') {
      const tooFew = this.files.length && this.files.length < 3 && !this.files.some(isVideo);
      body = [
        field('What are you capturing?', select([['prop', 'A prop / object (walk around it)'], ['track', 'A track / street (drive or walk along it)']], o.mode, set('mode'))),
        field('Camera', select([['auto', 'Auto-detect (2:1 = 360°)'], ['perspective', 'Normal camera / phone / drone'], ['equirect', '360° camera (equirectangular)']], o.camera, set('camera'))),
        field('Quality', select([['preview', 'Preview — fast'], ['standard', 'Standard'], ['high', 'High — slow, more VRAM']], o.quality, set('quality'))),
        field('Output', select([['both', 'Textured mesh + Gaussian splat'], ['mesh', 'Textured mesh (GLB)'], ['splat', 'Gaussian splat only']], o.output, set('output'))),
        field('Frames taken from each video', el('input', { type: 'number', min: '20', max: '2000', step: '10', value: String(o.frames), onchange: (e) => { o.frames = Number(e.target.value); } }), 'Sharpest frame in each time slice is kept.'),
        checkbox('Hide moving cars / people from the 3D (AI masking, CPU)', o.mask_moving, set('mask_moving')),
        checkbox('Mask the bottom of 360° images (tripod / car)', o.mask_nadir, set('mask_nadir')),
        field('Job name', el('input', { type: 'text', placeholder: 'e.g. Pit wall banner', value: o.title, oninput: (e) => { o.title = e.target.value; } })),
        el('button', { class: 'primary wide', disabled: !this.files.length || tooFew, onclick: () => this.start() }, 'Upload & build 3D'),
        tooFew ? el('p', { class: 'hint' }, 'Photogrammetry needs at least 3 overlapping photos (20–200 is typical). For a single photo use “1 photo → 3D”.') : null,
      ];
    } else if (this.kind === 'relief') {
      body = [
        field('Keep only what is closer than', select([[0, 'Everything'], [3, '3 m (small prop)'], [8, '8 m (banner, car, wall)'], [25, '25 m (building)']], this.relief.max_depth, (v) => { this.relief.max_depth = Number(v); }), 'Cuts the far background off.'),
        field('Detail', select([[160, 'Low'], [320, 'Medium'], [640, 'High']], this.relief.detail, (v) => { this.relief.detail = Number(v); })),
        el('button', { class: 'primary wide', disabled: !this.images().length, onclick: () => this.startRelief() }, `Make 3D from ${this.images().length || ''} photo(s)`),
        el('p', { class: 'hint' }, 'Runs on your GPU with the depth model built into Spirula (first use downloads ~420 MB). You get the side the camera saw, at real scale — great for facades, banners, signs and walls.'),
      ];
    } else {
      const ai = this.app.health?.ai_enabled;
      body = [
        ai ? null : el('div', { class: 'notice' }, 'The AI assistant is off. ', el('button', { class: 'link', onclick: () => this.app.openSettings('ai') }, 'Set it up (free OpenRouter models or a local model)')),
        field('Extra instructions (optional)', el('textarea', { rows: 2, placeholder: 'e.g. Focus on the tyre barrier and the sponsor banner', oninput: (e) => { this.aiPrompt = e.target.value; } }, this.aiPrompt)),
        el('button', { class: 'primary wide ai-go', disabled: !this.images().length || !ai, onclick: () => this.describe() }, 'Describe with AI'),
        this.aiResult ? this.resultCard(this.aiResult) : null,
      ];
    }
    this.root.replaceChildren(modeBar, intro, drop, this.input, list, ...body.filter(Boolean),
      this.progress = el('div', { class: 'upload-progress hidden' }, el('div', { class: 'bar' }), el('span', {})));
  }

  images() { return this.files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)); }

  async startRelief() {
    const form = new FormData();
    this.images().forEach((f) => form.append('files', f, f.name));
    form.append('max_depth', String(this.relief.max_depth));
    form.append('detail', String(this.relief.detail));
    form.append('title', `Photo → 3D · ${this.images()[0].name}`);
    try {
      await api.createPhoto3dJob(form);
      toast('Building 3D from the photo — it opens when ready.');
      this.app.showTab('jobs');
      this.app.jobs.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async describe() {
    const form = new FormData();
    this.images().slice(0, 6).forEach((f) => form.append('files', f, f.name));
    form.append('prompt', this.aiPrompt);
    const btn = this.root.querySelector('.ai-go');
    btn.disabled = true;
    btn.textContent = 'Asking the AI… (local models can take a minute)';
    try {
      this.aiResult = await api.aiDescribe(form);
      this.aiPhoto = this.images()[0];
    } catch (e) { toast(e.message, 'error'); }
    this.render();
  }

  resultCard(r) {
    const rows = (r.objects || []).map((o) => el('tr', {},
      el('td', {}, o.name || o.category), el('td', { class: 'muted' }, o.category),
      el('td', {}, String(o.count ?? 1)),
      el('td', { class: 'muted' }, o.dimensions_m ? `${o.dimensions_m.width ?? '?'}×${o.dimensions_m.height ?? '?'}×${o.dimensions_m.depth ?? '?'} m` : '')));
    return el('div', { class: 'ai-card' },
      el('div', { class: 'insp-title' }, `AI · ${r.model || ''}`),
      el('p', {}, r.summary || ''),
      rows.length ? el('table', { class: 'ai-table' }, el('tr', {}, el('th', {}, 'Object'), el('th', {}, 'Type'), el('th', {}, '#'), el('th', {}, 'Size')), ...rows) : null,
      r.capture_advice ? el('p', { class: 'hint' }, `📷 ${r.capture_advice}`) : null,
      el('div', { class: 'button-row' },
        rows.length ? el('button', { class: 'small', onclick: () => this.buildProps(r) }, 'Build these props') : null,
        el('button', { class: 'small', onclick: () => navigator.clipboard?.writeText(JSON.stringify(r, null, 2)).then(() => toast('Copied')) }, 'Copy JSON')));
  }

  async buildProps(r) {
    let tex = null;
    if (this.aiPhoto) {
      tex = await new THREE.TextureLoader().loadAsync(URL.createObjectURL(this.aiPhoto));
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    const group = propsFromDescription(r, tex);
    const t = this.app.editor.viewport.orbit.target;
    group.position.set(t.x, 0, t.z);
    this.app.editor.addObject(group);
    this.app.editor.viewport.focus(group);
    toast(`${r.objects.length} prop type(s) built — adjust them with the gizmo`);
  }

  add(files) {
    const ok = files.filter((f) => /^(image|video)\//.test(f.type) || /\.(insv|360|mts|mkv|jpe?g|png|tiff?|mp4|mov)$/i.test(f.name));
    if (ok.length < files.length) toast(`${files.length - ok.length} unsupported file(s) skipped`, 'error');
    this.files.push(...ok);
    if (!this.opts.title && ok[0]) this.opts.title = ok[0].name.replace(/\.[^.]+$/, '');
    this.render();
  }

  start() {
    const form = new FormData();
    this.files.forEach((f) => form.append('files', f, f.name));
    Object.entries(this.opts).forEach(([k, v]) => form.append(k, String(k === 'title' ? v || 'Capture' : v)));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/jobs/media');
    this.progress.classList.remove('hidden');
    const bar = this.progress.querySelector('.bar'); const label = this.progress.querySelector('span');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bar.style.width = `${(e.loaded / e.total) * 100}%`;
      label.textContent = `Uploading ${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}`;
    };
    xhr.onload = () => {
      this.progress.classList.add('hidden');
      if (xhr.status >= 200 && xhr.status < 300) {
        toast('Job started — follow it in the Jobs tab.');
        this.files = []; this.opts.title = '';
        this.render();
        this.app.showTab('jobs');
        this.app.jobs.refresh();
      } else {
        let msg = `Upload failed (HTTP ${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch { /* ignore */ }
        if (xhr.status === 502 || xhr.status === 504 || xhr.status === 0) msg = 'Backend not reachable. Start it with "npm run server".';
        toast(msg, 'error');
      }
    };
    xhr.onerror = () => { this.progress.classList.add('hidden'); toast('Backend not reachable. Start it with "npm run server".', 'error'); };
    xhr.send(form);
  }
}
