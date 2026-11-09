import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const root = path.dirname(app);
// node-pty's npm macOS prebuild ships this helper without its executable bit.
if (process.platform === 'darwin') {
  const helper = path.join(app, 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
}
const python = process.env.SOMA_PYTHON || path.join(root, '.venv', 'bin', 'python');
if (!fs.existsSync(python)) throw new Error(`Python environment missing: ${python}. See WEB_LOCAL.md.`);
const git = fs.realpathSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
const env = {
  ...process.env, SOMA_WEB: '1', SOMA_PYTHON: python,
  SOMA_USER_DATA: process.env.SOMA_USER_DATA || path.join(root, '.soma-web'),
  LOCAL_GIT_DIRECTORY: path.dirname(path.dirname(git)),
  GIT_EXEC_PATH: execFileSync(git, ['--exec-path'], { encoding: 'utf8' }).trim(),
};
// npm's launch prefix is not a user shell configuration (it conflicts with nvm).
delete env.npm_config_prefix;
fs.mkdirSync(env.SOMA_USER_DATA, { recursive: true });
const pidFile = path.join(env.SOMA_USER_DATA, 'web.pid');
if (fs.existsSync(pidFile)) {
  const previous = Number(fs.readFileSync(pidFile, 'utf8'));
  if (Number.isInteger(previous) && previous > 1) {
    try { process.kill(previous, 0); throw new Error('SOMA web is already running. Stop it with npm run stop:web first.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
const child = spawn(process.execPath, [path.join(app, 'dist', 'web', 'server.js')], { cwd: app, env, stdio: 'inherit' });
child.on('spawn', () => fs.writeFileSync(pidFile, String(child.pid)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') === String(child.pid)) fs.rmSync(pidFile);
  process.exitCode = code ?? 0;
});
