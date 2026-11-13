// Create server/.venv and install the backend's Python packages.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const venv = join(root, 'server', '.venv');
const win = process.platform === 'win32';
const py = win ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  return r.status === 0;
}

if (!existsSync(py)) {
  // Windows: the "py" launcher; elsewhere python3.
  const ok = win ? run('py', ['-3', '-m', 'venv', venv]) || run('python', ['-m', 'venv', venv]) : run('python3', ['-m', 'venv', venv]);
  if (!ok) { console.error('Could not create a Python virtualenv. Install Python 3.10+ from python.org'); process.exit(1); }
}
mkdirSync(join(root, 'server', 'models'), { recursive: true });
if (!run(py, ['-m', 'pip', 'install', '--upgrade', 'pip']) || !run(py, ['-m', 'pip', 'install', '-r', join(root, 'server', 'requirements.txt')])) {
  process.exit(1);
}
// Fetch the YOLO segmentation weights once (6 MB) so car/people masking works offline.
spawnSync(py, ['-c', "from ultralytics import YOLO; YOLO('yolo11n-seg.pt')"], { stdio: 'inherit', cwd: join(root, 'server', 'models') });
console.log('\nBackend ready. Start everything with:  npm start');
