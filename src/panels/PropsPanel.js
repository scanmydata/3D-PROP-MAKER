import { el, field, toast, pickFiles } from '../ui/dom.js';
import { PROP_LIBRARY, banner } from '../generators/props.js';
import { textureFromFile } from '../materials.js';

const BANNER_PRESETS = {
  Clean: { wrinkleStrength: 0.015, wrinkleFrequency: 4, wrinkleCount: 4, sagAmount: 0.035, windAmount: 0.01 },
  'Track used': { wrinkleStrength: 0.035, wrinkleFrequency: 7, wrinkleCount: 9, sagAmount: 0.08, windAmount: 0.025 },
  Stormy: { wrinkleStrength: 0.065, wrinkleFrequency: 12, wrinkleCount: 22, sagAmount: 0.15, windAmount: 0.06 },
};

/** Procedural props library: click to place in front of the camera target. */
export class PropsPanel {
  constructor(app) {
    this.app = app;
    this.bannerOpts = { ...BANNER_PRESETS['Track used'], seed: 12345 };
    this.bannerTexture = null;
    this.root = el('div', { class: 'panel-body' });
    this.render();
  }

  place(obj) {
    const ed = this.app.editor;
    const target = ed.viewport.orbit.target;
    obj.position.set(target.x, 0, target.z);
    // If a track is selected, drop the prop at its height.
    ed.addObject(obj);
  }

  render() {
    const b = this.bannerOpts;
    const slider = (label, key, min, max, step) => field(label, el('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(b[key]),
      oninput: (e) => { b[key] = Number(e.target.value); },
    }));
    this.root.replaceChildren(
      el('p', { class: 'intro' }, 'Real-scale racing props. Click to add at the viewport centre, then move them with the gizmo.'),
      el('div', { class: 'prop-grid' }, ...PROP_LIBRARY.filter((p) => p.id !== 'banner').map((p) => el('button', {
        class: 'prop-card', onclick: () => { this.place(p.make()); toast(`${p.name} added`); },
      }, el('strong', {}, p.name), el('span', {}, p.desc)))),
      el('details', { class: 'section', open: true },
        el('summary', {}, 'PVC Banner'),
        el('div', { class: 'button-row' }, ...Object.entries(BANNER_PRESETS).map(([name, preset]) => el('button', {
          class: 'small', onclick: () => { Object.assign(b, preset); this.render(); },
        }, name))),
        slider('Wrinkle strength', 'wrinkleStrength', 0, 0.09, 0.001),
        slider('Wrinkle frequency', 'wrinkleFrequency', 1, 18, 0.1),
        slider('Wrinkle count', 'wrinkleCount', 1, 35, 1),
        slider('Sag', 'sagAmount', 0, 0.22, 0.001),
        slider('Wind', 'windAmount', 0, 0.09, 0.001),
        el('div', { class: 'button-row' },
          el('button', {
            class: 'small', onclick: async () => {
              const [file] = await pickFiles({ accept: 'image/png,image/jpeg' });
              if (!file) return;
              try { this.bannerTexture = await textureFromFile(file); this.bannerName = file.name; this.render(); } catch (e) { toast(e.message, 'error'); }
            },
          }, this.bannerTexture ? `Artwork: ${this.bannerName}` : 'Artwork (PNG/JPG)…'),
          this.bannerTexture ? el('button', { class: 'small', onclick: () => { this.bannerTexture = null; this.render(); } }, '×') : null),
        el('button', {
          class: 'primary wide', onclick: () => {
            b.seed = Math.floor(Math.random() * 999999);
            this.place(banner({ ...b, texture: this.bannerTexture }));
          },
        }, 'Add banner')),
    );
  }
}
