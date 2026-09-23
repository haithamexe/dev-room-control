import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import type { Project } from '../../core/src/index.ts';
import { redactText, scrubInputs } from '../../core/src/redact.ts';
import { authSecrets } from '../../runner/src/browser.ts';
import { Store, id, now } from '../../storage/src/index.ts';

export type CommandRun = { id: string; projectId: string; taskId: string; kind: 'command'; name: string; status: 'running' | 'passed' | 'failed' | 'stopped'; ownerPid: number; pid?: number; startedAt: string; endedAt?: string; exitCode?: number | null; output: string; truncated: boolean };
export class CommandProcesses {
  stopping = new Set<string>();
  children = new Map<string, ChildProcess>();
  constructor(private store: Store) {}
  start(project: Project, taskId: string, name: string, command: string) {
    if (this.children.size >= 4) throw new Error('Four workspace commands are already running');
    const referenced = this.store.list<import('../../core/src/index.ts').Flow>('flows', project.id).flatMap(flow => flow.steps.flatMap(step => 'env' in step && step.env ? [process.env[step.env] || ''] : []));
    const secrets = [...referenced, ...authSecrets(project), ...Object.entries(process.env).filter(([key]) => /token|password|secret|api.?key|cookie|authorization|^DCR_INPUT_/i.test(key) || project.config.redactFields.includes(key)).map(([, value]) => value || '')].flatMap(value => value.split(/\r?\n/)).filter(Boolean);
    const record: CommandRun = { id: id(), projectId: project.id, taskId, kind: 'command', name, status: 'running', ownerPid: process.pid, startedAt: now(), output: '', truncated: false };
    const child = spawn(command, { cwd: project.path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid; this.children.set(record.id, child); this.store.put('environments', record);
    const append = (text: string) => {
      if (record.output.length >= 64000) { record.truncated = true; return; }
      const normalized = stripVTControlCharacters(text);
      const clean = project.config.redactFields.some(field => field && normalized.toLowerCase().includes(field.toLowerCase())) ? '[Configured private output omitted]\n' : redactText(scrubInputs(normalized, secrets));
      const remaining = 64000 - record.output.length; record.output += clean.slice(0, remaining); if (clean.length > remaining) record.truncated = true;
      this.store.put('environments', record);
    };
    const flushers: (() => void)[] = [];
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder('utf8'); let pending = '', dropping = false;
      const consume = (text: string, end = false) => {
        pending += text;
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at + 1); pending = pending.slice(at + 1); if (!dropping && line.length <= 16000) append(line); else { record.truncated = true; append('[Oversized output line omitted]\n'); } dropping = false; }
        if (pending.length > 16000) { pending = ''; dropping = true; record.truncated = true; }
        if (end) { if (pending && !dropping) append(pending); pending = ''; }
      };
      stream.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
      flushers.push(() => consume(decoder.end(), true));
    }
    child.on('error', () => append('The command could not be started.\n'));
    child.on('close', code => { flushers.forEach(flush => flush()); this.children.delete(record.id); record.status = this.stopping.delete(record.id) ? 'stopped' : code === 0 ? 'passed' : 'failed'; record.exitCode = code; record.endedAt = now(); this.store.put('environments', record); });
    return record;
  }
  async stop(id: string) {
    const child = this.children.get(id); if (!child?.pid) throw new Error('Command is not running in this service');
    if (this.stopping.has(id)) throw new Error('Command is already stopping');
    const closed = once(child, 'close');
    this.stopping.add(id);
    try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', reject); killer.once('close', code => code === 0 || !this.children.has(id) ? resolve() : reject(new Error('Unable to stop command process tree'))); });
    } else child.kill('SIGTERM');
    await closed;
    } catch (error) { this.stopping.delete(id); throw error; }
    // Re-read after process exit to avoid overwriting final output with an older snapshot.
    const record = this.store.get<CommandRun>('environments', id); record.status = 'stopped'; this.store.put('environments', record); return record;
  }
  async close() { await Promise.allSettled([...this.children.keys()].map(id => this.stop(id))); }
}
