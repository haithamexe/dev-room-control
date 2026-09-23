import { configSchema, type Project } from '../../core/src/index.ts';
import { Store, now } from '../../storage/src/index.ts';

export function cleanupScheduled(store: Store) {
  const results = [];
  for (const project of store.list<Project>('projects')) {
    const config = configSchema.parse(project.config); if (!config.scheduledCleanup) continue;
    try { const removed = store.prune(project.id, config.retentionDays); results.push(store.put('environments', { id: `cleanup-${project.id}`, projectId: project.id, kind: 'cleanup', at: now(), removed, status: 'completed' })); }
    catch { results.push(store.put('environments', { id: `cleanup-${project.id}`, projectId: project.id, kind: 'cleanup', at: now(), removed: 0, status: 'failed' })); }
  }
  return results;
}
