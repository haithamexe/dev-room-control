import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Store, id, now, within } from '../../../packages/storage/src/index.ts';
import { ControlRoom } from '../../../packages/modules/src/service.ts';
import { modules, type Project, type Run, type Finding, type RunEvent, type Artifact } from '../../../packages/core/src/index.ts';
import { redact, redactText } from '../../../packages/core/src/redact.ts';
import { snapshot, safeSource } from '../../../packages/repo-analysis/src/index.ts';
const require = createRequire(import.meta.url);
export function startServer(port = Number(process.env.DCR_PORT || 4310), store = new Store()) {
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
      if (method === 'GET' && parts[1] === 'session') return send({ token });
      if (!['GET', 'HEAD'].includes(method || '') && req.headers['x-dcr-token'] !== token) return send({ error: 'Reload the dashboard to renew your local session' }, 403);
      if (method === 'GET' && parts[1] === 'overview') {
        return send({ projects: store.list<Project>('projects').map(p => ({ ...p, git: snapshot(p.path) })), runs: store.list<Run>('runs'), findings: store.list('findings'), flows: store.list('flows'), tasks: store.list('task_presets'), notes: store.list('notes'), modules });
      }
      if (method === 'POST' && parts[1] === 'demo') return send(await service.seedDemo());
      if (method === 'POST' && parts.length === 2 && parts[1] === 'projects') return send(service.addProject(await body(req)), 201);
      if (parts[1] === 'projects' && parts[2]) {
        const projectId = parts[2]; store.get('projects', projectId);
        if (method === 'DELETE') return send(service.deleteProject(projectId, (await body(req)).confirmation));
        if (method === 'PUT' && parts[3] === 'config') return send(service.saveConfig(projectId, await body(req)));
        if (method === 'POST' && parts[3] === 'export') return send(service.exportConfig(projectId));
        if (method === 'POST' && parts[3] === 'flows') return send(service.saveFlow(projectId, await body(req)), 201);
        if (method === 'POST' && parts[3] === 'tasks') return send(service.saveTask(projectId, await body(req)), 201);
        if (method === 'PUT' && parts[3] === 'notes') { const data = await body(req); return send(store.put('notes', { id: projectId, projectId, text: redactText(String(data.text || '').slice(0, 10000)), nextStep: redactText(String(data.nextStep || '').slice(0, 1000)) })); }
        if (method === 'GET' && parts[3] === 'source') { const p = store.get<Project>('projects', projectId), file = safeSource(p.path, url.searchParams.get('path') || ''); if (statSync(file).size > 256000) throw new Error('Source file too large'); return send({ path: file, content: redactText(readFileSync(file, 'utf8')) }); }
      }
      if (method === 'POST' && parts[1] === 'flows' && parts[3] === 'run') return send(service.run(parts[2]), 202);
      if (parts[1] === 'runs' && parts[2]) {
        const run = store.get<Run>('runs', parts[2]);
        if (method === 'GET') return send({ run, events: store.list<RunEvent>('events', run.projectId).filter(e => e.runId === run.id).reverse(), artifacts: store.list<Artifact>('artifacts', run.projectId).filter(a => a.runId === run.id), findings: store.list<Finding>('findings', run.projectId).filter(f => f.runId === run.id), replayCommand: `npm run cli -- replay ${run.id}` });
        if (method === 'POST' && parts[3] === 'replay') return send(service.run(run.flowId, run.id), 202);
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
  server.listen(port, '127.0.0.1', () => console.log(`Developer Control Room: http://127.0.0.1:${port}`));
  return { server, service, store };
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/server.ts')) startServer();
