import { cleanupScheduled } from '../../../packages/modules/src/retention.ts';
import { importPlaywright } from '../../../packages/modules/src/flow-import.ts';
import { FlowRecorder } from '../../../packages/modules/src/recorder.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Store, id, now, within } from '../../../packages/storage/src/index.ts';
import { ControlRoom } from '../../../packages/modules/src/service.ts';
import { modules, configSchema, type Project, type Run, type Finding, type RunEvent, type Artifact } from '../../../packages/core/src/index.ts';
import type { ApiFixture, Scenario, Matrix } from '../../../packages/core/src/reliability.ts';
import { redact, redactText } from '../../../packages/core/src/redact.ts';
import { snapshot, safeSource } from '../../../packages/repo-analysis/src/index.ts';
import { sourceText } from '../../../packages/repo-analysis/src/sources.ts';
import { handoff } from '../../../packages/modules/src/handoff.ts';
const require = createRequire(import.meta.url);
export function startServer(port = Number(process.env.DCR_PORT || 4310), store = new Store()) {
  const recorder = new FlowRecorder();
  const service = new ControlRoom(store), token = randomBytes(32).toString('hex');
  async function body(req: IncomingMessage) { let content = ''; for await (const chunk of req) { content += chunk; if (content.length > 256000) throw new Error('Request exceeds 256 KB'); } return content ? JSON.parse(content) : {}; }
  const server = createServer(async (req, res) => {
    const send = (data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const host = req.headers.host || '', validHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!validHosts.includes(host)) return send({ error: 'Invalid host' }, 403);
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) return send({ error: 'Invalid origin' }, 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'Cross-site requests are denied' }, 403);
      const url = new URL(req.url || '/', `http://${host}`), parts = url.pathname.split('/').filter(Boolean), method = req.method;
      if (parts[0] !== 'api') {
        const path = within(resolve('dist'), decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html');
        const file = existsSync(path) && statSync(path).isFile() ? path : resolve('dist/index.html');
        if (!existsSync(file)) return send({ error: 'Run npm run build first, or open the development UI on port 5173.' }, 404);
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' }); return res.end(readFileSync(file));
      }
      if (shuttingDown && !['GET', 'HEAD'].includes(method || '')) return send({ error: 'Control Room is shutting down' }, 503);
      if (method === 'GET' && parts[1] === 'session') return send({ token, launchId: process.env.DCR_LAUNCH_ID });
      if (!['GET', 'HEAD'].includes(method || '') && req.headers['x-dcr-token'] !== token) return send({ error: 'Reload the dashboard to renew your local session' }, 403);
      if (method === 'GET' && parts[1] === 'overview') {
        return send({ projects: store.list<Project>('projects').map(p => ({ ...p, config: configSchema.parse(p.config), git: snapshot(p.path) })), runs: store.list<Run>('runs'), findings: store.list('findings'), flows: store.list('flows'), tasks: store.list('task_presets'), notes: store.list('notes'), fixtures: store.list('api_fixtures'), scenarios: store.list('scenarios'), matrices: store.list('matrices'), reports: store.list('reports'), sessions: store.list('repo_snapshots'), commandRuns: store.list<any>('environments').filter(row => row.kind === 'command'), cleanup: store.list<any>('environments').filter(row => row.kind === 'cleanup'), modules });
      }
      if (method === 'POST' && parts[1] === 'recordings' && parts[3] === 'navigate') return send(await recorder.navigate(parts[2], await body(req)));
      if (method === 'POST' && parts[1] === 'recordings' && parts[3] === 'stop') return send(await recorder.stop(parts[2]));
      if (method === 'GET' && parts[1] === 'recordings') return send([...recorder.sessions.values()].map(session => ({ id: session.id, projectId: session.projectId, stopped: session.stopped, tabs: [...session.tabs.keys()] })));
      if (method === 'POST' && parts[1] === 'commands' && parts[3] === 'stop') return send(await service.commands.stop(parts[2]));
      if (method === 'POST' && parts[1] === 'handoff') return send(handoff(store, await body(req)));
      if (method === 'GET' && parts[1] === 'reports' && parts[2]) return send(store.get('reports', parts[2]));
      if (method === 'POST' && parts[1] === 'demo') return send(await service.seedDemo());
      if (method === 'POST' && parts.length === 2 && parts[1] === 'projects') return send(service.addProject(await body(req)), 201);
      if (parts[1] === 'projects' && parts[2]) {
        const projectId = parts[2]; store.get('projects', projectId);
        if (method === 'DELETE') { if ([...recorder.sessions.values()].some(session => session.projectId === projectId)) throw new Error('Stop and review this project recording before deleting'); return send(service.deleteProject(projectId, (await body(req)).confirmation)); }
        if (method === 'PUT' && parts[3] === 'config') return send(service.saveConfig(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'export') return send(service.exportConfig(projectId));
        if (method === 'POST' && parts[3] === 'recordings') return send(await recorder.start(service.reliability.project(projectId), await body(req)), 201);
        if (method === 'POST' && parts[3] === 'flows') return send(service.saveFlow(projectId, await body(req)), 201);
        if (method === 'POST' && parts[3] === 'tasks') return send(service.saveTask(projectId, await body(req)), 201);
        if (method === 'POST' && parts[3] === 'capture') return send(service.reliability.capture(projectId, await body(req)), 202);
        if (method === 'POST' && parts[3] === 'fixtures') return send(service.reliability.saveFixture(projectId, await body(req)), 201);
        if (method === 'POST' && parts[3] === 'scenarios') return send(service.reliability.saveScenario(projectId, await body(req)), 201);
        if (method === 'POST' && parts[3] === 'matrices') return send(service.reliability.matrix(projectId, await body(req)), 202);
        if (method === 'POST' && parts[3] === 'setup-labs') return send(service.setupDemoLabs(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'risk') return send(service.understanding.risk(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'drift') return send(await service.understanding.drift(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'element') return send(await service.understanding.element(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'session') return send(service.understanding.session(projectId, await body(req)));
        if (method === 'PUT' && parts[3] === 'notes') { const data = await body(req); return send(store.put('notes', { id: projectId, projectId, text: redactText(String(data.text || '').slice(0, 10000)), nextStep: redactText(String(data.nextStep || '').slice(0, 1000)) })); }
        if (method === 'GET' && parts[3] === 'source') return send(sourceText(service.understanding.project(projectId), url.searchParams.get('path') || ''));
      }
      if (method === 'POST' && parts[1] === 'flows' && parts[2] === 'import') return send(importPlaywright(String((await body(req)).source || '')));
      if (method === 'PUT' && parts[1] === 'flows' && parts[2]) { const flow = store.get<import('../../../packages/core/src/index.ts').Flow>('flows', parts[2]); return send(service.saveFlow(flow.projectId, await body(req), flow.id)); }
      if (method === 'POST' && parts[1] === 'flows' && parts[3] === 'run') return send(service.run(parts[2]), 202);
      if (parts[1] === 'fixtures' && parts[2] && method === 'PUT') { const fixture = store.get<ApiFixture>('api_fixtures', parts[2]); return send(service.reliability.saveFixture(fixture.projectId, await body(req), fixture.id)); }
      if (parts[1] === 'scenarios' && parts[2]) {
        const scenario = store.get<Scenario>('scenarios', parts[2]);
        if (method === 'PUT') return send(service.reliability.saveScenario(scenario.projectId, await body(req), scenario.id));
        if (method === 'POST' && parts[3] === 'run') return send(service.reliability.run(scenario.id), 202);
      }
      if (parts[1] === 'matrices' && parts[2] && method === 'GET') return send(store.get<Matrix>('matrices', parts[2]));
      if (parts[1] === 'matrices' && parts[2] && method === 'POST' && parts[3] === 'cancel') return send(service.reliability.cancel(parts[2]));
      if (parts[1] === 'matrices' && parts[2] && method === 'POST' && parts[3] === 'resume') return send(service.reliability.resume(parts[2]), 202);
      if (parts[1] === 'runs' && parts[2]) {
        const run = store.get<Run>('runs', parts[2]);
        if (method === 'GET') return send({ run, events: store.list<RunEvent>('events', run.projectId).filter(e => e.runId === run.id).reverse(), artifacts: store.list<Artifact>('artifacts', run.projectId).filter(a => a.runId === run.id), findings: store.list<Finding>('findings', run.projectId).filter(f => f.runId === run.id), replayCommand: `npm run cli -- replay ${run.id}` });
        if (method === 'POST' && parts[3] === 'replay') return send(service.run(run.flowId, run.id), 202);
        if (method === 'POST' && parts[3] === 'cancel') return send(service.workers.cancel(run.id));
        if (method === 'POST' && parts[3] === 'marker') return send(store.put('events', { id: id(), projectId: run.projectId, runId: run.id, kind: 'marker', at: now(), title: redactText(String((await body(req)).text || 'Interesting moment').slice(0, 200)), data: {} }));
      }
      if (parts[1] === 'artifacts' && parts[2]) {
        const artifact = store.get<Artifact>('artifacts', parts[2]);
        if (method === 'POST' && parts[3] === 'open-trace' && artifact.name === 'trace.zip') {
          const child = spawn(process.execPath, [join(dirname(require.resolve('playwright/package.json')), 'cli.js'), 'show-trace', within(store.root, artifact.path), '--host', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
          child.on('error', () => {}); return send({ opened: true });
        }
        if (method === 'GET') { res.writeHead(200, { 'Content-Type': artifact.mediaType, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${artifact.mediaType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${artifact.name}"` }); return res.end(store.readArtifact(artifact)); }
      }
      if (method === 'PATCH' && parts[1] === 'findings') {
        const finding = store.get<Finding>('findings', parts[2]), data = await body(req);
        if (data.disposition) return send(service.understanding.disposition(finding.id, data.disposition));
        if (!['open', 'resolved', 'suppressed'].includes(data.status)) throw new Error('Invalid finding status');
        finding.status = data.status; return send(store.put('findings', finding));
      }
      if (parts[1] === 'tasks' && parts[2]) {
        if (method === 'GET') return send(service.previewTask(parts[2]));
        if (method === 'POST' && parts[3] === 'launch') return send(service.launchTask(parts[2], (await body(req)).approveCommand === true));
      }
      send({ error: 'Not found' }, 404);
    } catch (error) { send({ error: redactText(error instanceof Error ? error.message : String(error)) }, 400); }
  });
  const cleanupTimer = setInterval(() => cleanupScheduled(store), 60 * 60 * 1000); cleanupTimer.unref();
  let shuttingDown = false;
  const shutdown = async (message: unknown) => {
    if ((message as any)?.type !== 'dcr-shutdown' || shuttingDown) return; shuttingDown = true;
    clearInterval(cleanupTimer);
    for (const id of service.reliability.activeMatrices.keys()) service.reliability.cancel(id);
    for (const id of service.active.keys()) service.workers.cancel(id);
    await Promise.allSettled([service.commands.close(), ...[...recorder.sessions.keys()].map(id => recorder.stop(id))]);
    await Promise.allSettled([...service.reliability.activeMatrices.values(), ...service.active.values()]);
    server.close(() => { void (async () => {
      // A recorder launch that was already in flight may finish during shutdown.
      await Promise.allSettled([service.commands.close(), ...[...recorder.sessions.keys()].map(id => recorder.stop(id))]);
      process.exit(0);
    })(); });
  };
  if (process.send) process.on('message', shutdown);
  server.once('close', () => { process.off('message', shutdown); });
  server.once('close', () => { clearInterval(cleanupTimer); void service.commands.close(); });
  cleanupScheduled(store);
  server.listen(port, '127.0.0.1', () => console.log(`Developer Control Room: http://127.0.0.1:${port}`));
  return { server, service, store };
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/server.ts')) startServer();
