import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Artifact } from '../../core/src/index.ts';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const tables = ['projects', 'environments', 'flows', 'scenarios', 'runs', 'events', 'artifacts', 'findings', 'suppressions', 'notes', 'task_presets', 'repo_snapshots', 'api_fixtures', 'matrices', 'reports'] as const;
export type Table = typeof tables[number];
export function within(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path must stay inside its project directory');
  return target;
}
export class Store {
  db: DatabaseSync; root: string;
  constructor(root = process.env.DCR_DATA_DIR || resolve('.dcr')) {
    this.root = resolve(root); mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(join(this.root, 'control-room.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);');
    this.db.exec('BEGIN');
    try {
      for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(project_id);`);
      this.db.exec('INSERT OR IGNORE INTO migrations VALUES (1); INSERT OR IGNORE INTO migrations VALUES (2); INSERT OR IGNORE INTO migrations VALUES (3); COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put<T extends { id: string; projectId?: string; runId?: string }>(table: Table, value: T): T {
    this.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?, ?, ?, ?)`).run(value.id, value.projectId ?? null, value.runId ?? null, JSON.stringify(value)); return value;
  }
  get<T>(table: Table, key: string): T { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key); if (!row) throw new Error(`${table}: record not found`); return JSON.parse(row.data as string); }
  list<T>(table: Table, projectId?: string): T[] { return (projectId ? this.db.prepare(`SELECT data FROM ${table} WHERE project_id=? ORDER BY rowid DESC`).all(projectId) : this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all()).map(r => JSON.parse(r.data as string)); }
  artifact(projectId: string, runId: string, name: string, mediaType: string, bytes: Uint8Array): Artifact {
    const path = `${projectId}/${runId}/${name}`, target = within(this.root, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, bytes);
    return this.put('artifacts', { id: id(), projectId, runId, name, path, mediaType, hash: createHash('sha256').update(bytes).digest('hex'), redacted: true });
  }
  readArtifact(artifact: Artifact) { return readFileSync(within(this.root, artifact.path)); }
  deleteProject(projectId: string) {
    this.get('projects', projectId); const target = within(this.root, projectId);
    if (target === this.root) throw new Error('Invalid project path');
    if (existsSync(target)) rmSync(target, { recursive: true });
    this.db.exec('BEGIN');
    try { for (const table of tables) this.db.prepare(`DELETE FROM ${table} WHERE project_id=? OR (${table === 'projects' ? 'id' : 'project_id'}=?)`).run(projectId, projectId); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  prune(projectId: string, days: number) {
    if (!Number.isInteger(days) || days < 1) throw new Error('Invalid retention interval');
    const retained = new Set<string>();
    for (const matrix of this.list<any>('matrices', projectId)) for (const runId of matrix.runIds || []) retained.add(runId);
    for (const session of this.list<any>('repo_snapshots', projectId)) { if (session.lastRunId) retained.add(session.lastRunId); if (session.lastFailedRunId) retained.add(session.lastFailedRunId); }
    for (const fixture of this.list<any>('api_fixtures', projectId)) if (fixture.sourceRunId) retained.add(fixture.sourceRunId);
    for (const run of this.list<any>('runs', projectId)) if (run.replayOf) retained.add(run.replayOf);
    let removed = 0;
    for (const run of this.list<{id: string; status: string; startedAt: string}>('runs', projectId)) {
      if (retained.has(run.id) || !Number.isFinite(Date.parse(run.startedAt)) || run.status === 'running' || Date.parse(run.startedAt) > Date.now() - days * 86400000) continue;
      const target = within(within(this.root, projectId), run.id); if (target === this.root || target === within(this.root, projectId)) throw new Error('Invalid evidence directory'); if (existsSync(target)) rmSync(target, { recursive: true });
      for (const table of ['events', 'artifacts', 'findings'] as const) this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
      this.db.prepare('DELETE FROM runs WHERE id=?').run(run.id); removed++;
    }
    return removed;
  }
  close() { this.db.close(); }
}
