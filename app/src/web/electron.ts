type Listener = (event: undefined, ...args: unknown[]) => void;
const listeners = new Map<string, Listener[]>();
const client = crypto.randomUUID();
const events = new EventSource(`/events?client=${client}`);
let disconnected = false;
let terminalCreates = 0;
const pendingTerminalEvents: Array<{ channel: string; args: unknown[] }> = [];
const dispatch = (channel: string, args: unknown[]) => {
  for (const fn of listeners.get(channel) || []) fn(undefined, ...args);
};
const connected = new Promise<void>((resolve, reject) => {
  events.onopen = () => resolve();
  events.onerror = () => {
    events.close(); disconnected = true;
    reject(new Error('Browser connection failed.'));
    document.title = 'SOMA — connection interrupted';
    const panel = document.createElement('div');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-label', 'SOMA connection interrupted');
    panel.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#101318ee;display:grid;place-content:center;padding:40px;gap:16px;font:16px system-ui;color:white';
    const message = document.createElement('p');
    message.textContent = 'SOMA connection interrupted. Only one browser tab can control SOMA. Save any unsent text, close other SOMA tabs, then reconnect. Reopen the model to resume its last Codex conversation. Unsaved shell input is not restored; model files are kept.';
    message.style.maxWidth = '600px';
    const button = document.createElement('button');
    button.textContent = 'Reconnect'; button.style.cssText = 'padding:14px;background:#eea04b;color:#111;border-radius:8px';
    button.onclick = () => location.reload();
    panel.append(message, button); document.body.append(panel);
  };
});
// Initial page calls also report their errors; avoid an unhandled connection rejection.
void connected.catch(() => {});
events.onmessage = (event) => {
  const data: unknown = JSON.parse(event.data);
  if (!data || typeof data !== 'object' || !('channel' in data) || typeof data.channel !== 'string' || !('args' in data) || !Array.isArray(data.args)) return;
  if (terminalCreates && (data.channel === 'term:data' || data.channel === 'term:exit')) {
    pendingTerminalEvents.push({ channel: data.channel, args: data.args }); return;
  }
  dispatch(data.channel, data.args);
};
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  await connected;
  if (disconnected) throw new Error('SOMA is disconnected. Reconnect first.');
  if (channel === 'term:create') terminalCreates++;
  try {
    const res = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Soma-Web': '1', 'X-Soma-Client': client }, body: JSON.stringify({ channel, args }) });
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') throw new Error('Invalid server response');
    if (!res.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : 'Request failed');
    const value: unknown = 'value' in data ? data.value : undefined;
    if (value && typeof value === 'object' && '__binary' in value && typeof value.__binary === 'string') {
      return Uint8Array.from(atob(value.__binary), c => c.charCodeAt(0)).buffer;
    }
    return value;
  } finally {
    // The terminal tab is registered in the await continuation, before this task.
    if (channel === 'term:create') setTimeout(() => {
      terminalCreates--;
      if (!terminalCreates) for (const item of pendingTerminalEvents.splice(0)) dispatch(item.channel, item.args);
    }, 0);
  }
}
let writes: Promise<unknown> = Promise.resolve();
export const ipcRenderer = {
  invoke,
  send: (channel: string, ...args: unknown[]) => {
    // Preserve PTY keystroke/paste/resize order across independent HTTP requests.
    writes = writes.then(() => invoke(channel, ...args)).catch(console.error);
  },
  on: (channel: string, fn: Listener) => { listeners.set(channel, [...listeners.get(channel) || [], fn]); },
};
export const contextBridge = { exposeInMainWorld: (name: string, api: unknown) => Object.defineProperty(window, name, { value: api }) };
export const webUtils = { getPathForFile: (_file: File) => { throw new Error('Use Import to upload local files. Browser drag-and-drop is not available yet.'); } };

