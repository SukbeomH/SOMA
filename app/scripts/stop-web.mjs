import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const data = process.env.SOMA_USER_DATA || path.join(path.dirname(app), '.soma-web');
const file = path.join(data, 'web.pid');
if (!fs.existsSync(file)) { console.log('No SOMA web process recorded.'); process.exit(0); }
const pid = Number(fs.readFileSync(file, 'utf8'));
if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid SOMA process ID.');
let command;
try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
catch { fs.rmSync(file); console.log('SOMA web is already stopped.'); process.exit(0); }
if (command !== `${process.execPath} ${path.join(app, 'dist', 'web', 'server.js')}`) throw new Error('Process identity changed; refusing to stop a different process.');
process.kill(pid, 'SIGTERM');
console.log('SOMA web shutdown requested. Model files are kept.');
