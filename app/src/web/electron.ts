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
    message.textContent = 'SOMA connection interrupted. Only one browser tab can control SOMA. Save any unsent text, close other SOMA tabs, then reconnect. Reopening a model starts fresh terminal sessions; model files are kept.';
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
export const webUtils = { getPathForFile: (_file: File) => { throw new Error('Use Import to choose files on this Mac. Browser drag-and-drop is not available yet.'); } };

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
ipcRenderer.on('web:path', (_e, id, raw) => {
  if (typeof id !== 'number' || !raw || typeof raw !== 'object') return;
  const modal = document.createElement('dialog');
  modal.style.cssText = 'background:#20242c;color:#eee;border:1px solid #566070;border-radius:12px;padding:24px;max-width:700px;width:80vw';
  const title = document.createElement('h2'); title.textContent = 'title' in raw ? String(raw.title) : 'File path';
  const label = document.createElement('label'); label.textContent = 'Absolute path on the SOMA server';
  const input = document.createElement('textarea'); input.rows = 3; input.style.cssText = 'display:block;width:100%;margin:12px 0;background:#101318;color:white;padding:10px;box-sizing:border-box';
  input.value = 'defaultPath' in raw ? String(raw.defaultPath) : ''; label.append(input);
  const hint = document.createElement('p'); hint.textContent = 'On Mac this is a Mac path. In Docker use a mounted container path (for example /data/exports). For multiple files enter one path per line.';
  const ok = document.createElement('button'); ok.textContent = 'Continue';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.marginLeft = '12px';
  let result: string | null = null;
  ok.onclick = () => { result = input.value; modal.close(); }; cancel.onclick = () => modal.close();
  modal.onclose = () => { modal.remove(); void invoke('web:pathResult', id, result).catch(console.error); };
  modal.append(title, label, hint, ok, cancel); document.body.append(modal); modal.showModal(); input.focus(); input.select();
});