function showLocation(title: string, value: string): void {
  const modal = document.createElement('dialog');
  modal.style.cssText = 'background:#20242c;color:#eee;border:1px solid #566070;border-radius:12px;padding:24px;max-width:700px;width:80vw';
  const heading = document.createElement('h2'); heading.textContent = title;
  const text = document.createElement('p'); text.textContent = value; text.style.overflowWrap = 'anywhere';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => modal.close();
  modal.append(heading, text, close); modal.onclose = () => modal.remove(); document.body.append(modal); modal.showModal();
}
ipcRenderer.on('web:location', (_e, value) => showLocation('Location on the SOMA server', String(value)));
ipcRenderer.on('web:clipboard', (_e, value) => {
  if (typeof value === 'string') void navigator.clipboard.writeText(value).catch(() => showLocation('Copy this text', value));
});
ipcRenderer.on('web:openUrl', (_e, value) => {
  if (typeof value !== 'string' || !/^(https?:\/\/|mailto:)/i.test(value)) return;
  const modal = document.createElement('dialog');
  const link = document.createElement('a'); link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = value;
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => modal.close();
  modal.append(link, close); modal.onclose = () => modal.remove(); document.body.append(modal); modal.showModal();
});
ipcRenderer.on('web:downloads', (_e, value) => {
  if (!Array.isArray(value)) return;
  const modal = document.createElement('dialog');
  modal.style.cssText = 'background:#20242c;color:#eee;border:1px solid #566070;border-radius:12px;padding:24px;max-width:700px;width:80vw';
  const title = document.createElement('h2'); title.textContent = 'Files ready to download'; modal.append(title);
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.url !== 'string' || !/^\/download\/[a-f0-9]{48}$/.test(item.url)) continue;
    const link = document.createElement('a'); link.href = item.url; link.download = item.name;
    link.textContent = `Download ${item.name}`; link.style.cssText = 'display:block;color:#f2aa55;padding:10px';
    modal.append(link);
  }
  const note = document.createElement('p'); note.textContent = 'Links expire in 30 minutes or when the server restarts. Export again to get new links.';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => modal.close();
  modal.append(note, close); modal.onclose = () => modal.remove(); document.body.append(modal); modal.showModal();
});
ipcRenderer.on('web:path', (_e, id, raw) => {
  if (typeof id !== 'number' || !raw || typeof raw !== 'object') return;
  const save = 'save' in raw && raw.save === true;
  const directory = 'directory' in raw && raw.directory === true;
  const modal = document.createElement('dialog');
  modal.style.cssText = 'background:#20242c;color:#eee;border:1px solid #566070;border-radius:12px;padding:24px;max-width:700px;width:80vw';
  const title = document.createElement('h2'); title.textContent = 'title' in raw ? String(raw.title) : 'Files';
  const label = document.createElement('label'); label.textContent = save ? 'Download file name' : 'Absolute folder path on the SOMA server';
  const input = document.createElement('input'); input.type = 'text';
  input.style.cssText = 'display:block;width:100%;margin:12px 0;background:#101318;color:white;padding:10px;box-sizing:border-box';
  input.value = 'defaultPath' in raw ? String(raw.defaultPath) : ''; label.append(input);
  const picker = document.createElement('input'); picker.type = 'file'; picker.setAttribute('aria-label', 'Choose files to upload');
  picker.multiple = 'multiple' in raw && raw.multiple === true;
  picker.accept = 'accept' in raw ? String(raw.accept) : '';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  status.textContent = save ? 'After exporting, download the file directly in this browser.' : directory ? 'This path is on the server, not your browser computer.' : 'Choose local files. Maximum 100 MiB per file, 20 files at a time.';
  const ok = document.createElement('button'); ok.textContent = save ? 'Export' : directory ? 'Continue' : 'Upload and open';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.marginLeft = '12px';
  let result: string | null = null;
  const abort = new AbortController();
  ok.onclick = async () => {
    if (save || directory) { result = input.value; modal.close(); return; }
    const chosen = Array.from(picker.files || []);
    if (!chosen.length || chosen.length > 20 || chosen.some(f => f.size > 100 * 1024 * 1024)) { status.textContent = 'Choose 1–20 files, each no larger than 100 MiB.'; return; }
    ok.disabled = true; picker.disabled = true;
    try {
      const paths: string[] = [];
      for (const file of chosen) {
        status.textContent = `Uploading ${paths.length + 1}/${chosen.length}: ${file.name}`;
        const response = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'X-Soma-Web': '1', 'X-Soma-Client': client, 'Content-Type': 'application/octet-stream' }, body: file, signal: abort.signal,
        });
        const body: unknown = await response.json();
        if (!response.ok || !body || typeof body !== 'object' || !('path' in body) || typeof body.path !== 'string') {
          throw new Error(body && typeof body === 'object' && 'error' in body ? String(body.error) : 'Upload failed');
        }
        paths.push(body.path);
      }
      result = paths.join('\n'); modal.close();
    } catch (error) { if (!abort.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Upload failed'; }
    finally { ok.disabled = false; picker.disabled = false; }
  };
  cancel.onclick = () => modal.close();
  modal.onclose = () => { abort.abort(); modal.remove(); void invoke('web:pathResult', id, result).catch(console.error); };
  modal.append(title, save || directory ? label : picker, status, ok, cancel);
  document.body.append(modal); modal.showModal();
  if (save || directory) { input.focus(); input.select(); } else picker.focus();
});

