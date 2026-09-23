import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request, type BrowserContext } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { createRun } from '../packages/runner/src/index.ts';
import { paymentRequest } from '../packages/runner/src/payment.ts';
import { configSchema, type Artifact, type Run, type Project } from '../packages/core/src/index.ts';
import type { Scenario } from '../packages/core/src/reliability.ts';
import { ReliabilityPanel } from '../apps/desktop/src/ReliabilityPanel.tsx';

test('delayed response must finish and its browser crash must fail despite pre-existing expected text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-delivery-')), store = new Store(root), service = new ControlRoom(store);
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p>Ready</p><script>fetch("/api/items").then(r=>r.json()).then(()=>{throw new Error("crashed after delivery")})</script>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const project = service.addProject({ name: 'Delivery', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { modules: ['api'], reliability: { apiPaths: ['/api/items'] } } });
    const flow = service.saveFlow(project.id, { name: 'Fetch', steps: [{ action: 'goto', url: '/' }] });
    const fixture = service.reliability.saveFixture(project.id, { name: 'Items', url: `${project.baseUrl}/api/items`, json: { items: [], privateValue: 'newly-sensitive-value' } });
    const input = { name: 'Delayed', kind: 'api', flowId: flow.id, fixtureId: fixture.id, mutation: { kind: 'delay', delayMs: 1800 }, expectedText: 'Ready' };
    const old = service.reliability.saveScenario(project.id, input);
    service.saveConfig(project.id, { ...project.config, redactFields: ['privateValue'] });
    const fresh = service.reliability.saveScenario(project.id, input);
    assert.ok(!JSON.stringify(fresh).includes('newly-sensitive-value'));
    const run = service.reliability.run(old.id), result = (await service.active.get(run.id))!;
    assert.equal(result.status, 'failed'); assert.equal(result.result!.matchedRequests, 1);
    assert.match(JSON.stringify(result.result), /crashed after delivery/);
    assert.ok(store.list<any>('events').some(e => e.title === 'GET /api/items' && e.data.status === 200));
    assert.equal(result.scenarioId, old.id);
    assert.ok(!JSON.stringify(result).includes('newly-sensitive-value'));
    const artifact = store.list<Artifact>('artifacts').find(a => a.name === 'scenario.json')!;
    assert.ok(!store.readArtifact(artifact).toString().includes('newly-sensitive-value'));
    const replay = createRun(store, service.reliability.project(project.id), flow, result);
    assert.equal(replay.scenarioId, old.id); assert.equal(replay.scenario.version, old.definition.version);
    assert.ok(!JSON.stringify(replay).includes('newly-sensitive-value'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('expanded payment paths respect ignore rules before sending any request', async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.setHeader('X-DCR-Fixture', '1'); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = await request.newContext();
  try {
    const project = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: configSchema.parse({ ignoreUrls: ['/__fixtures/orders/dcr-'] }) } as Project;
    await assert.rejects(paymentRequest({ request: client } as BrowserContext, project, '/__fixtures/orders/dcr-example/confirm', 'POST', {}), /ignored URL/);
    assert.equal(hits, 0);
  } finally { await client.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('scenario cards distinguish identical names and exclude an earlier version result', () => {
  const project = { id: 'project', path: '/example', baseUrl: 'http://localhost:3000', config: configSchema.parse({ modules: ['api'] }) } as Project;
  const definition = { kind: 'api', name: 'Same name', version: 1, mutation: { kind: 'delay', pointer: '' }, expectedText: 'Ready' } as Scenario['definition'];
  const scenarios = ['a', 'b', 'c'].map((id, i) => ({ id, projectId: project.id, flowId: 'flow', createdAt: '', definition: { ...definition, version: i === 2 ? 2 : 1 } })) as Scenario[];
  const runs = ['a', 'b', 'c'].map((id, i) => ({ id, projectId: project.id, scenarioId: id, scenario: definition, status: i === 0 ? 'failed' : 'passed' })) as Run[];
  const html = renderToStaticMarkup(createElement(ReliabilityPanel, { kind: 'api', project, flows: [], fixtures: [], scenarios, matrices: [], runs, busy: false, perform: () => {}, openRun: () => {}, onSettings: () => {} }));
  const cards = html.match(/<article[\s\S]*?<\/article>/g)!;
  assert.equal(cards.length, 3); assert.match(cards[0], />failed</); assert.match(cards[1], />passed</); assert.match(cards[2], /Not run yet/);
});

test('abandoned work recovers while live process ownership blocks deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-recovery-')), store = new Store(root), service = new ControlRoom(store);
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' }); const deadPid = child.pid!; await once(child, 'exit');
  try {
    const project = service.addProject({ name: 'Recovery', path: root, baseUrl: 'http://localhost:3000' });
    store.put('runs', { id: 'dead', projectId: project.id, status: 'running', ownerPid: deadPid });
    store.put('matrices', { id: 'dead-matrix', projectId: project.id, status: 'running', ownerPid: deadPid });
    store.put('runs', { id: 'live', projectId: project.id, status: 'running', ownerPid: process.pid });
    new ControlRoom(store);
    assert.equal(store.get<any>('runs', 'dead').status, 'failed'); assert.equal(store.get<any>('matrices', 'dead-matrix').status, 'interrupted');
    assert.throws(() => service.deleteProject(project.id, project.name), /active runs/);
    store.put('runs', { id: 'live', projectId: project.id, status: 'passed', ownerPid: process.pid });
    store.put('runs', { id: 'legacy', projectId: project.id, status: 'running' });
    assert.equal(service.recoverInterrupted(project.id).recovered, 0);
    assert.equal(service.recoverInterrupted(project.id, true).recovered, 1);
    assert.deepEqual(service.deleteProject(project.id, project.name), { deleted: true });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
