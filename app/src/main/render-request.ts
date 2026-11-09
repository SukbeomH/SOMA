import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from './files';
import type { RenderResult } from '../shared/types';
export interface RenderRequest {
  kind: 'still' | 'sheet' | 'video';
  size: [number, number];
  view: string | null;
  /** Freie Blickrichtung statt `view`, Namen von Teilen oder Gruppen (aufgelöst im Render-Fenster), Zoom (1: eingepasst). */
  dir: [number, number, number] | null;
  hide: string[];
  only: string[];
  fit: string[];
  zoom: number;
  at: number;
  grid: [number, number];
  fps: number;
  /** Dateien im Projekt (relativ): Animation (.soma/anim/…glb), Ergebnis (.soma/results/…glb), Ziel. */
  anim: string | null;
  result: string | null;
  out: string;
}

const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const MAX_SIDE = 3840;


/** Prüft einen Auftrag von außen (Terminal) und bringt ihn auf die erwartete Form. Fehler als Text. */
export function checkRequest(root: string, raw: unknown): RenderRequest | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== 'still' && kind !== 'sheet' && kind !== 'video') return 'Unknown kind (still, sheet or video).';
  const size = Array.isArray(r.size) ? r.size.map(Number) : [];
  if (size.length !== 2 || !size.every((v) => Number.isInteger(v) && v >= 64 && v <= MAX_SIDE)) return `Size between 64 and ${MAX_SIDE} pixels.`;
  const grid = Array.isArray(r.grid) ? r.grid.map(Number) : [3, 3];
  if (grid.length !== 2 || !grid.every((v) => Number.isInteger(v) && v >= 1 && v <= 6)) return 'Contact sheet: 1 to 6 columns and rows.';
  const view = r.view == null ? null : String(r.view);
  if (view && !VIEWS.includes(view)) return `Unknown view ${view}.`;
  const dir = r.dir == null ? null : Array.isArray(r.dir) ? r.dir.map(Number) : [];
  if (dir && (dir.length !== 3 || !dir.every(Number.isFinite) || Math.hypot(...dir) < 1e-9)) return 'The view direction needs three numbers, not all zero.';
  const names = (v: unknown, what: string): string[] | Error => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 300)) return new Error(`${what}: a list of part or group names.`);
    return v as string[];
  };
  const hide = names(r.hide, 'Hide'), only = names(r.only, 'Only'), fit = names(r.fit, 'Fit');
  for (const x of [hide, only, fit]) if (x instanceof Error) return x.message;
  const zoom = r.zoom == null ? 1 : Number(r.zoom);
  if (!Number.isFinite(zoom) || zoom < 0.05 || zoom > 50) return 'Zoom between 0.05 and 50.';
  const at = r.at == null ? 0 : Number(r.at);
  const fps = r.fps == null ? 30 : Number(r.fps);
  if (!Number.isFinite(at) || at < 0) return 'Invalid time.';
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) return 'Frames per second between 1 and 60.';
  const file = (v: unknown, dir: string, what: string): string | null | Error => {
    if (v == null) return null;
    const p = String(v).replace(/\\/g, '/');
    if (!p.startsWith(dir) || !p.endsWith('.glb') || p.includes('..')) return new Error(`${what} must be in ${dir}.`);
    try { if (!fs.statSync(resolveInside(root, p)).isFile()) throw new Error(); } catch { return new Error(`${what} ${p} does not exist.`); }
    return p;
  };
  const anim = file(r.anim, '.soma/anim/', 'The animation');
  const result = file(r.result, '.soma/results/', 'The result');
  if (anim instanceof Error) return anim.message;
  if (result instanceof Error) return result.message;
  if ((kind === 'sheet' || kind === 'video') && !anim) return 'Contact sheet and video need an animation.';
  const out = String(r.out ?? '').replace(/\\/g, '/');
  const ext = kind === 'video' ? '.mp4' : '.png';
  if (!out.toLowerCase().endsWith(ext)) return `The target must end in ${ext}.`;
  if (/^(\.git|\.soma)(\/|$)/i.test(out) || out.split('/').includes('..') || path.isAbsolute(out)) return 'The target must be in the project folder, not in .git/ or .soma/.';
  try { resolveInside(root, out); } catch { return 'The target is not in the project folder.'; }
  return { kind, size: [size[0], size[1]], view, dir: dir as [number, number, number] | null, hide: hide as string[], only: only as string[], fit: fit as string[], zoom, at, grid: [grid[0], grid[1]], fps, anim, result, out };
}


export interface RenderBackend {
  run(dir: string, req: RenderRequest, progress?: (f: number) => void): Promise<RenderResult>;
  close(): void;
}
