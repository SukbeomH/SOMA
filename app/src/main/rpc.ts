import type { BrowserWindow } from 'electron';
import { host } from './host';
import fs from 'node:fs';
import path from 'node:path';
import { aboutInfo, aboutText } from './about';
import { detectAgents } from './agents';
import { choose, chooseInputFiles, chooseSkillFiles, trashItem } from './dialogs';
import { viewDxf } from './dxf';
import { backupText, createEntry, entryPath, importInputs, listFiles, renameEntry, resolveInside, saveFeedbackImage, trashEntry, writeProjectText } from './files';
import { ProjectController } from './projects';
import { terminalEnv } from './terminals';
import { readHelp, readHelpImage } from './help';
import { editBackupsDir, helpDir, libraryBackupsDir, skillDirs, skillsDir, thumbnailsDir, userSkillsDir } from './paths';
import { readSettings, writeSettings } from './settings';
import { checkUpdate } from './updates';
import { areaDir, clearPreviews, isStorageArea, storageStats } from './storage';
import { checkLibraryText, createLibrarySkill, importLibrarySkills, libraryState, ownFile, readLibrarySkill, removeLibrarySkill, saveLibrarySkill } from './skilllibrary';
import { isSkillId, isSkillMode, librarySkill } from './skills';
import { fileOpBlockReason } from '../shared/editable';
import type { FileOpResult, LibraryResult, StorageClear } from '../shared/types';
import { getSkillBases, getSkillDefaults, isProjectId, setSkillBase, setSkillDefault } from './workspace';

