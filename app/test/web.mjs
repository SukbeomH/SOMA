import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-web-test-'));
const port = 18765;
process.env.SOMA_WEB_PORT = String(port);
await build({ entryPoints: ['src/main/web.ts'], outfile: path.join(temp, 'web.cjs'), platform: 'node', format: 'cjs', bundle: true });
const { startWeb, stopWeb, webChannels, publishWeb } = createRequire(import.meta.url)(path.join(temp, 'web.cjs'));
await fs.writeFile(path.join(temp, 'index.html'), '<script src="main.js"></script>');
await fs.writeFile(path.join(temp, 'main.js'), '/* test asset */');
const calls = [];
webChannels.add('project:current');
webChannels.add('test:close');
const origin = await startWeb(async (channel, args) => { calls.push({channel, args}); return { ok: true }; }, temp);
const abort = new AbortController();
try {
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /web-preload.js/);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  assert.match(home.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(origin + '/main.js')).status, 403);
  assert.equal((await fetch(origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(await new Promise((resolve, reject) => { http.get(origin, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); }), 403);
  assert.equal((await fetch(origin + '/main.js', { headers: { Cookie: cookie } })).status, 200);
  const client = 'test-browser-123456789';
  const events = await fetch(origin + '/events?client=' + client, { headers: { Cookie: cookie }, signal: abort.signal });
  assert.equal(events.status, 200);
  assert.equal((await fetch(origin + '/events?client=another-browser-12345', { headers: { Cookie: cookie } })).status, 409);
  const rpc = (channel, extra = {}, args = []) => fetch(origin + '/rpc', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Soma-Web': '1', 'X-Soma-Client': client, ...extra }, body: JSON.stringify({ channel, args }) });
  assert.equal((await rpc('project:current', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc('project:current', { 'X-Soma-Client': 'another-browser-12345' })).status, 409);
  assert.equal((await rpc('unregistered')).status, 400);
  assert.equal((await rpc('test:close')).status, 400);
  assert.deepEqual(await (await rpc('project:current')).json(), { value: { ok: true } });
  const injection = '"});globalThis.INJECTED=true;//';
  assert.equal((await rpc('term:write', {}, [1, injection])).status, 200);
  assert.equal(calls.at(-1).args[1], injection);
  assert.equal(calls.length, 2);
  assert.equal((await fetch(origin + '/%2e%2e%2fpackage.json', { headers: { Cookie: cookie } })).status, 404);
  const reader = events.body.getReader();
  await reader.read();
  publishWeb('build:status', { state: 'error' });
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"state":"error"/);
  console.log('PASS: loopback host/origin/cookie/client isolation, RPC allowlist and serialization, traversal, assets, SSE build errors');
} finally { abort.abort(); stopWeb(); }

// Opt-in LAN address and Tailscale name: exactly their Host/Origin pairs are accepted besides loopback.
process.env.SOMA_WEB_PORT = '18767'; process.env.SOMA_WEB_LAN_HOST = '127.0.0.2';
process.env.SOMA_WEB_TAILSCALE_HOST = 'soma-web.tail0.ts.net';
try {
  await startWeb(async () => ({ ok: true }), temp);
  const get = (host, headers = {}) => new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:18767/', { headers: { Host: host, ...headers } }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  assert.equal((await get('127.0.0.1:18767')).statusCode, 200);
  const lan = await get('127.0.0.2:18767', { Origin: 'http://127.0.0.2:18767' });
  assert.equal(lan.statusCode, 200);
  assert.equal((await get('127.0.0.2:18767', { Origin: 'http://127.0.0.1:18767' })).statusCode, 403);
  assert.equal((await get('127.0.0.3:18767')).statusCode, 403);
  assert.equal((await get('127.0.0.2:18767', { 'Sec-Fetch-Site': 'cross-site' })).statusCode, 403);
  const cookie = lan.headers['set-cookie'][0].split(';')[0];
  const ts = 'soma-web.tail0.ts.net';
  assert.equal((await get(ts, { Origin: 'https://' + ts })).statusCode, 200);
  assert.equal((await get(ts, { Origin: 'http://' + ts })).statusCode, 403);
  assert.equal((await get(ts + ':18767')).statusCode, 403);
  assert.equal((await get('other.tail0.ts.net', { Origin: 'https://other.tail0.ts.net' })).statusCode, 403);
  const post = (origin, host = '127.0.0.2:18767') => new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:18767/rpc', { method: 'POST', headers: { Host: host, Origin: origin, Cookie: cookie, 'X-Soma-Web': '1', 'X-Soma-Client': 'lan-browser-1234567890', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ channel: 'project:current', args: [] }));
  });
  assert.equal(await post('http://127.0.0.1:18767'), 403);
  assert.equal(await post('http://127.0.0.2:18767'), 409);
  assert.equal(await post('http://' + ts, ts), 403);
  assert.equal(await post('https://' + ts, ts), 409);
  stopWeb(); process.env.SOMA_WEB_TAILSCALE_HOST = 'evil.example';
  await assert.rejects(startWeb(async () => ({ ok: true }), temp), /Invalid SOMA_WEB_TAILSCALE_HOST/);
  delete process.env.SOMA_WEB_TAILSCALE_HOST;
  process.env.SOMA_WEB_LAN_HOST = 'lan.example';
  stopWeb();
  await assert.rejects(startWeb(async () => ({ ok: true }), temp), /Invalid SOMA_WEB_LAN_HOST/);
  console.log('PASS: opt-in LAN host and Tailscale name accept only their own Host/Origin; invalid values rejected');
} finally { stopWeb(); delete process.env.SOMA_WEB_LAN_HOST; delete process.env.SOMA_WEB_TAILSCALE_HOST; await fs.rm(temp, { recursive: true, force: true }); }
