import { resolveInside } from '../main/files';
import { WebRenderService } from './render-service';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { configureHost } from '../main/host';
import { registerRpc } from '../main/rpc';
import { ProjectController } from '../main/projects';
import { publishWeb, startWeb, stopWeb, webChannels } from '../main/web';
import { setDialogHost, type ChooseOptions } from '../main/dialogs';
import { initLog } from '../main/log';
import { logsDir, pythonExe, skillDirs, userDataDir } from '../main/paths';
import { warmUp, stopWarm } from '../main/build';
import { startBridge, stopBridge } from '../main/bridge';
import { sweepDiscarded } from '../main/workspace';
import { renameOldSkillFiles } from '../main/skilllibrary';
import { WebFiles } from './files';
import { SOMA_VERSION } from '../shared/version';

process.env.SOMA_WEB = '1';
const appDir = path.resolve(__dirname, '../..');
const dataDir = process.env.SOMA_USER_DATA || path.resolve(appDir, '..', '.soma-web');
process.env.SOMA_USER_DATA = dataDir;
const files = new WebFiles(dataDir);
const exportChannels = new Set(['build:export', 'project:exportZip', 'project:exportCadQuery', 'project:save', 'drawings:export']);
const downloads = path.join(dataDir, 'exports');
fs.mkdirSync(downloads, { recursive: true });
const handlers = new Map<string, (...args: never[]) => unknown>();
const register = (channel: string, fn: (...args: never[]) => unknown) => { handlers.set(channel, fn); webChannels.add(channel); };
let nextRequest = 0;
const pending = new Map<number, (value: unknown) => void>();
function ask(channel: string, options: unknown): Promise<unknown> {
  return new Promise(resolve => {
    const id = ++nextRequest;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 120_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    publishWeb(channel, id, options);
  });
}
register('dialog:res', (_event: unknown, id: unknown, value: unknown) => {
  if (typeof id !== 'number') return;
  pending.get(id)?.(value); pending.delete(id);
});
register('web:pathResult', (_event: unknown, id: unknown, value: unknown) => {
  if (typeof id !== 'number') return;
  pending.get(id)?.(value); pending.delete(id);
});
register('dialog:ready', () => {});
register('editor:res', () => {});
async function question(options: ChooseOptions): Promise<number> {
  const value = await ask('dialog:show', options);
  return typeof value === 'number' ? value : options.buttons.length - 1;
}
function optionsOf<T>(first: T | Electron.BaseWindow, second?: T): T {
  if (second) return second;
  // Host is called with no BrowserWindow in Node mode; reject accidental native use.
  if (first && typeof first === 'object' && 'id' in first) throw new Error('Native windows are unavailable in web mode.');
  return first as T;
}
async function pickPath(options: SaveDialogOptions | OpenDialogOptions, save: boolean): Promise<string[]> {
  if ('buttonLabel' in options && options.buttonLabel === 'Export here') {
    return [fs.mkdtempSync(path.join(downloads, 'export-'))];
  }
  const value = await ask('web:path', {
    title: options.title || (save ? 'Save file' : 'Open file'), save,
    directory: 'properties' in options && options.properties?.some(p => p === 'openDirectory'),
    multiple: 'properties' in options && options.properties?.some(p => p === 'multiSelections'),
    accept: options.filters?.flatMap(f => f.extensions).filter(e => e !== '*').map(e => `.${e}`).join(',') || '',
    defaultPath: save ? path.basename(options.defaultPath || 'model.soma') : options.defaultPath || '',
  });
  if (typeof value !== 'string' || !value.trim()) return [];
  const paths = value.split('\n').map(p => p.trim()).filter(Boolean);
  if (save && paths.length === 1 && !path.isAbsolute(paths[0])) {
    if (paths[0] !== path.basename(paths[0]) || /[\\/\x00-\x1f]/.test(paths[0]) || paths[0] === '.' || paths[0] === '..') throw new Error('Use a file name, not a relative path.');
    paths[0] = path.join(fs.mkdtempSync(path.join(downloads, 'export-')), paths[0]);
  }
  for (const p of paths) {
    if (!path.isAbsolute(p)) throw new Error('Enter an absolute path on the SOMA server.');
    if (save) fs.mkdirSync(path.dirname(p), { recursive: true });
    else if ('properties' in options && options.properties?.includes('createDirectory')) fs.mkdirSync(p, { recursive: true });
    else if (!fs.existsSync(p)) throw new Error(`Path does not exist on the server: ${p}`);
  }
  if (save && paths[0] && fs.existsSync(paths[0])) {
    const answer = await question({ title: 'Replace file?', message: paths[0], buttons: ['Replace', 'Cancel'] });
    if (answer !== 0) return [];
  }
  return paths;
}
configureHost({
  app: {
    isPackaged: false, getAppPath: () => appDir,
    getPath: name => name === 'userData' ? dataDir : name === 'documents' ? downloads : os.homedir(),
  },
  fetch: globalThis.fetch,
  clipboard: { writeText: async text => { publishWeb('web:clipboard', text); } },
  shell: {
    openExternal: async url => { publishWeb('web:openUrl', url); },
    openPath: async file => { publishWeb('web:location', file); return ''; },
    showItemInFolder: async file => { publishWeb('web:location', file); },
    trashItem: async file => {
      const trash = path.join(dataDir, 'trash'); fs.mkdirSync(trash, { recursive: true });
      await fs.promises.rename(file, path.join(trash, `${crypto.randomUUID()}-${path.basename(file)}`));
    },
  },
  dialog: {
    showSaveDialog: async (first: SaveDialogOptions | Electron.BaseWindow, second?: SaveDialogOptions) => {
      const paths = await pickPath(optionsOf(first, second), true);
      return { canceled: !paths.length, filePath: paths[0] || '' };
    },
    showOpenDialog: async (first: OpenDialogOptions | Electron.BaseWindow, second?: OpenDialogOptions) => {
      const paths = await pickPath(optionsOf(first, second), false);
      return { canceled: !paths.length, filePaths: paths };
    },
    showMessageBox: async (first: MessageBoxOptions | Electron.BaseWindow, second?: MessageBoxOptions) => {
      const o = optionsOf(first, second);
      return { response: await question({ title: o.title || 'SOMA', message: o.message, detail: o.detail, buttons: o.buttons || ['OK'] }), checkboxChecked: false };
    },
  },
});
setDialogHost(question);
let closing = false;
const renders = new WebRenderService(files);
register('web:renderDone', (_event: unknown, id: unknown, value: unknown) => renders.done(id, value));
register('web:renderProgress', (_event: unknown, id: unknown, value: unknown) => renders.progress(id, value));
const controller = new ProjectController(() => null, { send: publishWeb, isDestroyed: () => closing }, renders);
register('web:still', (_event: unknown, result: unknown) => controller.renderStill(result));
register('web:fem', (_event: unknown, study: unknown) => controller.runFem(study));
register('web:attachImage', (_event: unknown, project: unknown, terminal: unknown, upload: unknown) => {
  const session = controller.need();
  if (project !== session.id || typeof terminal !== 'number' || !session.terminals.has(terminal)) throw new Error('The target model or terminal changed. Paste again in the intended terminal.');
  if (typeof upload !== 'string') throw new Error('Invalid image upload');
  const png = files.takeUpload(upload, 20 * 1024 * 1024);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('The clipboard file is not a PNG image');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width * height > 32_000_000) throw new Error('Image exceeds 32 megapixels');
  const target = resolveInside(session.dir, `inputs/clipboard-${crypto.randomUUID()}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png, { flag: 'wx', mode: 0o600 });
  publishWeb('fs:changed');
  return target;
});
registerRpc(controller, { handle: register, on: register });
initLog(logsDir(), { version: SOMA_VERSION, runtime: `Node ${process.version}`, python: pythonExe(), appData: userDataDir() });
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  stopWeb(); controller.close(); stopBridge(); stopWarm();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
async function main(): Promise<void> {
  sweepDiscarded(); renameOldSkillFiles(skillDirs());
  await startBridge((route, body) => route === 'render' ? controller.renderForAgent(body) : Promise.resolve({ status: 404, body: { ok: false, error: 'Unknown request' } }));
  const url = await startWeb(async (channel, args) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Unknown request');
    const result: unknown = await Reflect.apply(handler, undefined, [undefined, ...args]);
    if (exportChannels.has(channel) && result && typeof result === 'object'
        && !('error' in result && result.error) && !('ok' in result && result.ok === false)) {
      const paths = 'files' in result && Array.isArray(result.files) ? result.files.filter((p): p is string => typeof p === 'string') : [];
      if ('zipPath' in result && typeof result.zipPath === 'string') paths.push(result.zipPath);
      if (paths.length) publishWeb('web:downloads', paths.map(file => files.grant(file)));
    }
    return result;
  }, path.join(appDir, 'dist', 'renderer'), files);
  warmUp(); console.log(`[soma-web] ${url} (Node.js; no Electron or display)`);
}
void main().catch(async error => { console.error(error); await close(); process.exitCode = 1; });