export interface RpcRegistrar {
  handle(channel: string, fn: (...args: never[]) => unknown): void;
  on(channel: string, fn: (...args: never[]) => unknown): unknown;
}
export let testClipboard = '';
function copyText(text: string): void {
  if (process.env.SOMA_TEST === '1') testClipboard = text;
  else host().clipboard.writeText(text);
}
export function registerRpc(ctl: ProjectController, ipcMain: RpcRegistrar, win: BrowserWindow | null = null): void {
  const dir = () => ctl.need().dir;

  ipcMain.handle('project:current', () => ctl.info());
  // Nur der feste Name fürs Tutorial (E94), kein freier Text aus dem Renderer
  ipcMain.handle('project:create', (_e, kind?: unknown) => ctl.create(kind === 'tutorial' ? 'Tutorial' : undefined));
  ipcMain.handle('project:list', async () => (await import('./workspace')).listProjects());
  ipcMain.handle('project:open', (_e, id: string) => ctl.open(id));
  ipcMain.handle('project:saveState', () => ctl.saveState());
  ipcMain.handle('project:save', (_e, saveAs?: boolean) => ctl.save(!!saveAs));
  ipcMain.handle('project:openZip', () => ctl.openZip());
  ipcMain.handle('project:openFolder', () => ctl.openFolder());
  ipcMain.handle('project:exportZip', () => ctl.exportZip());
  ipcMain.handle('project:createFromCadQuery', () => ctl.createFromCadQuery());
  ipcMain.handle('project:exportCadQuery', () => ctl.exportCadQuery());
  ipcMain.handle('project:reveal', () => ctl.reveal());
  // Agenten-Apps (Claude Desktop, Codex-App) öffnen den Arbeitsordner selbst. `soma` finden sie über .soma/env (AGENTS.md)
  ipcMain.handle('project:copyPath', (): FileOpResult => {
    const dir = ctl.session?.dir;
    if (!dir) return { ok: false, error: 'No model is open.' };
    copyText(dir);
    return { ok: true, path: dir };
  });
  ipcMain.handle('project:setThumb', (_e, dataUrl: string) => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m || m[1].length > 2_000_000 || !ctl.session) return;
    fs.mkdirSync(thumbnailsDir(), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsDir(), `${ctl.session.id}.jpg`), Buffer.from(m[1], 'base64'));
  });
  ipcMain.handle('project:remove', (_e, id: string) => ctl.remove(String(id)));
  ipcMain.handle('project:viewFile', (_e, rel: unknown) => ctl.viewFile(rel));
  ipcMain.handle('project:thumb', (_e, id: string) => {
    if (!isProjectId(String(id))) return null;
    try { return `data:image/jpeg;base64,${fs.readFileSync(path.join(thumbnailsDir(), `${id}.jpg`)).toString('base64')}`; } catch { return null; }
  });

  ipcMain.handle('versions:log', () => ctl.gitLog());
  ipcMain.handle('versions:preview', (_e, hash: string) => ctl.preview(hash));
  ipcMain.handle('versions:restore', (_e, hash: string) => ctl.restore(hash));

  ipcMain.handle('build:run', () => ctl.need().builds.start('manual'));
  ipcMain.handle('build:cancel', () => ctl.need().builds.cancel());
  ipcMain.handle('build:setAuto', (_e, on: boolean) => ctl.need().builds.setAuto(!!on));
  ipcMain.handle('build:status', () => ctl.need().builds.status);
  ipcMain.handle('build:export', (_e, format: string, part: string | null, mesh: unknown) => ctl.exportModel(String(format), part ? String(part) : null, mesh));

  ipcMain.handle('fs:list', () => listFiles(dir()));
  ipcMain.handle('fs:import', (_e, paths: string[]) => importInputs(dir(), Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('fs:importPick', async () => {
    const root = dir();
    const files = await chooseInputFiles(win);
    return files.length ? importInputs(root, files) : null;
  });
  ipcMain.handle('fs:create', (_e, parent: string, name: string, isDir: boolean) => createEntry(dir(), String(parent ?? ''), String(name ?? ''), !!isDir));
  ipcMain.handle('fs:rename', (_e, rel: string, name: string) => renameEntry(dir(), String(rel ?? ''), String(name ?? '')));
  ipcMain.handle('fs:trash', async (_e, rel: string): Promise<FileOpResult> => {
    const root = dir();
    const r = entryPath(root, String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    // Gesperrtes gar nicht erst zur Rückfrage bringen (trashEntry prüft danach noch einmal mit bereinigtem Pfad)
    const block = fileOpBlockReason(String(rel), 'delete');
    if (block) return { ok: false, error: `${rel} cannot be deleted. ${block}` };
    const isDir = fs.statSync(r.abs).isDirectory();
    // Die Rückfrage stellt der Hauptprozess: So beantworten Tests sie wie alle anderen Dialoge (dialogs.ts)
    const c = await choose(win, {
      title: 'Delete',
      message: isDir ? `Move the folder “${path.basename(r.abs)}” and everything in it to the Recycle Bin?` : `Move “${path.basename(r.abs)}” to the Recycle Bin?`,
      detail: 'It can be restored from the Recycle Bin. Saved versions in the history are kept anyway.',
      buttons: ['Move to Recycle Bin', 'Cancel'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    return trashEntry(root, String(rel), (abs) => trashItem(abs));
  });
  ipcMain.handle('fs:reveal', (_e, rel: string): FileOpResult => {
    const r = entryPath(dir(), String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST !== '1') host().shell.showItemInFolder(r.abs);
    return { ok: true, path: String(rel ?? '') };
  });
  ipcMain.handle('fs:openExternal', async (_e, rel: string): Promise<FileOpResult> => {
    const r = entryPath(dir(), String(rel ?? ''), true);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: String(rel ?? '') };
    const err = await host().shell.openPath(r.abs);
    return err ? { ok: false, error: err } : { ok: true, path: String(rel ?? '') };
  });
  // Links aus Markdown-Dateien (E51). Nur Web und Mail: file:, Programme und eigene Protokolle könnten etwas ausführen.
  // „Send to agent“ legt den Text auch in die Zwischenablage, für Agenten-Apps außerhalb der App (Claude Desktop, Codex-App)
  ipcMain.handle('app:copyText', (_e, text: unknown): FileOpResult => {
    if (typeof text !== 'string' || text.length > 1_000_000) return { ok: false, error: 'Nothing to copy.' };
    copyText(text);
    return { ok: true };
  });
  ipcMain.handle('app:openUrl', async (_e, url: unknown): Promise<FileOpResult> => {
    const u = String(url ?? '');
    if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: `Only web and mail addresses can be opened: ${u.slice(0, 100)}` };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: u };
    try { await host().shell.openExternal(u); return { ok: true, path: u }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('fs:saveFeedback', (_e, png: unknown) => saveFeedbackImage(dir(), png));
  ipcMain.handle('fs:writeText', (_e, id: string, rel: string, text: string, base: string | null, force?: boolean) => {
    const s = ctl.session;
    // Späte Eingabe aus einem schon gewechselten Modell: nicht ins falsche Projekt schreiben, aber auch nicht verlieren
    if (!s || s.id !== id) {
      if (!isProjectId(String(id))) return { ok: false, error: 'Unknown model.' };
      return { ok: false, error: `The model has been switched in the meantime. The change is kept as a backup in ${backupText(editBackupsDir(id), String(rel), String(text))}` };
    }
    return writeProjectText(s.dir, String(rel), String(text), base == null ? null : String(base), !!force, editBackupsDir(s.id));
  });
  ipcMain.handle('fs:backupText', (_e, id: string, rel: string, text: string) => {
    if (!isProjectId(String(id))) throw new Error('Unknown model.');
    return backupText(editBackupsDir(String(id)), String(rel), String(text));
  });
  ipcMain.handle('fs:readText', (_e, rel: string) => fs.readFileSync(resolveInside(dir(), rel), 'utf8'));
  ipcMain.handle('fs:readBinary', (_e, rel: string) => {
    const b = fs.readFileSync(resolveInside(dir(), rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  ipcMain.handle('dxf:view', (_e, rel: unknown, known: unknown) => viewDxf(dir(), String(rel), known == null ? null : String(known)));

  ipcMain.handle('term:create', (_e, opts?: { command?: string }) => ctl.need().terminals.create(opts));
  ipcMain.on('term:write', (_e, id: number, data: string) => ctl.session?.terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => ctl.session?.terminals.resize(id, cols, rows));
  ipcMain.on('term:kill', (_e, id: number) => ctl.session?.terminals.kill(id));

  const agents = () => detectAgents(ctl.session ? terminalEnv(dir()) : process.env);
  ipcMain.handle('agents:detect', () => agents());
  ipcMain.handle('measure:query', (_e, source: unknown, req: unknown) => ctl.measure(source, req));
  ipcMain.handle('measure:start', () => ctl.measureStart());
  ipcMain.handle('measure:prepare', (_e, source: unknown, build: unknown) => ctl.measurePrepare(source, build));
  ipcMain.handle('params:state', () => ctl.paramState());
  ipcMain.handle('params:set', (_e, values: unknown) => ctl.setParams(values));
  ipcMain.handle('params:resetAll', () => ctl.resetAllParams());
  // Anleitung (E83): Text aus dem mitgelieferten Skill, Bilder aus resources/help/
  ipcMain.handle('help:read', () => readHelp(skillsDir()));
  ipcMain.handle('help:image', (_e, name: unknown) => readHelpImage(helpDir(), name));
  ipcMain.handle('skills:list', () => ctl.skills());
  ipcMain.handle('skills:set', (_e, id: unknown, mode: unknown) => ctl.setSkill(id, mode));
  ipcMain.handle('skills:configure', (_e, id: unknown, values: unknown) => ctl.configureSkill(id, values));
  ipcMain.handle('skills:setDefault', (_e, id: unknown, mode: unknown) => ctl.setSkillDefault(id, mode));

  // Bibliothek der Skills in den Einstellungen (E78): unabhängig vom offenen Modell, also auch auf der Startseite
  const lib = () => libraryState(skillDirs(), getSkillDefaults(), getSkillBases());
  const libDo = async (f: () => Omit<LibraryResult, 'ok' | 'library'> | Promise<Omit<LibraryResult, 'ok' | 'library'>>): Promise<LibraryResult> => {
    try { return { ok: true, ...(await f()), library: lib() }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), library: lib() }; }
  };
  ipcMain.handle('library:list', () => lib());
  ipcMain.handle('library:read', (_e, id: unknown) => readLibrarySkill(skillDirs(), String(id)));
  ipcMain.handle('library:check', (_e, text: unknown) => checkLibraryText(text));
  ipcMain.handle('library:save', (_e, id: unknown, text: unknown, base: unknown) => libDo(() => {
    if (typeof text !== 'string') throw new Error('No text.');
    const r = saveLibrarySkill(skillDirs(), String(id), text, typeof base === 'string' ? base : null, libraryBackupsDir());
    if (r.base !== undefined) setSkillBase(String(id), r.base);
    return { id: String(id), backup: r.backup, warnings: r.warnings };
  }));
  ipcMain.handle('library:create', (_e, title: unknown, from: unknown) =>
    libDo(() => ({ id: createLibrarySkill(skillDirs(), String(title ?? ''), typeof from === 'string' ? from : undefined) })));
  ipcMain.handle('library:remove', (_e, id: unknown) => libDo(() => {
    const backup = removeLibrarySkill(skillDirs(), String(id), libraryBackupsDir());
    setSkillBase(String(id), null);
    return { id: String(id), backup };
  }));
  ipcMain.handle('library:import', () => libDo(async () => {
    const files = await chooseSkillFiles(win);
    if (!files.length) return { canceled: true };
    const r = await importLibrarySkills(skillDirs(), files, libraryBackupsDir(), async (c) => {
      const detail = c.source === 'own'
        ? `${c.file} has the same file name as one of your skills. Replace: your current version goes into the backup. Import as a copy: the file gets its own name.`
        : `${c.file} has the same file name as a built-in skill. Replace: the file takes the place of the built-in skill${c.source === 'edited' ? ', your edited version goes into the backup' : ''}, “Reset” brings the original back. Import as a copy: the file gets its own name.`;
      const i = await choose(win, { title: 'Import skills', message: `“${c.title}” (${c.id}.md) already exists.`, detail, buttons: ['Replace', 'Import as a copy', 'Skip'] });
      return i === 0 ? 'replace' : i === 1 ? 'copy' : 'skip';
    });
    for (const [id, h] of Object.entries(r.bases)) setSkillBase(id, h);
    return { id: r.ids[0], imported: r.ids, warnings: r.warnings, backup: r.backups[0] ?? null };
  }));
  ipcMain.handle('library:setDefault', (_e, id: unknown, mode: unknown) => libDo(() => {
    const s = isSkillId(id) ? librarySkill(skillDirs(), id) : undefined;
    if (!s) throw new Error('This skill does not exist (any more).');
    if (!isSkillMode(mode)) throw new Error(`Unknown level “${String(mode)}”.`);
    setSkillDefault(s.id, mode, s.defaultMode);
    return { id: s.id };
  }));
  ipcMain.handle('library:reveal', async (_e, id: unknown) => {
    const file = typeof id === 'string' ? ownFile(skillDirs(), id) : null;
    if (process.env.SOMA_TEST === '1') return;
    if (file) { host().shell.showItemInFolder(file); return; }
    fs.mkdirSync(userSkillsDir(), { recursive: true });
    await host().shell.openPath(userSkillsDir());
  });

  // Einstellungen der App (E81)
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    try { return writeSettings(patch); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), ...readSettings() }; }
  });
  ipcMain.handle('storage:stats', () => storageStats());
  ipcMain.handle('storage:open', async (_e, area: unknown): Promise<FileOpResult> => {
    if (!isStorageArea(area)) return { ok: false, error: 'Unknown folder.' };
    const p = areaDir(area);
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (process.env.SOMA_TEST === '1') return { ok: true, path: p };
    const err = await host().shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true, path: p };
  });
  ipcMain.handle('storage:clearPreviews', async (): Promise<StorageClear> => {
    const keep = ctl.session?.id ?? null;
    const c = await choose(win, {
      title: 'Clear preview cache',
      message: 'Clear the preview cache?',
      detail: `Previews of older versions are created again when you open them in the history. ${keep ? 'Those of the open model stay. ' : ''}Your models and their history are not affected.`,
      buttons: ['Clear', 'Cancel'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    try {
      const r = await clearPreviews(keep);
      return { ok: !r.failed, freed: r.freed, kept: r.kept, stats: await storageStats(), ...(r.failed ? { error: `${r.failed} folder${r.failed === 1 ? '' : 's'} could not be removed (still in use).` } : {}) };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('gpu:webglFailed', () => false);
  ipcMain.handle('about:info', () => aboutInfo(agents));
  // Nur wenn die Einstellung es erlaubt: Ausgeschaltet geht keine Anfrage ins Netz
  ipcMain.handle('updates:check', () => checkUpdate(readSettings().settings.start.updateCheck));
  ipcMain.handle('about:copy', async (): Promise<FileOpResult> => {
    const text = aboutText(await aboutInfo(agents));
    copyText(text);
    return { ok: true };
  });

  ipcMain.handle('anim:list', () => ctl.animList());
  ipcMain.handle('anim:build', (_e, file: unknown) => ctl.animBuild(file));
  ipcMain.handle('drawings:list', () => ctl.drawingList());
  ipcMain.handle('drawings:build', (_e, file: unknown) => ctl.drawingBuild(file));
  ipcMain.handle('drawings:export', (_e, what: unknown, sheet: unknown) => ctl.drawingExport(what, sheet));
  ipcMain.handle('results:list', () => ctl.results());
  ipcMain.handle('results:rerun', (_e, id: unknown) => ctl.rerunResult(id));
  ipcMain.handle('render:video', (_e, id: unknown) => ctl.renderVideo(id));
  // Rückfragen aus dem Renderer (etwa ungespeicherte Eingaben im Editor) laufen über dieselben Dialoge wie im Hauptprozess
  ipcMain.handle('dialog:choose', (_e, o: { title?: unknown; message?: unknown; detail?: unknown; buttons?: unknown }) => {
    const buttons = Array.isArray(o?.buttons) ? o.buttons.slice(0, 4).map(String) : [];
    if (!buttons.length) return -1;
    return choose(win, { title: String(o.title ?? 'SOMA'), message: String(o.message ?? ''), detail: o.detail == null ? undefined : String(o.detail), buttons });
  });

}
