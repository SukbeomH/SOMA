import { createRenderer } from './render-engine';
import type { RenderOutput } from '../shared/types';
const api = window.somaRender;
const run = createRenderer(document.getElementById('stage')!);
let busy: Promise<void> = Promise.resolve();
api.onJob((job) => {
  busy = busy.then(async () => {
    let out: RenderOutput;
    try { out = await run(job, f => api.progress(job.id, f)); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    api.done(job.id, out);
  });
});
api.ready();
