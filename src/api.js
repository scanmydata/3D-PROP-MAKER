/** Backend API client (FastAPI server proxied by Vite at /api). */

async function req(method, path, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Backend not reachable. Start it with "npm run server" (or "npm start").');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail?.[0]?.msg || j.detail || msg; } catch { /* not json */ }
    if (res.status === 502 || res.status === 504) msg = 'Backend not reachable. Start it with "npm run server".';
    throw new Error(msg);
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

export const api = {
  health: () => req('GET', '/health'),
  settings: () => req('GET', '/settings'),
  saveSettings: (s) => req('POST', '/settings', s),
  jobs: () => req('GET', '/jobs'),
  job: (id, log = 300) => req('GET', `/jobs/${id}?log=${log}`),
  cancel: (id) => req('POST', `/jobs/${id}/cancel`),
  rerun: (id) => req('POST', `/jobs/${id}/rerun`),
  remove: (id) => req('DELETE', `/jobs/${id}`),
  streetviewMeta: (id) => req('GET', `/jobs/${id}/streetview`),
  fileUrl: (id, path) => `/api/jobs/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
  createMediaJob: (form) => req('POST', '/jobs/media', form, true),
  createStreetViewJob: (body) => req('POST', '/jobs/streetview', body),
  createPhoto3dJob: (form) => req('POST', '/jobs/photo3d', form, true),
  createPointCloudJob: (form) => req('POST', '/jobs/pointcloud', form, true),
  createLidarAlignJob: (id, form) => req('POST', `/jobs/${id}/lidar`, form, true),
  lidarSources: () => req('GET', '/lidar/sources'),
  resources: () => req('GET', '/resources'),
  aiModels: (provider) => req('GET', `/ai/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
  aiTest: () => req('POST', '/ai/test'),
  aiDescribe: (form) => req('POST', '/ai/describe', form, true),
  json: async (id, path) => (await fetch(`/api/jobs/${id}/files/${path}`)).json(),
};
