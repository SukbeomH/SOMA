import { createRenderer } from '../renderer/render-engine';
import type { RenderJob } from '../shared/types';

type WireJob = Omit<RenderJob, 'model' | 'anim' | 'result'> & { model: string; anim: string | null; result: string | null };
function isJob(v: unknown): v is WireJob {
  if (!v || typeof v !== 'object') return false;
  const url = (x: unknown) => typeof x === 'string' && /^\/download\/[a-f0-9]{48}$/.test(x);
  const strings = (x: unknown) => Array.isArray(x) && x.every(y => typeof y === 'string');
  const nums = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every(y => typeof y === 'number' && Number.isFinite(y));
  return 'id' in v && typeof v.id === 'number' && 'kind' in v && ['still', 'sheet', 'video'].includes(String(v.kind))
    && 'width' in v && typeof v.width === 'number' && 'height' in v && typeof v.height === 'number'
    && 'fps' in v && typeof v.fps === 'number' && 'at' in v && typeof v.at === 'number' && 'zoom' in v && typeof v.zoom === 'number'
    && 'view' in v && (v.view === null || typeof v.view === 'string') && 'dir' in v && (v.dir === null || nums(v.dir, 3))
    && 'grid' in v && nums(v.grid, 2) && 'hide' in v && strings(v.hide) && 'only' in v && strings(v.only) && 'fit' in v && strings(v.fit)
    && 'model' in v && url(v.model) && 'anim' in v && (v.anim === null || url(v.anim)) && 'result' in v && (v.result === null || url(v.result));
}
export function installBrowserRendering(
  on: (channel: string, callback: (event: undefined, value: unknown) => void) => void,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>, client: string,
): void {
  let renderer: ReturnType<typeof createRenderer> | undefined;
  let active: { id: number; abort: AbortController } | undefined;
  on('web:renderCancel', (_e, id) => { if (active && active.id === id) active.abort.abort(); });
  on('web:render', (_e, raw) => {
    if (!isJob(raw)) return;
    void (async () => {
      if (active) { await invoke('web:renderDone', raw.id, { error: 'Browser renderer is busy.' }); return; }
      const abort = new AbortController(); active = { id: raw.id, abort };
      const panel = document.createElement('dialog');
      const status = document.createElement('p'); status.textContent = `Rendering ${raw.kind}… Keep this browser open.`;
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel render'; cancel.onclick = () => abort.abort();
      panel.append(status, cancel); document.body.append(panel); panel.showModal();
      panel.oncancel = event => { event.preventDefault(); abort.abort(); };
      try {
        if (!renderer) {
          const stage = document.createElement('div'); stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:720px;pointer-events:none';
          document.body.append(stage); renderer = createRenderer(stage);
        }
        const read = async (url: string): Promise<ArrayBuffer> => { const response = await fetch(url, { signal: abort.signal }); if (!response.ok) throw new Error('Render asset unavailable'); return response.arrayBuffer(); };
        const job: RenderJob = { ...raw, model: await read(raw.model), anim: raw.anim ? await read(raw.anim) : null, result: raw.result ? await read(raw.result) : null };
        const out = await renderer(job, f => { status.textContent = `Rendering ${Math.round(f * 100)}%`; void invoke('web:renderProgress', raw.id, f).catch(() => abort.abort()); }, abort.signal);
        abort.signal.throwIfAborted();
        if (!out.ok) throw new Error(out.error || 'Render failed');
        const upload = async (name: string, data: ArrayBuffer): Promise<string> => {
          const response = await fetch('/upload?name=' + name, { method: 'POST', headers: { 'X-Soma-Web': '1', 'X-Soma-Client': client }, body: data, signal: abort.signal });
          const value: unknown = await response.json();
          if (!response.ok || !value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string') throw new Error('Render upload failed (maximum 100 MiB per file).');
          return value.path;
        };
        const result: { png?: string; mp4?: string; sheet?: string; vtt?: string | null; warnings?: string[] } = { warnings: out.warnings, vtt: out.vtt };
        if (out.png) result.png = await upload('render.png', out.png);
        if (out.mp4) result.mp4 = await upload('render.mp4', out.mp4);
        if (out.sheet) result.sheet = await upload('sheet.png', out.sheet);
        await invoke('web:renderDone', raw.id, result);
      } catch (error) {
        await invoke('web:renderDone', raw.id, { error: abort.signal.aborted ? 'Render cancelled.' : error instanceof Error ? error.message : String(error) }).catch(() => {});
      } finally { panel.close(); panel.remove(); active = undefined; }
    })();
  });
}
