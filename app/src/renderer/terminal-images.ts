import type { Terminal } from '@xterm/xterm';
import { toast } from './ui';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;

export function terminalImages(pane: HTMLElement, terminal: Terminal, id: number, alive: () => boolean) {
  let busy = false;
  let stopped = false;
  const previews = new Set<string>();
  let currentCard: HTMLElement | undefined;
  const abort = new AbortController();
  const api = window.somaWebRendering;
  const showError = (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error');
  async function attach(files: File[]): Promise<void> {
    if (!api || busy || stopped || !alive()) return;
    if (files.length > 4) { showError('Paste up to four images at a time.'); return; }
    busy = true;
    currentCard?.remove();
    for (const url of previews) URL.revokeObjectURL(url);
    previews.clear();
    const card = document.createElement('div'); currentCard = card;
    card.setAttribute('role', 'status');
    card.style.cssText = 'position:absolute;top:8px;right:12px;z-index:10;background:#20242c;color:#eee;border:1px solid #566070;border-radius:8px;padding:10px;max-width:290px;display:flex;gap:8px;align-items:center';
    const preview = document.createElement('img'); preview.alt = 'Pasted image preview'; preview.style.cssText = 'width:48px;height:48px;object-fit:contain';
    const status = document.createElement('span'); status.textContent = 'Uploading image…';
    card.append(preview, status); pane.append(card);
    const urls: string[] = [];
    try {
      const project = await window.soma.project.current();
      if (!alive()) throw new Error('The target terminal closed. Paste again in the intended terminal.');
      const paths: string[] = [];
      for (const [index, file] of files.entries()) {
        if (file.type !== 'image/png') throw new Error('PNG clipboard images are supported. Use Import for other formats.');
        if (!file.size || file.size > MAX_BYTES) throw new Error('Clipboard images must be between 1 byte and 20 MiB.');
        const header = await file.slice(0, 24).arrayBuffer();
        if (header.byteLength < 24) throw new Error('Invalid PNG image.');
        const size = new DataView(header);
        if (size.getUint32(16) * size.getUint32(20) > MAX_PIXELS) throw new Error('Clipboard image exceeds 32 megapixels.');
        const bitmap = await createImageBitmap(file);
        const pixels = bitmap.width * bitmap.height; bitmap.close();
        if (pixels > MAX_PIXELS) throw new Error('Clipboard image exceeds 32 megapixels.');
        const url = URL.createObjectURL(file); urls.push(url); previews.add(url); preview.src = url;
        status.textContent = `Uploading image ${index + 1}/${files.length}…`;
        const res = await fetch('/upload?name=clipboard.png', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Soma-Web': '1', 'X-Soma-Client': api.client }, body: file, signal: abort.signal });
        const upload: unknown = await res.json();
        if (!res.ok || !upload || typeof upload !== 'object' || !('path' in upload) || typeof upload.path !== 'string') throw new Error('Image upload failed. Paste again to retry.');
        if (!alive() || stopped) throw new Error('Target terminal closed; image was not inserted.');
        const result = await api.invoke('web:attachImage', project.id, id, upload.path);
        if (typeof result !== 'string') throw new Error('Invalid image attachment response');
        paths.push(result);
      }
      if (!alive() || stopped) throw new Error('Target terminal closed; image was not inserted.');
      if (!terminal.modes.bracketedPasteMode) throw new Error('Image saved, but the terminal is not ready for attachment. Wait for the Codex prompt and paste again.');
      // Each path is its own bracketed paste so Codex can recognize an image attachment.
      for (const path of paths) terminal.paste(path);
      status.textContent = `${paths.length} image(s) inserted. Add a message and press Enter.`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      busy = false;
      const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss image status');
      close.onclick = () => { card.remove(); for (const url of urls) { URL.revokeObjectURL(url); previews.delete(url); } };
      card.append(close);
      if (stopped) { card.remove(); for (const url of urls) { URL.revokeObjectURL(url); previews.delete(url); } }
    }
  }
  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items || []).filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter((f): f is File => f !== null);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation(); void attach(files);
  };
  pane.addEventListener('paste', paste, true);
  async function readClipboard(textFallback: boolean): Promise<void> {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) if (item.types.includes('image/png')) files.push(new File([await item.getType('image/png')], 'clipboard.png', { type: 'image/png' }));
      if (files.length) await attach(files);
      else if (textFallback) { const text = await navigator.clipboard.readText(); if (alive() && !stopped) terminal.paste(text); }
      else showError('No PNG image on the clipboard. Copy an image or use Import.');
    } catch {
      if (textFallback) {
        try { const text = await navigator.clipboard.readText(); if (text && alive() && !stopped) { terminal.paste(text); return; } } catch { /* Show the paste alternative below. */ }
      }
      showError('Clipboard access unavailable. Try ⌘V / browser Paste, or use Import.');
    }
  }
  return {
    readClipboard,
    key: (event: KeyboardEvent): boolean => {
      if (busy && event.key === 'Enter') { event.preventDefault(); return false; }
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'v') {
        // Let the browser dispatch its native paste event on plain HTTP.
        // Returning false stops xterm from sending ^V, without cancelling browser Paste.
        if (!navigator.clipboard?.readText) return false;
        event.preventDefault(); if (event.type === 'keydown') void readClipboard(true); return false;
      }
      return true;
    },
    dispose: () => { stopped = true; abort.abort(); currentCard?.remove(); for (const url of previews) URL.revokeObjectURL(url); previews.clear(); pane.removeEventListener('paste', paste, true); },
  };
}
