const CONTROL_DEFS = [
  { id: 'wrinkleStrength', label: 'Wrinkle Strength', min: 0, max: 0.09, step: 0.001, value: 0.035, unit: 'm' },
  { id: 'wrinkleFrequency', label: 'Wrinkle Frequency', min: 1, max: 18, step: 0.1, value: 7, unit: 'x' },
  { id: 'wrinkleCount', label: 'Wrinkle Count', min: 1, max: 35, step: 1, value: 9, unit: '' },
  { id: 'sagAmount', label: 'Sag Amount', min: 0, max: 0.22, step: 0.001, value: 0.08, unit: 'm' },
  { id: 'windAmount', label: 'Wind Amount', min: 0, max: 0.09, step: 0.001, value: 0.025, unit: 'm' },
  { id: 'seed', label: 'Random Seed', min: 1, max: 999999, step: 1, value: 12345, unit: '' },
];

const PRESETS = {
  clean: { wrinkleStrength: 0.015, wrinkleFrequency: 4, wrinkleCount: 4, sagAmount: 0.035, windAmount: 0.01 },
  track: { wrinkleStrength: 0.035, wrinkleFrequency: 7, wrinkleCount: 9, sagAmount: 0.08, windAmount: 0.025 },
  storm: { wrinkleStrength: 0.065, wrinkleFrequency: 12, wrinkleCount: 22, sagAmount: 0.15, windAmount: 0.06 },
};

function valueLabel(def, value = def.value) {
  const normalized = Number(value).toFixed(def.step < 1 ? 3 : 0).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${normalized}${def.unit ? ` ${def.unit}` : ''}`;
}

function control(def) {
  return `
    <div class="control">
      <div class="control-row">
        <label for="${def.id}">${def.label}</label>
        <span data-value-for="${def.id}">${valueLabel(def)}</span>
      </div>
      <input id="${def.id}" data-control="${def.id}" type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${def.value}">
    </div>`;
}

function placeholders(cat) {
  const map = {
    Safety: ['Tire Wall', 'Armco Barrier', 'Cone'],
    'Track Equipment': ['Flag', 'Tent'],
    Buildings: ['Pit Building'],
    Nature: ['Tree'],
  };
  return map[cat].map((name) => `<button class="asset-btn disabled" title="Coming in a future generator">${name}<span>Soon</span></button>`).join('');
}

export function createUI(root, handlers) {
  root.innerHTML = `
    <div class="app-shell">
      <aside class="panel left-panel">
        <div class="brand">
          <div class="brand-mark">TP</div>
          <div>
            <h1>Track Props Generator</h1>
            <p>Ready-to-export racing simulator props</p>
          </div>
        </div>

        <div class="quick-start">
          <h2>Quick Start</h2>
          <ol>
            <li>Choose <strong>PVC Banner</strong>.</li>
            <li>Use a preset or adjust sliders.</li>
            <li>Upload artwork if needed.</li>
            <li>Click <strong>Export GLB</strong>.</li>
          </ol>
        </div>

        <div class="category">
          <h2>Banners</h2>
          <button class="asset-btn active">PVC Banner <span class="badge">Live</span></button>
        </div>
        ${['Safety', 'Track Equipment', 'Buildings', 'Nature'].map((cat) => `
          <div class="category">
            <h2>${cat}</h2>
            ${placeholders(cat)}
          </div>`).join('')}
      </aside>

      <main class="viewport" id="viewport">
        <div class="welcome-card" id="welcomeCard">
          <strong>PVC Banner Generator</strong>
          <span>2.0 m × 1.30 m · real geometry wrinkles · GLB export</span>
        </div>
        <div class="status" id="status">Ready. Click Generate or Randomize to create a unique banner.</div>
      </main>

      <aside class="panel right-panel">
        <div class="section primary-actions">
          <h2>1. Create Banner</h2>
          <div class="preset-grid">
            <button class="secondary" data-preset="clean">Clean</button>
            <button class="secondary" data-preset="track">Track Used</button>
            <button class="secondary" data-preset="storm">Stormy</button>
          </div>
          <div class="button-grid">
            <button class="secondary" id="generateBtn">Generate</button>
            <button class="secondary" id="randomizeBtn">Randomize Seed</button>
          </div>
        </div>

        <details class="section" open>
          <summary>2. Fine Tune Wrinkles</summary>
          ${CONTROL_DEFS.map(control).join('')}
        </details>

        <div class="section">
          <h2>3. Add Artwork</h2>
          <label class="upload-box" for="textureUpload">
            <span>Upload PNG/JPG Logo or Advert</span>
            <small>Applied only to the front side</small>
          </label>
          <input id="textureUpload" class="sr-only" type="file" accept="image/png,image/jpeg">
          <p class="hint">Back side remains untextured white PVC for realistic banner material.</p>
        </div>

        <div class="section export-section">
          <h2>4. Export</h2>
          <button class="primary wide" id="exportBtn">Export GLB</button>
          <p class="hint">Exports geometry, UVs, normals, materials, embedded texture, and transforms at meter scale.</p>
        </div>

        <div class="section">
          <h2>Asset Metrics</h2>
          <div class="metric"><span>Width</span><strong>2.0 m</strong></div>
          <div class="metric"><span>Height</span><strong>1.30 m</strong></div>
          <div class="metric"><span>Thickness</span><strong>0.002 m</strong></div>
          <div class="metric"><span>Subdivisions</span><strong>120 × 80</strong></div>
        </div>
      </aside>
    </div>`;

  const byId = (id) => root.querySelector(`#${id}`);
  const getSettings = () => Object.fromEntries(CONTROL_DEFS.map(({ id }) => [id, Number(byId(id).value)]));
  const refreshLabels = () => CONTROL_DEFS.forEach((def) => {
    root.querySelector(`[data-value-for="${def.id}"]`).textContent = valueLabel(def, byId(def.id).value);
  });
  const applyPreset = (name) => {
    Object.entries(PRESETS[name]).forEach(([id, value]) => { byId(id).value = value; });
    refreshLabels();
    handlers.onGenerate(getSettings());
  };

  root.querySelectorAll('[data-control]').forEach((input) => input.addEventListener('input', refreshLabels));
  root.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  byId('generateBtn').addEventListener('click', () => handlers.onGenerate(getSettings()));
  byId('randomizeBtn').addEventListener('click', () => {
    byId('seed').value = Math.floor(Math.random() * 999999);
    refreshLabels();
    handlers.onGenerate(getSettings());
  });
  byId('exportBtn').addEventListener('click', handlers.onExport);
  byId('textureUpload').addEventListener('change', (event) => handlers.onTexture(event.target.files?.[0], getSettings()));

  refreshLabels();
  return { viewport: byId('viewport'), setStatus: (msg) => { byId('status').textContent = msg; }, getSettings };
}
