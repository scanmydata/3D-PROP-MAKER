// Start the Python backend (FastAPI) from the project's virtualenv.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const py = process.platform === 'win32' ? join(root, 'server', '.venv', 'Scripts', 'python.exe') : join(root, 'server', '.venv', 'bin', 'python');
if (!existsSync(py)) {
  console.error('Python environment missing. Run:  npm run setup');
  process.exit(1);
}
const port = process.env.API_PORT || '8765';
const child = spawn(py, ['-m', 'uvicorn', 'app:app', '--app-dir', join(root, 'server'), '--host', '127.0.0.1', '--port', port], { stdio: 'inherit', cwd: root });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
