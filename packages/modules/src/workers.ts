import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Store, now } from '../../storage/src/index.ts';
import type { Project, Run } from '../../core/src/index.ts';

export class RunWorkers {
  children = new Map<string, ChildProcess>();
  constructor(private store: Store) {}
  start(project: Project, run: Run): Promise<Run> {
    const entry = process.env.DCR_WORKER_ENTRY || resolve('packages/runner/src/worker.ts');
    const child = fork(entry, [], { execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [], env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    run.ownerPid = child.pid; this.store.put('runs', run); this.children.set(run.id, child);
    let cancelled = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.cancel(run.id); }, project.config.execution.timeoutMs);
    return new Promise<Run>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        clearTimeout(timer); this.children.delete(run.id);
        const saved = this.store.get<Run>('runs', run.id);
        if (saved.status === 'running' || timedOut) { saved.status = timedOut ? 'failed' : cancelled ? 'cancelled' : 'failed'; saved.error = timedOut ? 'Run exceeded its configured time limit' : cancelled ? 'Cancelled by user' : 'Runner process exited before completing'; saved.endedAt = now(); this.store.put('runs', saved); }
        resolve(saved);
      };
      child.once('error', finish); child.once('exit', finish);
      child.on('message', () => {});
      const mark = () => { cancelled = true; }; (child as any).markCancelled = mark;
      child.send({ type: 'start', root: this.store.root, runId: run.id, project });
    });
  }
  cancel(runId: string) {
    const child = this.children.get(runId); if (!child) throw new Error('This run is not owned by the current service');
    (child as any).markCancelled?.(); if (child.connected) child.send({ type: 'cancel' });
    const fallback = setTimeout(() => { if (this.children.has(runId)) child.kill(); }, 4000); fallback.unref();
    return { cancelling: true };
  }
}
