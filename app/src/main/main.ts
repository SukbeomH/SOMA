import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, net, type WebContents } from 'electron';
import fs from 'node:fs';
import { configureHost } from './host';
import { registerRpc, testClipboard } from './rpc';
import { RenderService } from './render';
import path from 'node:path';
import { osName } from './about';
import { bridgeEnv, startBridge, stopBridge } from './bridge';
import { stopWarm, warmUp } from './build';
import { choose, setDialogHost, setTestAnswers, type ChooseOptions } from './dialogs';
import { ProjectController } from './projects';
import { initLog, log } from './log';
import { adoptLoginShellPath, appIcon, logsDir, pythonExe, skillDirs, userDataDir } from './paths';
import { SOMA_VERSION } from '../shared/version';
import { renameOldSkillFiles } from './skilllibrary';
import { createProject, getLastProject, sweepDiscarded } from './workspace';

configureHost({ app, dialog, shell, clipboard, fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init) });

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.SOMA_USER_DATA) app.setPath('userData', process.env.SOMA_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'soma'));

// Protokoll (log.ts) so früh wie möglich: Auch Fehler beim Start sollen drinstehen
initLog(logsDir(), {
  version: SOMA_VERSION, system: `${osName()} ${process.arch}`, electron: process.versions.electron,
  packaged: app.isPackaged ? 'yes' : 'no (development)', python: pythonExe(), appData: userDataDir(),
});

/**
 * Linux ohne nutzbaren Grafiktreiber (VM, Remote-Desktop, xvfb): Chromium sperrt WebGL auf dem Software-Renderer llvmpipe,
 * ohne WebGL gibt es keinen Viewer. Bekommt der Viewer keinen Kontext, meldet das Fenster es (gpu:webglFailed), die App
 * merkt es sich in den App-Daten und übergeht ab dann bei jedem Start die Sperrliste. Der Merker statt einer Prüfung beim
 * Start: Der Status von Electron ist vor dem ersten Fenster nicht verlässlich (auf einem Rechner mit Grafikkarte meldete er
 * alles als aus). Ein Rechner, der den Merker zu Unrecht hat, verliert nichts: Ohne Sperre rendert die Grafikkarte weiter.
 */
const softwareGlFlag = () => path.join(app.getPath('userData'), 'software-gl');
if (process.platform === 'linux' && fs.existsSync(softwareGlFlag())) app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win: BrowserWindow | null = null;
/** Für Anfragen aus den Terminals (bridge.ts): das Projekt des Fensters. */
let controller: ProjectController | null = null;

/**
 * Anfragen des Renderers mit der Antwort `{ ok: false, error }` ins Protokoll (log.ts), abgebrochene Rückfragen nicht.
 * Sonst sähe nur der Nutzer die Meldung, im Protokoll fehlte sie. Ein Wrapper um ipcMain.handle statt an jedem der vielen
 * Handler. Ausnahmen protokolliert Electron selbst über console.error („Error occurred in handler for …“, mit Stack), die
 * landen so schon im Protokoll.
 */
function logIpcFailures(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    handle(channel, async (e, ...args) => {
      const r: unknown = await fn(e, ...args);
      const o = r as { ok?: unknown; error?: unknown; canceled?: unknown } | null;
      if (o && typeof o === 'object' && o.ok === false && o.error && !o.canceled) log('WARN', `[${channel}] ${String(o.error)}`);
      return r;
    });
  };
}

