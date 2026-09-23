import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { startDemo } from '../examples/demo-app/server.ts';
import { startServer } from '../apps/service/src/server.ts';
import type { Artifact, Flow, Run } from '../packages/core/src/index.ts';
import type { ApiFixture, Matrix, Scenario } from '../packages/core/src/reliability.ts';

const root = mkdtempSync(join(tmpdir(), 'dcr-phase2-'));
let store = new Store(root), service = new ControlRoom(store), demo: ReturnType<typeof startDemo> | undefined, dashboard: ReturnType<typeof startServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const stopDemo = async () => { if (demo) { await new Promise<void>(resolve => demo!.close(() => resolve())); demo = undefined; } };
const completed = async (run: Run) => (await service.active.get(run.id))!;
try {
  demo = startDemo(4416); await once(demo, 'listening');
  const project = await service.seedDemo(); project.baseUrl = 'http://127.0.0.1:4416'; store.put('projects', project);
  assert.throws(() => service.setupDemoLabs(project.id, { confirmFixtures: false }));
  const setup = service.setupDemoLabs(project.id, { confirmFixtures: true });
  const scenarios = setup.scenarios; assert.equal(scenarios.length, 10);
  const capture = await completed(service.reliability.capture(project.id, { name: 'Captured products', flowId: setup.captureFlowId, url: 'http://127.0.0.1:4416/api/products' }));
  assert.equal(capture.status, 'passed');
  const capturedFixture = store.get<ApiFixture>('api_fixtures', capture.result!.fixtureId!);
  assert.equal(capturedFixture.sourceRunId, capture.id); assert.ok(!JSON.stringify(capturedFixture).includes('seeded-api-secret'));
  assert.equal((capturedFixture.json as any).accessToken, '[REDACTED]');
  console.log('PASS: opt-in browser capture persists a sanitized fixture linked to its run.');
  const matrix = service.reliability.matrix(project.id, { name: 'Faulty reliability matrix', scenarioIds: scenarios.map(s => s.id) });
  const result = (await service.reliability.activeMatrices.get(matrix.id))!; assert.equal(result.status, 'completed');
  const faultyRuns = result.runIds.map(id => store.get<Run>('runs', id));
  for (const run of faultyRuns) assert.equal(run.status, run.scenario.kind === 'api' && run.scenario.mutation.kind === 'delay' ? 'passed' : 'failed', `${run.name}: ${run.error}`);
  const payments = faultyRuns.filter(r => r.scenario.kind === 'payment'); assert.equal(payments.length, 3);
  for (const run of payments) { assert.ok(run.result); assert.equal((run.result.observed as any).server.state, 'confirmed'); assert.ok((run.result.observed as any).route.includes('/lab/')); }
  assert.equal((payments.find(r => r.scenario.kind === 'payment' && r.scenario.paymentCase === 'duplicate-confirmation')!.result!.observed as any).server.confirmationCount, 2);
  console.log('PASS: all six defective API states and all three payment invariants fail with browser/server evidence; the delay control passes.');
  const emptyCase = scenarios.find(s => s.definition.kind === 'api' && s.definition.mutation.kind === 'empty-list')!;
  const emptyRun = faultyRuns.find(r => r.scenario.kind === 'api' && r.scenario.mutation.kind === 'empty-list')!;
  service.reliability.saveScenario(project.id, { kind: 'api', name: 'Edited after original run', flowId: emptyCase.flowId, fixtureId: emptyCase.fixtureId, mutation: { kind: 'delay' }, expectedText: 'Catalog ready' }, emptyCase.id);
  const replay = await completed(service.run(emptyRun.flowId, emptyRun.id)); assert.equal(replay.status, 'failed'); assert.deepEqual(replay.scenario, emptyRun.scenario);
  service.reliability.saveScenario(project.id, { kind: 'api', name: emptyCase.definition.name, flowId: emptyCase.flowId, fixtureId: emptyCase.fixtureId, mutation: { kind: 'empty-list', pointer: '/items' }, expectedText: 'No products yet' }, emptyCase.id);
  console.log('PASS: replay preserves fixture data and mutation inputs after editing the saved scenario.');
  await stopDemo(); demo = startDemo(4416, true); await once(demo, 'listening');
  const correctedMatrix = service.reliability.matrix(project.id, { name: 'Corrected reliability matrix', scenarioIds: scenarios.map(s => s.id) });
  const corrected = (await service.reliability.activeMatrices.get(correctedMatrix.id))!;
  assert.equal(corrected.status, 'completed'); for (const runId of corrected.runIds) { const run = store.get<Run>('runs', runId); assert.equal(run.status, 'passed', `${run.name}: ${run.error}`); }
  console.log('PASS: all ten scenarios pass against the corrected app, including authoritative confirmation count = 1.');
  for (const artifact of store.list<Artifact>('artifacts')) {
    if (artifact.mediaType === 'image/png') continue;
    const bytes = store.readArtifact(artifact), text = artifact.name === 'trace.zip' ? Object.values(unzipSync(bytes)).map(b => strFromU8(b)).join('\n') : bytes.toString();
    for (const secret of ['seeded-api-secret-do-not-store', 'fixture@example.com']) assert.ok(!text.includes(secret), `${artifact.name} leaks ${secret}`);
  }
  const settings = service.reliability.project(project.id).config; settings.reliability.payment.fixturesOnlyConfirmed = false; service.saveConfig(project.id, settings);
  assert.throws(() => service.reliability.run(scenarios.find(s => s.definition.kind === 'payment')!.id));
  settings.reliability.payment.fixturesOnlyConfirmed = true; settings.reliability.apiPaths.push('/api/unrequested'); service.saveConfig(project.id, settings);
  const unused = service.reliability.saveFixture(project.id, { name: 'Unrequested', url: 'http://127.0.0.1:4416/api/unrequested', json: { items: [] } });
  const unmatchedCase = service.reliability.saveScenario(project.id, { kind: 'api', name: 'No matching request', flowId: emptyCase.flowId, fixtureId: unused.id, mutation: { kind: 'empty-list', pointer: '/items' }, expectedText: 'Catalog ready' });
  const unmatched = await completed(service.reliability.run(unmatchedCase.id)); assert.equal(unmatched.status, 'failed'); assert.equal(unmatched.result?.matchedRequests, 0);
  console.log('PASS: disabled payment approval blocks execution; an unmatched mutation cannot falsely pass; saved artifacts contain no seeded secrets.');
  dashboard = startServer(4314, store); await once(dashboard.server, 'listening');
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4314'); await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await page.getByRole('button', { name: 'API Contract Ambush', exact: true }).click(); await page.getByRole('heading', { name: /Response fixtures/ }).waitFor();
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/api-lab.png', fullPage: true });
  await page.getByRole('button', { name: 'Payment Stress Lab', exact: true }).click(); await page.getByRole('heading', { name: 'A success screen is only half the story.' }).waitFor();
  await page.getByRole('button', { name: 'Select all cases', exact: true }).click();
  const responseReady = page.waitForResponse(response => response.url().endsWith('/matrices') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run selected cases' }).click(); const uiMatrix: Matrix = await (await responseReady).json();
  await page.waitForFunction(() => document.querySelector('.matrix-summary')?.textContent?.includes('completed') && document.querySelectorAll('.matrix-row').length === 3);
  assert.equal(store.get<Matrix>('matrices', uiMatrix.id).status, 'completed');
  await page.screenshot({ path: 'test-results/payment-lab.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/payment-lab-mobile.png', fullPage: true });
  assert.deepEqual(errors, []); await browser.close(); browser = undefined;
  await new Promise<void>(resolve => dashboard!.server.close(() => resolve())); dashboard = undefined; await stopDemo();
  store.close(); store = new Store(root);
  assert.equal(store.get<Matrix>('matrices', correctedMatrix.id).status, 'completed'); assert.equal(store.get<Run>('runs', payments[0].id).result!.passed, false);
  assert.ok(store.readArtifact(store.list<Artifact>('artifacts').find(a => a.name === 'scenario.json')!).length);
  console.log('PASS: dashboard starts a matrix, renders API/payment results on desktop/mobile, and completed scenario evidence reopens offline.\nPhase 2 gate verified.');
} finally {
  await browser?.close(); if (dashboard) { await Promise.allSettled([...dashboard.service.reliability.activeMatrices.values()]); await new Promise<void>(resolve => dashboard!.server.close(() => resolve())); }
  await Promise.allSettled([...service.reliability.activeMatrices.values(), ...service.active.values()]); await stopDemo(); store.close(); rmSync(root, { recursive: true, force: true });
}
