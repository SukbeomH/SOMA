import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

async function load(entry, globals) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'cjs', write: false });
  const context = vm.createContext({ module: { exports: {} }, ...globals });
  vm.runInContext(result.outputFiles[0].text, context);
  return context.module.exports;
}

const navigator = {};
const { writeClipboardText } = await load('src/renderer/clipboard.ts', { navigator });
// A missing API must return a rejected promise, not throw before .catch can run.
let pending;
assert.doesNotThrow(() => { pending = writeClipboardText('path/model.py'); });
await assert.rejects(pending, /HTTPS or localhost/);
let copied;
navigator.clipboard = { async writeText(text) { copied = text; } };
await writeClipboardText('path/model.py');
assert.equal(copied, 'path/model.py');
navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); };
await assert.rejects(writeClipboardText('secret'), /Permission denied/);

// Exercise the actual terminal key handler without a secure-context Clipboard API.
delete navigator.clipboard;
const { terminalImages } = await load('src/renderer/terminal-images.ts', { navigator, window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController });
const handlers = new Map();
const pane = { addEventListener(name, callback) { handlers.set(name, callback); }, removeEventListener(name) { handlers.delete(name); } };
const images = terminalImages(pane, {}, 1, () => true);
for (const type of ['keydown', 'keypress', 'keyup']) {
  let prevented = false;
  const event = { type, key: 'v', ctrlKey: true, preventDefault() { prevented = true; } };
  assert.equal(images.key(event), false, 'Do not send Ctrl+V to PTY');
  assert.equal(prevented, false, 'Allow browser Paste to supply text/images');
}
let prevented = false;
handlers.get('paste')({ clipboardData: { items: [] }, preventDefault() { prevented = true; } });
assert.equal(prevented, false, 'Leave text paste for xterm');
images.dispose();
assert.equal(handlers.size, 0);
console.log('PASS: missing/denied clipboard fallback, successful copy, native HTTP Ctrl+V and text paste');
