// Real Node server + Python CAD + PTY; no Electron, browser driver or display.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-headless-'));
const origin = 'http://127.0.0.1:18766';
const env = { ...process.env, SOMA_USER_DATA: data, SOMA_WEB_PORT: '18766', SOMA_CONTAINER: '0', SHELL: '/bin/bash' };
delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
const child = spawn(process.execPath, ['dist/web/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
const ended = new Promise(resolve => child.once('exit', resolve));
const abort = new AbortController();
const events = [];
async function until(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}\n${output.slice(-3000)}`);
}
try {
  await until(() => output.includes('[soma-web]'), 'Node server startup');
  const home = await fetch(origin); const cookie = home.headers.get('set-cookie').split(';')[0];
  const client = 'headless-integration-12345';
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Soma-Web': '1', 'X-Soma-Client': client };
  const stream = await fetch(origin + '/events?client=' + client, { headers, signal: abort.signal });
  const reading = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for await (const chunk of stream.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const item = pending.slice(0, end); pending = pending.slice(end + 2);
        if (item.startsWith('data: ')) events.push(JSON.parse(item.slice(6)));
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
  async function rpc(channel, ...args) {
    const res = await fetch(origin + '/rpc', { method: 'POST', headers, body: JSON.stringify({ channel, args }) });
    const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result.value;
  }
  await rpc('project:create');
  await until(async () => (await rpc('build:status')).state === 'ok', 'first CAD build');
  const info = await rpc('project:current');
  const source = await rpc('fs:readText', 'model.py');
  const before = await rpc('fs:readBinary', '.soma/model.glb');
  assert.ok(before.__binary.length > 100);
  const terminal = await rpc('term:create');
  await rpc('term:write', terminal, "printf 'HEADLESS_PTY_OK\\n'\r");
  await until(() => events.some(e => e.channel === 'term:data' && String(e.args[1]).includes('HEADLESS_PTY_OK')), 'PTY output');
  const changed = source + '\n# headless integration rebuild\n';
  await rpc('fs:writeText', info.id, 'model.py', changed, source);
  await rpc('build:run');
  await until(async () => (await rpc('build:status')).state === 'ok', 'changed CAD build');
  const lastGood = await rpc('fs:readBinary', '.soma/model.glb');
  const broken = changed + '\nraise RuntimeError("HEADLESS_FAILURE_TEST")\n';
  await rpc('fs:writeText', info.id, 'model.py', broken, changed);
  await rpc('build:run');
  await until(async () => (await rpc('build:status')).state === 'error', 'failed CAD build');
  assert.deepEqual(await rpc('fs:readBinary', '.soma/model.glb'), lastGood, 'failed build retains previous mesh with error status');
  await rpc('fs:writeText', info.id, 'model.py', source, broken);
  await rpc('build:run');
  await until(async () => (await rpc('build:status')).state === 'ok', 'restored CAD build');
  for (const format of ['step', 'stl']) {
    const offset = events.length;
    const exporting = rpc('build:export', format, 'Lid', null);
    const request = await until(() => events.slice(offset).find(e => e.channel === 'web:path'), 'web save dialog');
    const file = path.join(data, 'exports', `Lid.${format}`);
    await rpc('web:pathResult', request.args[0], file);
    const result = await exporting;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok((await fs.stat(file)).size > 100);
  }
  const unsupported = await rpc('render:video', 'missing'); assert.equal(unsupported.ok, false);
  await rpc('term:kill', terminal);
  abort.abort(); await reading;
  console.log('PASS: real Node startup without DISPLAY; CAD build/rebuild/failure/recovery; binary mesh; PTY; browser save dialogs; STEP/STL exports');
} finally {
  abort.abort(); child.kill('SIGTERM');
  const stopped = await Promise.race([ended.then(() => true), delay(10000).then(() => false)]);
  if (!stopped) { child.kill('SIGKILL'); await ended; }
  await fs.rm(data, { recursive: true, force: true });
}