function registerIpc(ctl: ProjectController): void {
  registerRpc(ctl, { handle: (channel, fn) => ipcMain.handle(channel, (e, ...args: unknown[]) => Reflect.apply(fn, undefined, [e, ...args])), on: (channel, fn) => ipcMain.on(channel, (e, ...args: unknown[]) => Reflect.apply(fn, undefined, [e, ...args])) }, win);
  ipcMain.removeHandler('gpu:webglFailed');
  // Antwort true: Die App startet mit Software-Rendering neu. false: Das hilft hier nicht (anderes System, schon versucht).
  ipcMain.handle('gpu:webglFailed', () => {
    if (process.platform !== 'linux' || app.commandLine.hasSwitch('ignore-gpu-blocklist')) return false;
    try { fs.writeFileSync(softwareGlFlag(), 'WebGL was unavailable, SOMA starts with --ignore-gpu-blocklist.\n'); } catch { return false; }
    console.log('[gpu] no WebGL context, restarting with --ignore-gpu-blocklist (software rendering)');
    setTimeout(() => { app.relaunch(); app.exit(0); }, 1500); // Zeit, die Meldung im Fenster zu lesen
    return true;
  });
  // Nur im Testmodus: vorbereitete Antworten für Dialoge (siehe dialogs.ts)
  if (process.env.SOMA_TEST === '1') {
    ipcMain.handle('test:answers', (_e, a: unknown[]) => setTestAnswers(a));
    // Adresse und Schlüssel für soma render, damit Tests es auch außerhalb eines Terminals aufrufen können
    ipcMain.handle('test:bridge', () => bridgeEnv());
    ipcMain.handle('test:clipboard', () => testClipboard);
    // Fenster schließen wie mit dem Kreuz (mit Rückfrage und Verlassen des Modells). window.close() der Seite umgeht das
    ipcMain.handle('test:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
    // Screenshot auch aus unsichtbaren Fenstern (CDP liefert dort kein Bild)
    // `rect` (in CSS-Pixeln): nur dieser Ausschnitt, etwa für die Bilder der Hilfe (test/helpshots.mjs)
    // capturePage(rect) liefert bei Fenstern außerhalb des Bildschirms das ganze Bild, deshalb danach zuschneiden
    ipcMain.handle('test:screenshot', async (e, file: string, rect?: Electron.Rectangle) => {
      let img = await e.sender.capturePage();
      const css = BrowserWindow.fromWebContents(e.sender)?.getContentBounds().width;
      if (rect && css) {
        const f = img.getSize().width / css;
        img = img.crop({ x: Math.round(rect.x * f), y: Math.round(rect.y * f), width: Math.round(rect.width * f), height: Math.round(rect.height * f) });
      }
      fs.writeFileSync(file, img.toPNG());
      return img.getSize();
    });
  }
}

function onRendererGone(wc: WebContents, reason: string, exitCode: number): void {
  console.error(`[soma] Renderer process ended: reason=${reason} code=${exitCode}`);
  if (reason === 'launch-failed' && process.env.SOMA_HIDDEN !== '1') {
    // Häufigste Ursache unter Windows: das Programm liegt auf einem Netzlaufwerk. Die sandboxed Prozesse laufen mit
    // eingeschränktem Token, verlieren dort den Zugriff und starten nicht. Ohne Meldung bliebe nur ein schwarzes Fenster.
    dialog.showErrorBox('SOMA cannot start its user interface',
      `The display process could not be started (code ${exitCode}).\n\nA common cause: the program is on a network drive. ` +
      'Install or start it from a local disk (for example C:).');
    app.quit();
  }
  void wc;
}

let editorReq = 0;
/**
 * Fragt den Editor im Renderer: `status` (welche Dateien ungespeichert sind), `save` (speichern), `discard` (verwerfen,
 * vorher sichern). Antwortet er nicht in 5 s, gilt `fallback`.
 */
function askEditor<T>(wc: WebContents, action: 'status' | 'save' | 'discard', fallback: T): Promise<T> {
  return new Promise((resolve) => {
    if (wc.isDestroyed()) { resolve(fallback); return; }
    const id = ++editorReq;
    const done = (_e: unknown, rid: number, result: unknown) => {
      if (rid !== id) return;
      clearTimeout(timer);
      ipcMain.removeListener('editor:res', done);
      resolve((result ?? fallback) as T);
    };
    const timer = setTimeout(() => { ipcMain.removeListener('editor:res', done); resolve(fallback); }, 5000);
    ipcMain.on('editor:res', done);
    wc.send('editor:req', id, action);
  });
}

/** Tests: SOMA_HIDDEN=1 unsichtbar (zeichnet nicht neu), =offscreen angezeigt, aber weit außerhalb des Bildschirms und ohne Fokus. */
const testWindowMode = process.env.SOMA_HIDDEN;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600, height: 950, title: 'SOMA', icon: appIcon(), backgroundColor: '#121417', show: testWindowMode !== '1' && testWindowMode !== 'offscreen',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !testWindowMode || testWindowMode === '0', // Testfenster sollen trotzdem zeichnen
    },
  });
  win.setMenuBarVisibility(false);
  if (testWindowMode === 'offscreen') { win.setBounds({ x: -20000, y: -20000, width: 1600, height: 950 }); win.showInactive(); }
  const wc = win.webContents;
  const ctl = new ProjectController(() => win, wc, new RenderService());
  controller = ctl;
  registerIpc(ctl);
  // Stürzt der Anzeigeprozess ab, steht der Grund im Protokoll (sonst bliebe nur ein schwarzes Fenster).
  wc.on('render-process-gone', (_e, d) => onRendererGone(wc, d.reason, d.exitCode));
  wc.on('unresponsive', () => console.error('[soma] Renderer is not responding'));
  wc.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`); });
  wc.once('did-finish-load', () => {
    // Die App beginnt auf der Startseite, dort stehen die zuletzt geöffneten Modelle (E69). Ein Arbeitsstand von vor einem
    // Absturz ist dort zu finden. Nur die Tests öffnen gleich das letzte Modell, sonst ein neues (SOMA_TEST_START=home nicht).
    if (process.env.SOMA_TEST !== '1' || process.env.SOMA_TEST_START === 'home') return;
    void (async () => {
      try { await ctl.open(getLastProject() ?? (await createProject()).id); }
      catch (e) { console.error('[soma] Could not open the project:', e); }
    })();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Schließen: bei ungespeicherten Änderungen (im Modell oder im Editor) nachfragen. Der Arbeitsstand bleibt in jedem Fall erhalten.
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    void (async () => {
      const st = await askEditor<{ dirty?: string[] }>(wc, 'status', {});
      const ok = await ctl.confirmClose({
        dirty: Array.isArray(st.dirty) ? st.dirty.map(String) : [],
        save: async () => !!(await askEditor<{ ok?: boolean }>(wc, 'save', { ok: false })).ok,
        discard: async () => { await askEditor(wc, 'discard', {}); },
      });
      // Erst das Modell verlassen: Ein unverändertes neues verschwindet dabei (E69), danach erst das Fenster schließen
      if (ok) { await ctl.leave().catch(() => {}); allowClose = true; win?.close(); }
    })();
  });
  win.on('closed', () => { ctl.close(); ctl.renders.close(); controller = null; win = null; });
  hostDialogs(wc);
}

/**
 * Rückfragen (dialogs.ts choose) zeigt der Renderer selbst an, sobald er sich bereit meldet. Lädt er neu oder stürzt ab,
 * bekommen offene Fragen `null` und landen im Dialog des Systems: Eine Rückfrage darf nie ohne Antwort hängen bleiben.
 */
function hostDialogs(wc: WebContents): void {
  let next = 0;
  const pending = new Map<number, (i: number | null) => void>();
  const drop = () => { setDialogHost(null); for (const r of pending.values()) r(null); pending.clear(); };
  const onReady = (e: Electron.IpcMainEvent) => {
    if (e.sender !== wc) return;
    setDialogHost((o: ChooseOptions) => new Promise((resolve) => {
      if (wc.isDestroyed()) { resolve(null); return; }
      const id = ++next;
      pending.set(id, resolve);
      wc.send('dialog:show', id, o);
    }));
  };
  const onRes = (e: Electron.IpcMainEvent, id: unknown, i: unknown) => {
    if (e.sender !== wc) return;
    const r = pending.get(Number(id));
    if (!r) return;
    pending.delete(Number(id));
    r(typeof i === 'number' ? i : null);
  };
  ipcMain.on('dialog:ready', onReady);
  ipcMain.on('dialog:res', onRes);
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) drop(); });
  wc.on('render-process-gone', drop);
  wc.once('destroyed', () => { drop(); ipcMain.removeListener('dialog:ready', onReady); ipcMain.removeListener('dialog:res', onRes); });
}

// Erst die Verbindung für `soma render` (E58), dann das Fenster: Die Terminals bekommen Adresse und Schlüssel beim Anlegen
app.whenReady().then(async () => {
  logIpcFailures();
  // Dunkel wie die Oberfläche: unter Windows sonst eine weiße Titelleiste, ebenso die Dialoge zum Öffnen und Speichern
  nativeTheme.themeSource = 'dark';
  adoptLoginShellPath(); // macOS und Linux: PATH wie im Terminal, sonst fehlen die Agenten
  // Python schon jetzt vorwärmen: Bis das Fenster steht und das letzte Modell offen ist, ist cadquery geladen (build.ts)
  warmUp();
  sweepDiscarded(); // Reste verworfener Modelle (E69) vom letzten Mal
  renameOldSkillFiles(skillDirs()); // eigene Fassungen unter den Kennungen bis 0.5.0 (E87)
  await startBridge(async (route, body) => {
    if (!controller) return { status: 503, body: { ok: false, error: 'The app has no window right now.' } };
    if (route === 'render') return controller.renderForAgent(body);
    return { status: 404, body: { ok: false, error: `Unknown request: ${route}` } };
  });
  createWindow();
});
app.on('window-all-closed', () => { console.log('[soma] quit'); stopBridge(); stopWarm(); app.quit(); });
