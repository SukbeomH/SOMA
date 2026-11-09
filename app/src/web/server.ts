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
import { SOMA_VERSION } from '../shared/version';

const appDir = path.resolve(__dirname, '../..');
const dataDir = process.env.SOMA_USER_DATA || path.resolve(appDir, '..', '.soma-web');
process.env.SOMA_USER_DATA = dataDir;
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
  const value = await ask('web:path', {
    title: options.title || (save ? 'Save file' : 'Open file'), save,
    directory: 'properties' in options && options.properties?.some(p => p === 'openDirectory'),
    multiple: 'properties' in options && options.properties?.some(p => p === 'multiSelections'),
    defaultPath: save ? path.join(downloads, path.basename(options.defaultPath || 'model.soma')) : options.defaultPath || '',
  });
  if (typeof value !== 'string' || !value.trim()) return [];
  const paths = value.split('\n').map(p => p.trim()).filter(Boolean);
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
const controller = new ProjectController(() => null, { send: publishWeb, isDestroyed: () => closing }, {
  run: async () => ({ ok: false, files: [], warnings: [], error: 'Image/video export and soma render require the desktop edition. The web viewer renders in your browser; no server display is installed.' }),
  close: () => {},
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
    return Reflect.apply(handler, undefined, [undefined, ...args]);
  }, path.join(appDir, 'dist', 'renderer'));
  warmUp(); console.log(`[soma-web] ${url} (Node.js; no Electron or display)`);
}
void main().catch(async error => { console.error(error); await close(); process.exitCode = 1; });
