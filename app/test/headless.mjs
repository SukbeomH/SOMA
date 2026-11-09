// Real Node server + Python CAD + PTY; no Electron, browser driver or display.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-headless-'));
const origin = 'http://127.0.0.1:18766';
const env = { ...process.env, SOMA_USER_DATA: data, SOMA_WEB_PORT: '18766', SOMA_CONTAINER: '0', SHELL: '/bin/bash' };
const bin = path.join(data, 'bin'); await fs.mkdir(bin);
// Only the external Codex executable is substituted; the actual PTY and server run.
await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nprintf "CODEX_TEST_ARGS:%s\\n" "$*"\nprintf "CODEX_TEST_CWD:%s\\n" "$PWD"\n', { mode: 0o755 });
await fs.symlink(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
env.LOCAL_GIT_DIRECTORY = data;
env.PATH = bin + path.delimiter + env.PATH;
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
  console.log('Checking model and transfer endpoints');
  await rpc('project:create');
  await until(async () => (await rpc('build:status')).state === 'ok', 'first CAD build');
  const info = await rpc('project:current');
  const upload = (name, body, extra = {}) => fetch(origin + '/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await upload('../escape.txt', 'bad')).status, 400);
  assert.equal((await upload('test.txt', 'bad', { Origin: 'https://evil.example' })).status, 403);
  console.log('Checking oversized upload');
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/upload?name=large.bin', { method: 'POST', headers: { ...headers, 'Content-Length': String(100 * 1024 * 1024 + 1) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('oversize response timeout'))); req.end();
  });
  assert.equal(oversized, 400);
  console.log('Checking upload/import');
  const bytes = Buffer.from('Uploaded fixture — 한글\n');
  const uploaded = await (await upload('fixture.txt', bytes)).json();
  const duplicate = await (await upload('fixture.txt', 'second')).json();
  assert.notEqual(uploaded.path, duplicate.path);
  assert.deepEqual(await fs.readFile(uploaded.path), bytes);
  const opening = rpc('fs:importPick');
  const picker = await until(() => events.find(e => e.channel === 'web:path'), 'upload picker');
  await rpc('web:pathResult', picker.args[0], uploaded.path);
  await opening;
  assert.equal(await rpc('fs:readText', 'inputs/fixture.txt'), bytes.toString());
  const source = await rpc('fs:readText', 'model.py');
  const before = await rpc('fs:readBinary', '.soma/model.glb');
  assert.ok(before.__binary.length > 100);
  const terminal = await rpc('term:create');
  await rpc('term:write', terminal, "printf 'HEADLESS_PTY_OK\\n'\r");
  await until(() => events.some(e => e.channel === 'term:data' && String(e.args[1]).includes('HEADLESS_PTY_OK')), 'PTY output');
  console.log('Checking clipboard image attachment boundaries');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const stage = async bytes => (await (await upload('clipboard.png', bytes)).json()).path;
  const staged = await stage(png);
  const attached = await rpc('web:attachImage', info.id, terminal, staged);
  assert.equal(path.dirname(attached), path.join(info.dir, 'inputs'));
  assert.deepEqual(await fs.readFile(attached), png);
  const rejected = async (...args) => {
    const response = await fetch(origin + '/rpc', { method: 'POST', headers, body: JSON.stringify({ channel: 'web:attachImage', args }) });
    assert.equal(response.status, 500); return response.json();
  };
  const wrongTarget = await stage(png);
  assert.match((await rejected('different-project', terminal, wrongTarget)).error, /changed/);
  assert.match((await rejected(info.id, -1, wrongTarget)).error, /changed/);
  assert.match((await rejected(info.id, terminal, path.join(info.dir, 'model.py'))).error, /upload path/);
  assert.match((await rejected(info.id, terminal, await stage(Buffer.from('not PNG')))).error, /not a PNG/);
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
  assert.match((await rejected(info.id, terminal, await stage(huge))).error, /megapixels/);
  console.log('Checking rebuild/failure');
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
  console.log('Checking exports/downloads');
  for (const format of ['step', 'stl']) {
    const offset = events.length;
    const exporting = rpc('build:export', format, 'Lid', null);
    const request = await until(() => events.slice(offset).find(e => e.channel === 'web:path'), 'web save dialog');
    const file = path.join(data, 'exports', `Lid.${format}`);
    await rpc('web:pathResult', request.args[0], file);
    const result = await exporting;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok((await fs.stat(file)).size > 100);
    const notice = await until(() => events.slice(offset).find(e => e.channel === 'web:downloads'), 'download links');
    const link = notice.args[0][0];
    assert.equal((await fetch(origin + link.url)).status, 403);
    const response = await fetch(origin + link.url, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(file));
  }
  console.log('Checking editable source and archive downloads');
  for (const channel of ['project:exportCadQuery', 'project:exportZip', 'project:save']) {
    const offset = events.length;
    const exporting = rpc(channel);
    {
      const request = await until(() => events.slice(offset).find(e => e.channel === 'web:path'), channel + ' save dialog');
      await rpc('web:pathResult', request.args[0], channel === 'project:save' ? 'proof.soma' : channel === 'project:exportCadQuery' ? 'proof.py' : 'proof.zip');
    }
    const result = await exporting;
    assert.ok(!result.error && result.ok !== false && !result.cancelled, JSON.stringify(result));
    const notice = await until(() => events.slice(offset).find(e => e.channel === 'web:downloads'), channel + ' links');
    assert.ok(notice.args[0].length);
    for (const link of notice.args[0]) {
      const response = await fetch(origin + link.url, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, link.size);
      if (/\.(zip|soma)$/.test(link.name)) assert.equal(body.subarray(0, 2).toString(), 'PK');
      if (link.name.endsWith('.py')) assert.match(body.toString(), /cadquery/);
    }
  }
  console.log('Checking browser render failure and recovery boundaries');
  const renderOffset = events.length;
  const rendering = rpc('web:still', null);
  const jobEvent = await until(() => events.slice(renderOffset).find(e => e.channel === 'web:render'), 'browser render job');
  const job = jobEvent.args[0];
  assert.match(job.model, /^\/download\/[a-f0-9]{48}$/);
  assert.equal((await fetch(origin + job.model, { headers: { Cookie: cookie } })).status, 200);
  const busy = await rpc('web:still', null); assert.equal(busy.ok, false); assert.match(busy.error, /Another render/);
  await rpc('web:renderDone', job.id, { error: 'Render cancelled.' });
  const cancelled = await rendering; assert.equal(cancelled.ok, false); assert.match(cancelled.error, /cancelled/);
  assert.equal((await rpc('web:fem', '../outside.py')).ok, false);
  console.log('Checking resume');
  const codex = await rpc('term:create', { command: 'codex --no-alt-screen' });
  await until(() => events.some(e => e.channel === 'term:data' && String(e.args[1]).includes('CODEX_TEST_ARGS:--no-alt-screen')), 'Codex command through PTY');
  await rpc('term:kill', codex);
  const resumeOffset = events.length;
  await rpc('project:open', info.id);
  const resumed = await rpc('term:create', { restore: true });
  await until(() => events.slice(resumeOffset).some(e => e.channel === 'term:data' && String(e.args[1]).includes('CODEX_TEST_ARGS:resume --last --no-alt-screen')), 'persisted project resume');
  await rpc('term:kill', resumed);
  const unsupported = await rpc('render:video', 'missing'); assert.equal(unsupported.ok, false);
  await rpc('term:kill', terminal);
  const disconnectOffset = events.length;
  const interruptedRender = rpc('web:still', null);
  await until(() => events.slice(disconnectOffset).some(e => e.channel === 'web:render'), 'render before disconnect');
  abort.abort(); await reading;
  const interrupted = await interruptedRender;
  assert.equal(interrupted.ok, false); assert.match(interrupted.error, /disconnected/);
  console.log('PASS: real Node startup without DISPLAY; CAD build/rebuild/failure/recovery; binary mesh; PTY; uploads (bytes, duplicates, traversal, size, origin); STEP/STL downloads; persisted Codex resume dispatch');
} finally {
  abort.abort(); child.kill('SIGTERM');
  const stopped = await Promise.race([ended.then(() => true), delay(10000).then(() => false)]);
  if (!stopped) { child.kill('SIGKILL'); await ended; }
  await fs.rm(data, { recursive: true, force: true });
}
