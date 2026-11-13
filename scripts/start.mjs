// One command: backend + Vite dev server. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const procs = [
  spawn(process.execPath, [join(root, 'scripts', 'run-server.mjs')], { stdio: 'inherit', cwd: root }),
  spawn('npm', ['run', 'dev'], { stdio: 'inherit', cwd: root, shell }),
];
const stop = () => procs.forEach((p) => { try { p.kill(); } catch { /* already gone */ } });
procs.forEach((p) => p.on('exit', () => { stop(); process.exit(0); }));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
