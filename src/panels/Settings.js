import { el, field, select, checkbox, toast } from '../ui/dom.js';
import { api } from '../api.js';

const RESOURCE_PRESETS = {
  balanced: { label: 'Balanced (default)', v: { max_gpu_jobs: 1, process_priority: 'below_normal', cpu_threads: 0, sfm_max_image_size: 0, train_resolution_divisor: 0, max_splats: 1000000, ai_local_during_gpu: 'wait' } },
  shared: { label: 'PC + local AI side by side', v: { max_gpu_jobs: 1, process_priority: 'idle', cpu_threads: -2, sfm_max_image_size: 2400, train_resolution_divisor: 2, max_splats: 500000, ai_local_during_gpu: 'wait' } },
  max: { label: 'Maximum speed (PC busy)', v: { max_gpu_jobs: 1, process_priority: 'normal', cpu_threads: 0, sfm_max_image_size: 0, train_resolution_divisor: 0, max_splats: 3000000, ai_local_during_gpu: 'allow' } },
  low: { label: 'Low memory (8–16 GB, integrated GPU)', v: { max_gpu_jobs: 1, process_priority: 'below_normal', cpu_threads: 0, sfm_max_image_size: 2000, train_resolution_divisor: 2, max_splats: 400000, ai_local_during_gpu: 'wait' } },
};

