import { Store } from '../../storage/src/index.ts';
import { executeRun } from './index.ts';
import type { Project, Run } from '../../core/src/index.ts';
const controller = new AbortController();
process.on('message', async (message: any) => {
  if (message.type === 'cancel') { controller.abort(); return; }
  if (message.type !== 'start') return;
  const store = new Store(message.root);
  try { const run = store.get<Run>('runs', message.runId); await executeRun(store, message.project as Project, run, controller.signal); }
  catch { const run = store.get<Run>('runs', message.runId); run.status = controller.signal.aborted ? 'cancelled' : 'failed'; run.error = 'Runner worker stopped unexpectedly'; run.endedAt = new Date().toISOString(); store.put('runs', run); }
  finally { store.close(); process.disconnect?.(); }
});
process.on('disconnect', () => controller.abort());
