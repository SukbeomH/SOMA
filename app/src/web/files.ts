import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

export const MAX_UPLOAD = 100 * 1024 * 1024;
export class WebFiles {
  private downloads = new Map<string, { file: string; expires: number }>();
  constructor(private readonly data: string) {}

  async upload(req: IncomingMessage, name: string): Promise<string> {
    if (!name || name.length > 240 || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('Invalid file name');
    if (Number(req.headers['content-length']) > MAX_UPLOAD) throw new Error('File exceeds 100 MiB');
    const dir = path.join(this.data, 'uploads', crypto.randomUUID());
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    let handle;
    try {
      handle = await fs.promises.open(file, 'wx', 0o600);
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_UPLOAD) throw new Error('File exceeds 100 MiB');
        await handle.writeFile(bytes);
      }
      return file;
    } catch (error) {
      await fs.promises.rm(file, { force: true });
      await fs.promises.rmdir(dir);
      throw error;
    } finally { await handle?.close(); }
  }

  takeUpload(file: string, maxBytes = MAX_UPLOAD): Buffer {
    const root = fs.realpathSync(path.join(this.data, 'uploads')) + path.sep;
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(root) || !fs.statSync(resolved).isFile()) throw new Error('Invalid render upload path');
    if (fs.statSync(resolved).size > maxBytes) throw new Error('Uploaded image is too large');
    const data = fs.readFileSync(resolved);
    if (!data.length || data.length > MAX_UPLOAD) throw new Error('Empty or oversized render result');
    fs.unlinkSync(resolved);
    return data;
  }

  grant(file: string): { name: string; url: string; size: number } {
    const resolved = fs.realpathSync(file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Download is not a file');
    for (const [key, entry] of this.downloads) if (entry.expires < Date.now()) this.downloads.delete(key);
    const token = crypto.randomBytes(24).toString('hex');
    this.downloads.set(token, { file: resolved, expires: Date.now() + 30 * 60_000 });
    return { name: path.basename(file), url: `/download/${token}`, size: stat.size };
  }

  async download(token: string, res: ServerResponse): Promise<void> {
    const entry = this.downloads.get(token);
    if (!entry || entry.expires < Date.now()) { res.writeHead(404); res.end('Download expired; export again.'); return; }
    if (fs.realpathSync(entry.file) !== entry.file) throw new Error('Download path changed');
    const input = fs.createReadStream(entry.file, { fd: fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), autoClose: true });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(entry.file)).replace(/'/g, '%27')}`,
    });
    await pipeline(input, res);
  }
}
