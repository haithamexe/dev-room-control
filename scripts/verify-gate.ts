import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { startDemo } from '../examples/demo-app/server.ts';
import { startServer } from '../apps/service/src/server.ts';
import type { Artifact, Flow, Run, RunEvent } from '../packages/core/src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'dcr-gate-'));
let store = new Store(root), service = new ControlRoom(store);
let demo: ReturnType<typeof startDemo> | undefined, dashboard: ReturnType<typeof startServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const closeDemo = async () => { if (demo) { await new Promise<void>((resolve, reject) => demo!.close(e => e ? reject(e) : resolve())); demo = undefined; } };
try {
  demo = startDemo(4411); await once(demo, 'listening');
  const project = await service.seedDemo(); project.baseUrl = 'http://127.0.0.1:4411'; project.config.captureBodies = true; store.put('projects', project);
  const flow = store.list<Flow>('flows', project.id).find(f => f.name === 'Complete checkout')!;
  const run = service.run(flow.id); const failed = (await service.active.get(run.id))!;
  assert.equal(failed.status, 'failed');
  const events = store.list<RunEvent>('events', project.id).filter(e => e.runId === run.id);
  assert.ok(events.some(e => e.kind === 'action' && e.title.includes('Confirm order')));
  assert.ok(events.some(e => e.kind === 'request' && e.data.status === 500));
  assert.ok(events.some(e => e.kind === 'console'));
  const artifacts = store.list<Artifact>('artifacts', project.id).filter(a => a.runId === run.id);
  assert.ok(artifacts.some(a => a.name === 'screenshot.png')); assert.ok(artifacts.some(a => a.name === 'trace.zip'));
  for (const a of artifacts) {
    if (a.mediaType === 'image/png') continue;
    const bytes = store.readArtifact(a), contents = a.name === 'trace.zip' ? Object.values(unzipSync(bytes)).map(bytes => strFromU8(bytes)).join('\n') : bytes.toString();
    for (const secret of ['seeded-secret-do-not-store', 'fixture@example.com', '4242424242424242']) assert.ok(!contents.includes(secret), `${a.name} leaked ${secret}`);
  }
  console.log('PASS: failing flow has action, 500 request, console, screenshot, sanitized trace and timeline.');
  // Change the live definition: replay must still use the original saved steps.
  store.put('flows', { ...flow, steps: [{ action: 'goto' as const, url: '/' }] });
  const replay = service.run(flow.id, run.id); const replayed = (await service.active.get(replay.id))!;
  assert.equal(replayed.status, 'failed'); assert.deepEqual(replayed.flow, failed.flow);
  console.log('PASS: replay uses immutable saved inputs and reproduces the failure.');
  await closeDemo(); store.close(); store = new Store(root); service = new ControlRoom(store);
  assert.equal(store.get<Run>('runs', run.id).status, 'failed');
  assert.equal(store.list<any>('notes', project.id)[0].nextStep, 'Inspect POST /api/confirm and the missing success state.');
  dashboard = startServer(4311, store); await once(dashboard.server, 'listening');
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4311'); await page.getByRole('heading', { name: 'Your development, in focus.' }).waitFor();
  await page.getByRole('button', { name: 'View all runs' }).click();
  await page.getByRole('button', { name: 'Inspect Complete checkout' }).first().click();
  await page.getByRole('button', { name: 'Replay run', exact: true }).waitFor();
  await page.getByRole('img', { name: 'Browser at the end of Complete checkout' }).waitFor();
  assert.equal(await page.getByRole('img', { name: 'Browser at the end of Complete checkout' }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true);
  assert.equal((await fetch(`http://127.0.0.1:4311/api/runs/${run.id}`)).status, 200);
  assert.equal((await fetch('http://127.0.0.1:4311/api/demo', { method: 'POST' })).status, 403);
  assert.equal((await fetch('http://127.0.0.1:4311/api/overview', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/run-evidence.png', fullPage: true });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout overflows');
  assert.deepEqual(errors, []); await browser.close(); browser = undefined;
  console.log('PASS: restarted dashboard displays offline evidence and notes; local API rejects unauthorized writes and cross-site access; desktop/mobile UI has no runtime errors.');
  demo = startDemo(4411, true); await once(demo, 'listening');
  const corrected = service.run(flow.id, run.id); assert.equal((await service.active.get(corrected.id))!.status, 'passed');
  console.log('PASS: the exact failing flow passes against the corrected demo.');
  await closeDemo();
  service.deleteProject(project.id, project.name); assert.equal(store.list('projects').length, 0); assert.equal(store.list('artifacts').length, 0);
  console.log('PASS: confirmed project deletion removes saved records and artifacts.\nPhase 1 gate verified.');
} finally {
  await browser?.close(); await closeDemo(); if (dashboard) await new Promise<void>(resolve => dashboard!.server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true });
}