contextBridge.exposeInMainWorld('somaWebRendering', { on: ipcRenderer.on, invoke, client });

window.addEventListener('DOMContentLoaded', () => {
  const button = document.createElement('button'); button.textContent = 'Render / FEM'; button.title = 'Export PNG or run a FEM study';
  document.getElementById('btn-export')?.after(button);
  button.onclick = async () => {
    const panel = document.createElement('dialog'); panel.style.cssText = 'background:#20242c;color:#eee;border:1px solid #566070;border-radius:12px;padding:24px;width:480px';
    const heading = document.createElement('h2'); heading.textContent = 'Render and FEM';
    const select = document.createElement('select'); select.setAttribute('aria-label', 'PNG content');
    select.add(new Option('Model — isometric PNG', ''));
    const png = document.createElement('button'); png.textContent = 'Export PNG';
    const study = document.createElement('input'); study.placeholder = 'analyses/study.py'; study.setAttribute('aria-label', 'FEM study path');
    const fem = document.createElement('button'); fem.textContent = 'Run FEM';
    const note = document.createElement('p'); note.textContent = 'FEM uses a Python study defining material, loads and supports. Open Analysis after calculation. For video, open Animation and choose Make video. Rendering requires this browser to stay connected.';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => panel.close();
    const refresh = async () => {
      const results = await invoke('results:list');
      while (select.options.length > 1) select.remove(1);
      if (Array.isArray(results)) for (const r of results) if (r && typeof r === 'object' && typeof r.file === 'string' && typeof r.title === 'string') select.add(new Option(`Analysis — ${r.title}`, r.file));
    };
    const run = async (channel: string, argument: string) => {
      png.disabled = fem.disabled = close.disabled = true; status.textContent = channel === 'web:fem' ? 'FEM running… Large meshes may take several minutes.' : 'Rendering…';
      try {
        const r = await invoke(channel, argument);
        if (!r || typeof r !== 'object' || !('ok' in r) || !r.ok) throw new Error(r && typeof r === 'object' && 'error' in r ? String(r.error) : 'Operation failed');
        status.textContent = channel === 'web:fem' ? 'FEM complete. Open Analysis to inspect the result.' : 'PNG saved. Use the download links.';
        if ('warnings' in r && Array.isArray(r.warnings) && r.warnings.length) status.textContent += ' ' + r.warnings.join(' ');
        await refresh();
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { png.disabled = fem.disabled = close.disabled = false; }
    };
    png.onclick = () => void run('web:still', select.value);
    fem.onclick = () => void run('web:fem', study.value.trim());
    panel.append(heading, select, png, document.createElement('hr'), study, fem, note, status, close);
    panel.onclose = () => panel.remove(); document.body.append(panel); panel.showModal();
    try { await refresh(); } catch (error) { status.textContent = String(error); }
  };
});
