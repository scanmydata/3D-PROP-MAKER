const CONTROL_DEFS = [
  ['wrinkleStrength', 'Wrinkle Strength', 0, 0.09, 0.001, 0.035],
  ['wrinkleFrequency', 'Wrinkle Frequency', 1, 18, 0.1, 7],
  ['wrinkleCount', 'Wrinkle Count', 1, 35, 1, 9],
  ['sagAmount', 'Sag Amount', 0, 0.22, 0.001, 0.08],
  ['windAmount', 'Wind Amount', 0, 0.09, 0.001, 0.025],
  ['seed', 'Random Seed', 1, 999999, 1, 12345],
];

function control([id, label, min, max, step, value]) {
  return `<div class="control"><div class="control-row"><label for="${id}">${label}</label><span data-value-for="${id}">${value}</span></div><input id="${id}" data-control="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
}

export function createUI(root, handlers) {
  root.innerHTML = `<div class="app-shell"><aside class="panel left-panel"><div class="brand"><div class="brand-mark">TP</div><div><h1>Track Props Generator</h1><p>Procedural racing simulator assets</p></div></div><div class="category"><h2>Banners</h2><button class="asset-btn active">PVC Banner <span class="badge">Live</span></button></div>${['Safety','Track Equipment','Buildings','Nature'].map((cat)=>`<div class="category"><h2>${cat}</h2>${placeholders(cat)}</div>`).join('')}</aside><main class="viewport" id="viewport"><div class="status" id="status">Ready. Generate unique PVC wrinkles or upload artwork.</div></main><aside class="panel right-panel"><div class="section"><h2>PVC Banner Properties</h2>${CONTROL_DEFS.map(control).join('')}</div><div class="section"><h2>Texture System</h2><div class="control"><input id="textureUpload" type="file" accept="image/png,image/jpeg"></div><p class="hint">Uploaded PNG/JPG artwork is assigned to the front material only. The back remains white PVC.</p></div><div class="section"><h2>Actions</h2><div class="button-grid"><button class="secondary" id="generateBtn">Generate</button><button class="secondary" id="randomizeBtn">Randomize</button><button class="primary wide" id="exportBtn">Export GLB</button></div></div><div class="section"><h2>Asset Metrics</h2><div class="metric"><span>Width</span><strong>2.0 m</strong></div><div class="metric"><span>Height</span><strong>1.30 m</strong></div><div class="metric"><span>Thickness</span><strong>0.002 m</strong></div><div class="metric"><span>Subdivisions</span><strong>120 × 80</strong></div></div></aside></div>`;
  const getSettings = () => Object.fromEntries(CONTROL_DEFS.map(([id]) => [id, Number(root.querySelector(`#${id}`).value)]));
  root.querySelectorAll('[data-control]').forEach((input) => input.addEventListener('input', () => { root.querySelector(`[data-value-for="${input.id}"]`).textContent = input.value; }));
  root.querySelector('#generateBtn').addEventListener('click', () => handlers.onGenerate(getSettings()));
  root.querySelector('#randomizeBtn').addEventListener('click', () => { root.querySelector('#seed').value = Math.floor(Math.random() * 999999); root.querySelectorAll('[data-control]').forEach((i) => root.querySelector(`[data-value-for="${i.id}"]`).textContent = i.value); handlers.onGenerate(getSettings()); });
  root.querySelector('#exportBtn').addEventListener('click', handlers.onExport);
  root.querySelector('#textureUpload').addEventListener('change', (event) => handlers.onTexture(event.target.files?.[0], getSettings()));
  return { viewport: root.querySelector('#viewport'), setStatus: (msg) => { root.querySelector('#status').textContent = msg; }, getSettings };
}
function placeholders(cat) { const map = { Safety:['Tire Wall','Armco Barrier','Cone'], 'Track Equipment':['Flag','Tent'], Buildings:['Pit Building'], Nature:['Tree'] }; return map[cat].map((name)=>`<button class="asset-btn disabled">${name}<span>Soon</span></button>`).join(''); }
