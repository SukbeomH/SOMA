import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export type Dispatch = (channel: string, args: unknown[]) => Promise<unknown>;

export const webChannels = new Set<string>();
const eventChannels = new Set(['term:write', 'term:resize', 'term:kill', 'editor:res', 'dialog:ready', 'dialog:res']);
const clients = new Set<http.ServerResponse>();
let activeClient: string | null = null;
let server: http.Server | undefined;

export function publishWeb(channel: string, ...args: unknown[]): void {
  const payload = `data: ${JSON.stringify({ channel, args })}\n\n`;
  for (const client of clients) client.write(payload);
}
export function stopWeb(): void {
  for (const client of clients) client.end();
  clients.clear(); activeClient = null; server?.close();
}
export async function startWeb(dispatch: Dispatch, root: string): Promise<string> {
  const port = Number(process.env.SOMA_WEB_PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SOMA_WEB_PORT');
  const origin = `http://127.0.0.1:${port}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const send = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, { error: 'Local same-origin access only' }); return; }
      const url = new URL(req.url || '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Set-Cookie', `soma_web=${secret}; HttpOnly; SameSite=Strict; Path=/`);
      } else if (!req.headers.cookie?.split(';').some(c => c.trim() === `soma_web=${secret}`)) {
        send(res, 403, { error: 'Open the SOMA home page first' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const client = url.searchParams.get('client');
        if (!client || !/^[a-zA-Z0-9-]{16,80}$/.test(client)) { send(res, 400, { error: 'Invalid browser session' }); return; }
        // One browser controls the shared project, editor callbacks and terminal session.
        if (clients.size) { send(res, 409, { error: 'SOMA already has an active browser. Close the other tab first.' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n'); clients.add(res); activeClient = client;
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); clients.delete(res); if (activeClient === client) activeClient = null; }); return;
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        if (req.headers.origin !== origin || req.headers['x-soma-web'] !== '1') { send(res, 403, { error: 'Invalid request origin' }); return; }
        if (!activeClient || req.headers['x-soma-client'] !== activeClient) { send(res, 409, { error: 'This browser is not connected. Close other SOMA tabs and reload.' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 12 * 1024 * 1024) { send(res, 413, { error: 'Request too large' }); return; } chunks.push(b); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || !('channel' in body) || typeof body.channel !== 'string'
          || !('args' in body) || !Array.isArray(body.args) || body.args.length > 8
          || !(webChannels.has(body.channel) || eventChannels.has(body.channel)) || body.channel.startsWith('test:')) {
          send(res, 400, { error: 'Unknown request' }); return;
        }
        const result = await dispatch(body.channel, body.args);
        send(res, 200, { value: result instanceof ArrayBuffer ? { __binary: Buffer.from(result).toString('base64') } : result }); return;
      }
      if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return; }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()
        || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) { send(res, 404, { error: 'Not found' }); return; }
      const mime: Record<string,string> = { '.html': 'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.wasm':'application/wasm' };
      let bytes = fs.readFileSync(file);
      if (rel === 'index.html') bytes = Buffer.from(bytes.toString().replace('<script src="main.js"', '<script src="web-preload.js"></script><script src="main.js"'));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY' }); res.end(bytes);
    } catch (e) { if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : 'Request failed' }); else res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(port, process.env.SOMA_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1', resolve); });
  return origin;
}
