import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Project } from '../packages/core/src/index.ts';
import { stripeRequest } from '../packages/runner/src/stripe.ts';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { handoff } from '../packages/modules/src/handoff.ts';
import { startDemo } from '../examples/demo-app/server.ts';
import type { Matrix, Scenario } from '../packages/core/src/reliability.ts';

test('Stripe test probe rejects live keys before transport and only returns safe evidence', async () => {
  const project = { config: configSchema.parse({ reliability: { payment: { gateway: { provider: 'stripe-test', enabled: true, secretEnv: 'DCR_TEST_STRIPE_KEY' } } } }) } as Project;
  let calls = 0;
  const request: typeof fetch = async (url, options) => { calls++; assert.equal(String(url), 'https://api.stripe.com/v1/payment_intents'); assert.equal(options?.redirect, 'error'); return new Response(JSON.stringify({ id: 'pi_fixture123', livemode: false, status: 'succeeded', amount: 3200, currency: 'usd', client_secret: 'never-persist-this' })); };
  try {
    process.env.DCR_TEST_STRIPE_KEY = 'sk_live_fixture';
    await assert.rejects(stripeRequest(project, '/v1/payment_intents', {}, request), /test secret key/); assert.equal(calls, 0);
    process.env.DCR_TEST_STRIPE_KEY = 'sk_test_fixture';
    const evidence = await stripeRequest(project, '/v1/payment_intents', { amount: '3200' }, request);
    assert.equal(evidence.state, 'succeeded'); assert.equal(calls, 1); assert.ok(!JSON.stringify(evidence).includes('never-persist'));
    await assert.rejects(stripeRequest(project, '//evil.example', undefined, request), /Unsupported/); assert.equal(calls, 1);
    await assert.rejects(stripeRequest(project, '/v1/payment_intents', {}, async () => new Response(JSON.stringify({ id: 'pi_fixture', livemode: true }))), /verified test/);
    await assert.rejects(stripeRequest(project, '/v1/payment_intents', {}, async () => new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'sensitive message' } }), { status: 400 })), /HTTP 400, invalid_request/);
  } finally { delete process.env.DCR_TEST_STRIPE_KEY; }
});

test('authenticated inspection scrubs stored reports and general AI handoff', async () => {
  const secret = 'opaque-auth-fixture-do-not-persist';
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<main id="echo"></main><script>document.getElementById("echo").textContent=localStorage.getItem("session")</script>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`, root = mkdtempSync(join(tmpdir(), 'dcr-auth-check-')), store = new Store(root), service = new ControlRoom(store);
  process.env.DCR_TEST_AUTH_STATE = JSON.stringify({ cookies: [], origins: [{ origin: baseUrl, localStorage: [{ name: 'session', value: secret }] }] });
  try {
    const project = service.addProject({ name: 'Auth check', path: root, baseUrl, config: { auth: { storageStateEnv: 'DCR_TEST_AUTH_STATE' } } });
    const report = await service.understanding.element(project.id, { route: '/', selector: '#echo' });
    assert.equal(report.data.text, '[INPUT]');
    assert.ok(!JSON.stringify(store.list('reports')).includes(secret));
    assert.ok(!handoff(store, { kind: 'report', id: report.id }).text.includes(secret));
    for (const artifact of store.list<any>('artifacts').filter(a => a.mediaType === 'application/json')) assert.ok(!store.readArtifact(artifact).toString().includes(secret));
  } finally { delete process.env.DCR_TEST_AUTH_STATE; store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('isolated workers cancel and enforce time limits without marking cancellation as a defect', async () => {
  const server = createServer((_req, res) => res.end('<main>Waiting</main>')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = mkdtempSync(join(tmpdir(), 'dcr-worker-check-')), store = new Store(root), service = new ControlRoom(store);
  try {
    const project = service.addProject({ name: 'Cancellation', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const flow = service.saveFlow(project.id, { name: 'Wait', steps: [{ action: 'goto', url: '/' }, { action: 'assertText', text: 'Never shown' }] });
    const run = service.run(flow.id), completion = service.active.get(run.id)!;
    assert.notEqual(run.ownerPid, process.pid); service.workers.cancel(run.id);
    assert.equal((await completion).status, 'cancelled'); assert.equal(store.list('findings').length, 0);
    service.saveConfig(project.id, { ...project.config, execution: { timeoutMs: 1000 } });
    const timeout = service.run(flow.id), result = await service.active.get(timeout.id)!;
    assert.equal(result.status, 'failed'); assert.match(result.error!, /time limit/);
  } finally { store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('all ten payment cases pass against the corrected fixture and matrix resume skips completed cases', async () => {
  const server = startDemo(0, true); await once(server, 'listening');
  const root = mkdtempSync(join(tmpdir(), 'dcr-matrix-check-')), store = new Store(root), service = new ControlRoom(store);
  try {
    const project = await service.seedDemo(); project.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`; store.put('projects', project);
    const setup = service.setupDemoLabs(project.id, { confirmFixtures: true, includeAdvanced: true });
    const cases = setup.scenarios.filter((s: Scenario) => s.definition.kind === 'payment'); assert.equal(cases.length, 10);
    const matrix = service.reliability.matrix(project.id, { scenarioIds: cases.map((s: Scenario) => s.id) });
    const completion = service.reliability.activeMatrices.get(matrix.id)!;
    for (let attempt = 0; attempt < 300; attempt++) { if ((store.get<Matrix>('matrices', matrix.id).nextIndex || 0) >= 1) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    const before = store.get<Matrix>('matrices', matrix.id); assert.ok(before.nextIndex! >= 1); assert.equal(before.status, 'running');
    service.reliability.cancel(matrix.id); assert.equal((await completion).status, 'cancelled');
    const completedIds = store.get<Matrix>('matrices', matrix.id).runIds.slice(0, before.nextIndex);
    service.reliability.resume(matrix.id); const resumed = await service.reliability.activeMatrices.get(matrix.id)!;
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.nextIndex, 10); assert.deepEqual(resumed.runIds.slice(0, completedIds.length), completedIds);
    const results = resumed.runIds.map(id => store.get<any>('runs', id));
    assert.equal(results.filter(r => r.status === 'passed').length, 10, JSON.stringify(results.map(r => ({ case: r.scenario.paymentCase, status: r.status, error: r.error }))));
    assert.ok(results.some(r => r.status === 'cancelled'));
  } finally { store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
