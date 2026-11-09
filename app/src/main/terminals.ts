import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { EventSink } from './host';
import * as pty from 'node-pty';
import { logAgentStart } from './agents';
import { bridgeEnv } from './bridge';
import { envPaths } from './packages';
import { gitCmdDir, pythonBinDirs, pythonEnv, userDataDir } from './paths';

/**
 * Umgebung fuer Terminals: vorn im PATH die Projektumgebung (E67, `python` sieht Basis und Zusatzpakete), dahinter die
 * Basisumgebung (`pip`, `soma`). PIP_PYTHON leitet jedes pip in die Projektumgebung, die Basis bleibt unverändert. Dazu
 * Adresse und Schluessel der App fuer `soma render` (E58).
 */
export function terminalEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = pythonEnv({ SOMA_PROJECT: projectDir, ...bridgeEnv() });
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const pe = envPaths(projectDir);
  const front: string[] = [pe.scripts];
  env.VIRTUAL_ENV = pe.env;
  env.PIP_PYTHON = pe.python;
  front.push(...pythonBinDirs());
  const git = gitCmdDir(); // das mitgelieferte Git hat Vorrang vor einem Git des Systems
  if (git) front.push(git);
  env[key] = [...front, env[key] ?? ''].join(path.delimiter);
  return env;
}

/**
 * Nummern der Terminals, fortlaufend über alle Projekte. Beim Modellwechsel endet die alte Shell erst nach dem Wechsel,
 * ihre Daten und ihr „beendet“ kommen dann noch an. Finge jedes Projekt wieder bei 1 an, landeten sie beim neuen Terminal
 * mit derselben Nummer: Es galt als beendet, und Auswahl oder Markierung ließen sich nicht mehr einfügen.
 */
let nextId = 1;

/** Verwaltet die Terminals eines Projekts. Jedes ist eine normale Shell im Projektordner (E19). */
export class TerminalManager {
  private terms = new Map<number, pty.IPty>();
  /** Getippte Zeile je Terminal, nur um einen von Hand gestarteten Agenten zu protokollieren (track). null: unzuverlässig. */
  private typed = new Map<number, string | null>();

  constructor(private readonly wc: EventSink, private readonly dir: string) {}

  has(id: number): boolean { return this.terms.has(id); }

  private resumeFile(): string {
    const key = crypto.createHash('sha256').update(path.resolve(this.dir)).digest('hex');
    return path.join(userDataDir(), 'terminal-resume', `${key}.json`);
  }
  private rememberCodex(command: string): void {
    if (process.env.SOMA_WEB !== '1' || !/^codex(?:\s|$)/.test(command.trim())) return;
    const file = this.resumeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agent: 'codex' }), { mode: 0o600 });
  }
  private resumeCommand(): string | undefined {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.resumeFile(), 'utf8'));
      if (value && typeof value === 'object' && 'agent' in value && value.agent === 'codex') return 'codex resume --last --no-alt-screen';
    } catch { /* No recorded agent for this model. */ }
    return undefined;
  }

  create(opts: { command?: string; restore?: boolean } = {}): number {
    const command = opts.command || (opts.restore && process.env.SOMA_WEB === '1' ? this.resumeCommand() : undefined);
    const win = process.platform === 'win32';
    const shell = win ? 'powershell.exe' : (process.env.SHELL || 'bash');
    let p: pty.IPty;
    try {
      p = pty.spawn(shell, win ? ['-NoLogo'] : [], {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: this.dir, env: terminalEnv(this.dir) as Record<string, string>,
      });
    } catch (e) {
      console.error('[terminal]', e);
      throw new Error(`Could not start the terminal (${shell}): ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = nextId++;
    this.terms.set(id, p);
    if (command) { logAgentStart(command, 'button', terminalEnv(this.dir)); this.rememberCodex(command); }
    p.onData((d) => { if (!this.wc.isDestroyed()) this.wc.send('term:data', id, d); });
    p.onExit(({ exitCode }) => {
      this.terms.delete(id);
      this.typed.delete(id);
      if (!this.wc.isDestroyed()) this.wc.send('term:exit', id, exitCode);
    });
    // Ein Startbefehl (z. B. der Agent) wird sichtbar in die Shell getippt. Endet er, bleibt die Shell offen.
    if (command) setTimeout(() => { if (this.terms.has(id)) p.write(command + '\r'); }, 400);
    return id;
  }

  write(id: number, data: string): void {
    const p = this.terms.get(id);
    if (!p) return;
    p.write(data);
    this.track(id, data);
  }

  /**
   * Erkennt, wenn der Nutzer einen bekannten Agenten selbst in die Shell tippt, für das Protokoll. Nur grob: Pfeiltasten,
   * Verlauf, Tab-Ergänzung oder Einfügen machen die Zeile unzuverlässig, sie zählt dann nicht. Als Agentenstart gilt nur
   * der Befehl allein oder mit Optionen (`claude`, `codex --resume`), damit Text an einen laufenden Agenten, der zufällig
   * mit seinem Namen beginnt, nicht mitzählt. Getippter Text selbst kommt nie ins Protokoll.
   */
  private track(id: number, data: string): void {
    let line = this.typed.get(id) ?? '';
    let ok = this.typed.get(id) !== null;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const t = line.trim();
        if (ok) this.rememberCodex(t);
        if (ok && t && /^\S+(\s+-.*)?$/.test(t)) logAgentStart(t, 'typed', terminalEnv(this.dir));
        line = ''; ok = true;
      } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
      else if (ch === '\x03') { line = ''; ok = true; }
      else if (ch === '\x1b' || ch === '\t') ok = false;
      else if (ch >= ' ' && line.length < 200) line += ch;
    }
    this.typed.set(id, ok ? line : null);
  }

  resize(id: number, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) { try { this.terms.get(id)?.resize(cols, rows); } catch { /* Terminal schon beendet */ } }
  }
  kill(id: number): void { try { this.terms.get(id)?.kill(); } catch { /* schon beendet */ } this.terms.delete(id); this.typed.delete(id); }
  killAll(): void { for (const id of [...this.terms.keys()]) this.kill(id); }

  /**
   * Beendet alle Terminals und wartet, bis ihre Shells wirklich weg sind (höchstens `ms`). Unter Windows endet eine Shell
   * erst eine Weile nach kill() (node-pty sucht dafür erst die Prozesse der Konsole), bis dahin hält sie den Ordner fest.
   */
  killAllAndWait(ms = 10000): Promise<void> {
    const exited = Promise.all([...this.terms.values()].map((p) => new Promise<void>((r) => p.onExit(() => r()))));
    this.killAll();
    return Promise.race([exited.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
  }
}
