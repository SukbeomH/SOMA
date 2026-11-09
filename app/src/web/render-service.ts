import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../main/files';
import { publishWeb, webClient } from '../main/web';
import type { RenderBackend, RenderRequest } from '../main/render-request';
import type { RenderJob, RenderResult } from '../shared/types';
import type { WebFiles } from './files';

export class WebRenderService implements RenderBackend {
  private nextId = 1;
  private pending: { id: number; finish: (value: unknown) => void; progress?: (fraction: number) => void } | null = null;
  constructor(private readonly files: WebFiles) {}
  progress(id: unknown, fraction: unknown): void {
    if (id === this.pending?.id && typeof fraction === 'number' && Number.isFinite(fraction)) this.pending?.progress?.(Math.max(0, Math.min(1, fraction)));
  }
  done(id: unknown, value: unknown): void { if (id === this.pending?.id) this.pending?.finish(value); }
  close(): void { this.pending?.finish({ error: 'Rendering stopped.' }); }
  async run(dir: string, req: RenderRequest, progress?: (fraction: number) => void): Promise<RenderResult> {
    const fail = (error: string): RenderResult => ({ ok: false, files: [], warnings: [], error });
    const client = webClient();
    if (!client) return fail('Open the SOMA browser to render images or video.');
    if (this.pending) return fail('Another render is running. Wait or cancel it first.');
    const id = this.nextId++;
    try {
      const asset = (rel: string) => this.files.grant(resolveInside(dir, rel)).url;
      const settings: Omit<RenderJob, 'model' | 'anim' | 'result'> = {
        id, kind: req.kind, width: req.size[0], height: req.size[1], view: req.view, at: req.at,
        grid: req.grid, fps: req.fps, dir: req.dir, hide: req.hide, only: req.only, fit: req.fit, zoom: req.zoom,
      };
      if (req.kind === 'video') { settings.width &= ~1; settings.height &= ~1; }
      const job = { ...settings, model: asset('.soma/model.glb'), anim: req.anim ? asset(req.anim) : null, result: req.result ? asset(req.result) : null };
      const response: unknown = await new Promise(resolve => {
        const finish = (value: unknown) => { clearTimeout(timeout); clearInterval(connection); this.pending = null; resolve(value); };
        const timeout = setTimeout(() => { publishWeb('web:renderCancel', id); finish({ error: 'Render time limit exceeded.' }); }, req.kind === 'video' ? 20 * 60_000 : 120_000);
        const connection = setInterval(() => { if (webClient() !== client) finish({ error: 'Browser disconnected; render cancelled.' }); }, 500);
        this.pending = { id, finish, progress };
        publishWeb('web:render', job);
      });
      if (!response || typeof response !== 'object') return fail('Invalid render result.');
      if ('error' in response) return fail(String(response.error));
      const warnings = 'warnings' in response && Array.isArray(response.warnings) ? response.warnings.filter((x): x is string => typeof x === 'string') : [];
      const artifacts: Array<[string, Buffer]> = [];
      const take = (key: string, rel: string) => {
        if (!(key in response)) throw new Error(`Missing render artifact: ${key}`);
        const value = Reflect.get(response, key);
        if (typeof value !== 'string') throw new Error('Invalid render upload');
        artifacts.push([rel, this.files.takeUpload(value)]);
      };
      if (req.kind === 'video') { take('mp4', req.out); take('sheet', req.out.replace(/\.mp4$/i, '-sheet.png')); }
      else take('png', req.out);
      if ('vtt' in response && typeof response.vtt === 'string') artifacts.push([req.out.replace(/\.mp4$/i, '.vtt'), Buffer.from(response.vtt)]);
      for (const [rel, data] of artifacts) {
        const dest = resolveInside(dir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest + '.part', data); fs.renameSync(dest + '.part', dest);
      }
      publishWeb('web:downloads', artifacts.map(([rel]) => this.files.grant(resolveInside(dir, rel))));
      return { ok: true, files: artifacts.map(([rel]) => rel), warnings };
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
}
