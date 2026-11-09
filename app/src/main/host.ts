import type { App, Clipboard, Dialog, Shell } from 'electron';

export interface EventSink {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}
export interface Host {
  app: Pick<App, 'getPath' | 'getAppPath' | 'isPackaged'>;
  dialog: Pick<Dialog, 'showSaveDialog' | 'showOpenDialog' | 'showMessageBox'>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  clipboard: Pick<Clipboard, 'writeText'>;
  fetch: typeof fetch;
}
let configured: Host | undefined;
export function configureHost(host: Host): void { configured = host; }
export function host(): Host {
  if (!configured) throw new Error('SOMA host has not been configured.');
  return configured;
}