/** Settings: Spirula + keys (General), AI assistant, and how much of the PC each part may use. */
export async function openSettings(app, tab = 'general') {
  let health = null; let s = {}; let res = {};
  try { [health, s, res] = await Promise.all([api.health(), api.settings(), api.resources().catch(() => ({}))]); } catch (e) { health = { error: e.message }; }
  const changes = {};
  const set = (k, num) => (v) => { changes[k] = num ? Number(v) : v; };
  const status = (ok, text) => el('div', { class: `status-line ${ok ? 'ok' : 'bad'}` }, ok ? '✔ ' : '✖ ', text);
  const input = (k, attrs = {}) => el('input', { type: 'text', value: s[k] ?? '', oninput: (e) => { changes[k] = e.target.value; }, ...attrs });

  // ---------- General ----------
  const general = el('div', { class: 'tab-page' },
    health.error ? status(false, `Backend offline — run "npm run server". (${health.error})`) : el('div', {},
      status(true, `Backend running · workspace ${health.work_dir}`),
      status(!!health.spirula, health.spirula ? `Spirula Studio ${health.spirula_version}` : 'Spirula Studio not found — needed for photo/video/Street View → 3D'),
      status(health.yolo, health.yolo ? 'AI masking of cars / people ready (ultralytics YOLO11)' : 'AI masking unavailable — run: npm run setup')),
    field('Spirula Studio executable', input('spirula_bin', { placeholder: 'tools\\spirula\\spirula.exe is found automatically' }),
      el('span', {}, 'From ', el('a', { href: 'https://github.com/harry7557558/spirula-studio/releases', target: '_blank', rel: 'noopener' }, 'github.com/harry7557558/spirula-studio/releases'))),
    field('Google Maps API key (only for the official Static API source)', el('input', { type: 'password', placeholder: s.google_api_key_set ? '•••••• (saved)' : 'optional', oninput: (e) => { changes.google_api_key = e.target.value; } })));

  // ---------- AI ----------
  const providers = Object.entries(s.ai_providers || {}).map(([k, v]) => [k, v.label]);
  const modelSel = el('select', { onchange: (e) => { changes.ai_model = e.target.value; } }, el('option', { value: s.ai_model || '' }, s.ai_model || 'Automatic (first free vision model)'));
  const modelInfo = el('small', { class: 'hint' });
  const baseInput = input('ai_base_url', { placeholder: 'default for the provider' });
  const loadModels = async () => {
    modelInfo.textContent = 'Loading models…';
    try {
      const list = await api.aiModels(changes.ai_provider || s.ai_provider);
      const cur = changes.ai_model ?? s.ai_model ?? '';
      modelSel.replaceChildren(el('option', { value: '' }, 'Automatic (first free vision model / loaded model)'),
        ...list.map((m) => el('option', { value: m.id, selected: m.id === cur }, `${m.vision ? '👁 ' : ''}${m.name}${m.free === false ? '' : (m.vision === null ? '' : ' · free')}`)));
      modelInfo.textContent = `${list.length} model(s). 👁 = understands images (needed for photo description).`;
    } catch (e) { modelInfo.textContent = `${e.message}${(changes.ai_provider || s.ai_provider) !== 'openrouter' ? ' — is the local server running?' : ''}`; }
  };
  const ai = el('div', { class: 'tab-page' },
    checkbox('Use an AI assistant (describe photos, build props from photos)', !!s.ai_enabled, set('ai_enabled')),
    field('Provider', select(providers, s.ai_provider || 'openrouter', (v) => { changes.ai_provider = v; changes.ai_base_url = ''; baseInput.value = ''; loadModels(); })),
    field('OpenRouter API key', el('input', { type: 'password', placeholder: s.ai_api_key_set ? '•••••• (saved)' : 'sk-or-… (free account at openrouter.ai)', oninput: (e) => { changes.ai_api_key = e.target.value; } }),
      'Free models cost nothing but are rate-limited. Local servers need no key.'),
    field('Model', modelSel, modelInfo),
    el('div', { class: 'button-row' }, el('button', { class: 'small', onclick: loadModels }, 'Refresh models'),
      el('button', { class: 'small', onclick: async () => { await save(false); try { const r = await api.aiTest(); toast(`AI OK · ${r.model}`); } catch (e) { toast(e.message, 'error'); } } }, 'Save & test')),
    field('Server URL (local providers)', baseInput, 'LM Studio: http://127.0.0.1:1234/v1 · Ollama: http://127.0.0.1:11434/v1'),
    field('Answer language', select([['Greek', 'Ελληνικά'], ['English', 'English']], s.ai_language || 'Greek', set('ai_language'))),
    el('div', { class: 'notice small' }, el('strong', {}, 'Local model for this PC: '),
      'in LM Studio search “Qwen3-VL 4B” (Q4_K_M, ~3.3 GB) — reads photos well and leaves RAM for Spirula. If you only run it when not reconstructing, “Gemma 4 E4B” (~5–7 GB) is stronger. In LM Studio → Developer, start the server, load the model, then pick “LM Studio” here.'));

  // ---------- Resources ----------
  const gpus = res.gpus || [];
  const deviceSel = select([['auto', 'Automatic (first suitable GPU)'], ...gpus.map((g) => [g, g])], s.gpu_device || 'auto', set('gpu_device'));
  const resPage = el('div', { class: 'tab-page' },
    res.total_gb ? el('div', { class: 'muted small' }, `This PC: ${res.total_gb} GB RAM (${res.free_gb} GB free), ${res.cpu_threads} CPU threads, GPU(s): ${gpus.join(', ') || 'unknown'}. Integrated GPUs share the system RAM.`) : null,
    field('Preset', select([['', 'Choose…'], ...Object.entries(RESOURCE_PRESETS).map(([k, p]) => [k, p.label])], '', (v) => {
      if (!RESOURCE_PRESETS[v]) return;
      const vals = { ...RESOURCE_PRESETS[v].v };
      if (vals.cpu_threads < 0) vals.cpu_threads = Math.max(2, (res.cpu_threads || 8) + vals.cpu_threads);
      Object.assign(changes, vals);
      Object.entries(vals).forEach(([k, val]) => { const f = resPage.querySelector(`[data-k="${k}"]`); if (f) f.value = String(val); });
      toast(`${RESOURCE_PRESETS[v].label} — press Save`);
    })),
    field('GPU for reconstruction', deviceSel, 'Pick an external / second GPU (eGPU) here by name. Spirula uses Vulkan: NVIDIA, AMD, Intel.'),
    field('Reconstructions at the same time', num('max_gpu_jobs', s, changes, 1, 4, 1), 'Keep 1 on a single GPU; extra jobs wait their turn.'),
    field('Reconstruction priority', sel('process_priority', s, changes, [['normal', 'Normal'], ['below_normal', 'Below normal (PC stays responsive)'], ['idle', 'Idle (only when the PC is free)']])),
    field('CPU threads (0 = all)', num('cpu_threads', s, changes, 0, 128, 1)),
    field('Max image size for matching (0 = 3200 px)', num('sfm_max_image_size', s, changes, 0, 8000, 100), 'Lower = less RAM/VRAM in SfM.'),
    field('Training image size', sel('train_resolution_divisor', s, changes, [[0, 'Full size'], [2, 'Half (¼ the VRAM, faster)'], [4, 'Quarter (preview)']])),
    field('Max Gaussian splats', num('max_splats', s, changes, 100000, 10000000, 100000), 'Fewer = less VRAM, smaller files.'),
    field('Local AI while reconstructing', sel('ai_local_during_gpu', s, changes, [['wait', 'Wait until the GPU is free (recommended on one GPU)'], ['allow', 'Run at the same time (needs a 2nd GPU or lots of VRAM)']])),
    field('Frames from videos: longest side (px)', num('frames_max_side', s, changes, 960, 8000, 160)));

  const pages = { general, ai, resources: resPage };
  const tabs = el('div', { class: 'seg' }, ...Object.keys(pages).map((k) => el('button', {
    class: k === tab ? 'active' : '', onclick: (e) => { tab = k; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target)); Object.entries(pages).forEach(([n, p]) => p.classList.toggle('hidden', n !== k)); if (k === 'ai') loadModels(); },
  }, { general: 'General', ai: 'AI assistant', resources: 'Resources' }[k])));
  Object.entries(pages).forEach(([n, p]) => p.classList.toggle('hidden', n !== tab));

  async function save(close = true) {
    const body = { ...changes };
    if (body.cpu_threads !== undefined) body.cpu_threads = Number(body.cpu_threads);
    try {
      await api.saveSettings(body);
      Object.keys(changes).forEach((k) => delete changes[k]);
      if (close) { toast('Settings saved'); dlg.close(); }
      app.checkHealth();
    } catch (e) { toast(e.message, 'error'); throw e; }
  }

  const dlg = el('dialog', { class: 'dialog' }, el('h2', {}, 'Settings'), tabs, general, ai, resPage,
    el('div', { class: 'button-row end' },
      el('button', { class: 'small', onclick: () => dlg.close() }, 'Close'),
      el('button', { class: 'primary', onclick: () => save().catch(() => {}) }, 'Save')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  if (tab === 'ai') loadModels();
}

function num(k, s, changes, min, max, step) {
  return el('input', { type: 'number', 'data-k': k, min: String(min), max: String(max), step: String(step), value: String(s[k] ?? ''), onchange: (e) => { changes[k] = Number(e.target.value); } });
}
function sel(k, s, changes, options) {
  const node = select(options, s[k], (v) => { changes[k] = /^\d+$/.test(v) ? Number(v) : v; });
  node.dataset.k = k;
  return node;
}
