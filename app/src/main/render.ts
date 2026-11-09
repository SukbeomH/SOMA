import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { RenderJob, RenderOutput, RenderResult } from '../shared/types';
import { resolveInside } from './files';

/**
 * Bilder und Videos des Modells (E58): ein unsichtbares Fenster mit demselben Viewer wie auf dem Bildschirm. Es entsteht
 * beim ersten Auftrag und schließt sich nach einer Minute ohne Arbeit wieder (ein Renderer-Prozess kostet Speicher).
 * Aufträge laufen nacheinander. Auftraggeber sind `soma render` im Terminal (über bridge.ts) und Knöpfe der App.
 */
export { checkRequest, type RenderRequest } from './render-request';
import type { RenderRequest } from './render-request';
const IDLE_MS = 60_000;

export class RenderService {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (o: RenderOutput) => void; progress?: (f: number) => void }>();

  constructor() {
    ipcMain.on('render:done', (e, id: number, out: RenderOutput) => {
      if (e.sender !== this.win?.webContents) return;
      this.waiting.get(id)?.resolve(out);
      this.waiting.delete(id);
    });
    ipcMain.on('render:progress', (e, id: number, f: number) => {
      if (e.sender === this.win?.webContents && Number.isFinite(f)) this.waiting.get(id)?.progress?.(f);
    });
  }

  /** Auftrag ausführen, nach den laufenden. Schreibt die Dateien ins Projekt und gibt ihre Pfade zurück. */
  run(dir: string, req: RenderRequest, progress?: (f: number) => void): Promise<RenderResult> {
    const p = this.queue.then(() => this.execute(dir, req, progress));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async execute(dir: string, req: RenderRequest, progress?: (f: number) => void): Promise<RenderResult> {
    clearTimeout(this.idle);
    try {
      const read = (rel: string) => { const b = fs.readFileSync(resolveInside(dir, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
      let model: ArrayBuffer;
      try { model = read('.soma/model.glb'); } catch { return { ok: false, files: [], warnings: [], error: 'No built model yet (soma build).' }; }
      const id = this.nextId++;
      const [w, h] = req.kind === 'video' ? [req.size[0] & ~1, req.size[1] & ~1] : req.size; // H.264 braucht gerade Maße
      const job: RenderJob = {
        id, kind: req.kind, width: w, height: h, view: req.view, at: req.at, grid: req.grid, fps: req.fps,
        dir: req.dir, hide: req.hide, only: req.only, fit: req.fit, zoom: req.zoom,
        model, anim: req.anim ? read(req.anim) : null, result: req.result ? read(req.result) : null,
      };
      const win = await this.window();
      const timeoutMs = req.kind === 'video' ? 20 * 60_000 : 2 * 60_000;
      const out = await new Promise<RenderOutput>((resolve) => {
        const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, error: 'Time limit exceeded while rendering.' }); }, timeoutMs);
        this.waiting.set(id, { resolve: (o) => { clearTimeout(timer); resolve(o); }, progress });
        win.webContents.send('render:job', job);
      });
      if (!out.ok) return { ok: false, files: [], warnings: out.warnings ?? [], error: out.error ?? 'Rendering failed.' };
      const files: string[] = [];
      const write = (rel: string, data: ArrayBuffer | string) => {
        const abs = resolveInside(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Erst vollständig schreiben, dann ersetzen: Ein Player, der die alte Datei offen hat, sieht nie eine halbe
        const tmp = `${abs}.part`;
        fs.writeFileSync(tmp, typeof data === 'string' ? data : Buffer.from(data));
        fs.renameSync(tmp, abs);
        files.push(rel);
      };
      if (req.kind === 'video') {
        if (!out.mp4) return { ok: false, files: [], warnings: [], error: 'The video is empty.' };
        write(req.out, out.mp4);
        const stem = req.out.replace(/\.mp4$/i, '');
        if (out.vtt) write(`${stem}.vtt`, out.vtt);
        if (out.sheet) write(`${stem}-sheet.png`, out.sheet);
      } else {
        if (!out.png) return { ok: false, files: [], warnings: [], error: 'The image is empty.' };
        write(req.out, out.png);
      }
      return { ok: true, files, warnings: out.warnings ?? [] };
    } catch (e) {
      return { ok: false, files: [], warnings: [], error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.close(), IDLE_MS);
    }
  }

  private window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready.then(() => this.win!);
    const win = new BrowserWindow({
      show: false, width: 1280, height: 800, title: 'SOMA Render',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'render-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      },
    });
    this.win = win;
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error(`[render] ${message}`); });
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[soma] Render window ended: ${d.reason}`);
      for (const [, w] of this.waiting) w.resolve({ ok: false, error: `The render window crashed (${d.reason}).` });
      this.waiting.clear();
      this.close();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: Electron.IpcMainEvent) => { if (e.sender === win.webContents) { ipcMain.removeListener('render:ready', onReady); resolve(); } };
      ipcMain.on('render:ready', onReady);
      win.webContents.once('did-fail-load', (_e, code, desc) => { ipcMain.removeListener('render:ready', onReady); reject(new Error(`Render window does not load: ${desc} (${code})`)); });
    });
    // Lädt es nicht, beim nächsten Auftrag ein neues versuchen statt ewig am alten zu scheitern
    this.ready.catch(() => { if (this.win === win) this.close(); });
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'render.html'));
    return this.ready.then(() => win);
  }

  close(): void {
    clearTimeout(this.idle);
    const w = this.win;
    this.win = null;
    this.ready = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
}
