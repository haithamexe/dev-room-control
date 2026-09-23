import type { Project } from '../packages/core/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { FlowRecorder } from '../packages/modules/src/recorder.ts';
import { importPlaywright } from '../packages/modules/src/flow-import.ts';
import { cleanupScheduled } from '../packages/modules/src/retention.ts';
import { requestMatches, suggestMutations, sanitizeFixture } from '../packages/core/src/api-matching.ts';
import { inspectReact } from '../packages/runner/src/react-inspection.ts';
import loader from '../packages/instrumentation/src/webpack-loader.ts';

test('Playwright imports preserve supported steps and flag skipped behavior', () => {
  const converted = importPlaywright(`import { test, expect } from '@playwright/test'; test('Login', async ({ page }) => { await page.goto('/'); await page.frameLocator('#form').getByLabel('Name').fill(process.env.DCR_NAME); await page.getByLabel('Country').selectOption('IQ'); await page.goBack(); await expect(page.getByText('Ready')).toBeVisible(); });`);
  assert.deepEqual(converted.diagnostics, []); assert.equal(converted.flow.steps.length, 5); assert.deepEqual(converted.flow.steps[1].frames, ['#form']); assert.equal(converted.flow.steps[1].env, 'DCR_NAME'); assert.equal(converted.flow.steps[1].exact, false);
  assert.ok(importPlaywright(`test('Bad', async ({page}) => { for (let i=0;i<3;i++) await page.reload(); await helper(); });`).diagnostics.length === 2);
  assert.ok(importPlaywright(`test('Options', async ({page}) => { await page.goto('/', { waitUntil: 'networkidle' }); });`).diagnostics.length);
});

test('body matching and schema suggestions respect nested structure and escaped JSON pointers', () => {
  assert.equal(requestMatches({ mode: 'exact', json: { b: 2, a: 1 } }, '{"a":1,"b":2}', []), true);
  assert.equal(requestMatches({ mode: 'exact', json: { a: 1 } }, '{"a":1,"b":2}', []), false);
  assert.equal(requestMatches({ mode: 'subset', json: { a: { n: 1 } } }, '{"a":{"n":1,"x":0}}', []), true);
  assert.equal(requestMatches({ mode: 'subset', json: { a: 1 } }, 'not JSON', []), false);
  assert.equal(requestMatches({ mode: 'exact', json: { query: 'Alice' } }, '{"query":"Alice"}', [], ['Alice']), true);
  const sanitized = sanitizeFixture({ name: 'Fixture', url: 'http://localhost/api', method: 'POST' as const, status: 200, json: { url: 'private' }, request: { mode: 'exact' as const, json: { url: 'private', custom: 'old-secret' } } }, ['url', 'method', 'custom']);
  assert.equal(sanitized.url, 'http://localhost/api'); assert.equal(sanitized.method, 'POST'); assert.equal((sanitized.request!.json as any).custom, '[REDACTED]');
  const suggestions = suggestMutations({ name: 'Schema', method: 'GET', url: 'http://localhost/api', status: 200, json: { 'a/b': 'name', items: [1] }, schema: { type: 'object', required: ['items'], properties: { 'a/b': { type: ['string', 'null'], maxLength: 8 }, items: { type: 'array', minItems: 1 } } } });
  assert.ok(suggestions.some(s => s.mutation.kind === 'missing-field' && s.mutation.pointer === '/a~1b')); assert.ok(suggestions.some(s => s.mutation.stringLength === 9)); assert.ok(!suggestions.some(s => s.mutation.pointer === '/items'));
});

test('non-GET captures retain request matchers and mutations never forward mismatches', async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/api/items') { calls.push(req.method!); res.setHeader('content-type', 'application/json'); return res.end('{"items":[1]}'); }
    const method = new URL(req.url!, 'http://localhost').pathname.slice(1) || 'POST';
    res.setHeader('content-type', 'text/html'); res.end(`<main>Waiting</main><script>fetch('/api/items',{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:JSON.stringify({id:1})}).then(r=>r.json()).then(data=>document.querySelector('main').textContent=data.items.length?'Ready':'Empty').catch(()=>document.querySelector('main').textContent='Blocked')</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const root = mkdtempSync(join(tmpdir(), 'dcr-methods-')), store = new Store(root), service = new ControlRoom(store);
  try {
    let project: Project = service.addProject({ name: 'Methods', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { modules: ['api', 'time-machine'], reliability: { apiPaths: ['/api/items'] } } });
    assert.throws(() => service.reliability.saveFixture(project.id, { name: 'Blocked', url: project.baseUrl + '/api/items', method: 'POST', json: {} }), /Allow POST/);
    project = service.saveConfig(project.id, { ...project.config, reliability: { ...project.config.reliability, apiMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] } });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const capture = service.saveFlow(project.id, { name: method, steps: [{ action: 'goto', url: '/' + method }, { action: 'assertText', text: 'Ready' }] });
      const run = service.reliability.capture(project.id, { flowId: capture.id, name: method, url: project.baseUrl + '/api/items', method }); await service.active.get(run.id);
      assert.equal(store.get<any>('runs', run.id).status, 'passed'); const fixture = store.list<any>('api_fixtures')[0]; assert.equal(fixture.method, method); assert.deepEqual(fixture.request.json, { id: 1 });
      const flow = service.saveFlow(project.id, { name: 'Mutate', steps: [{ action: 'goto', url: '/' + method }, { action: 'assertText', text: 'Empty' }] });
      const scenario = service.reliability.saveScenario(project.id, { kind: 'api', name: method, flowId: flow.id, fixtureId: fixture.id, mutation: { kind: 'empty-list', pointer: '/items' }, expectedText: 'Empty' });
      const before = calls.length, mutated = service.reliability.run(scenario.id); await service.active.get(mutated.id); assert.equal(store.get<any>('runs', mutated.id).status, 'passed'); assert.equal(calls.length, before);
      service.reliability.saveFixture(project.id, { ...fixture, request: { mode: 'exact', json: { id: 2 } } }, fixture.id);
      const mismatch = service.reliability.saveScenario(project.id, { kind: 'api', name: 'Mismatch', flowId: flow.id, fixtureId: fixture.id, mutation: { kind: 'empty-list', pointer: '/items' }, expectedText: 'Empty' });
      const blocked = service.reliability.run(mismatch.id); await service.active.get(blocked.id); assert.equal(store.get<any>('runs', blocked.id).status, 'failed'); assert.equal(calls.length, before);
    }
  } finally { store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('recording dropdowns, uploads, iframe controls, popup and navigation produces replayable steps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-rich-recording-')); writeFileSync(join(root, 'attachment.txt'), 'local fixture');
  const html = '<label>Choice<select><option value="choice-first">First</option><option value="choice-second">Second</option></select></label><label>Attachment<input type="file"></label><iframe src="/frame"></iframe><a href="/next" target="_blank">Open tab</a>';
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/frame' ? '<label>Frame input<input></label><button>Apply</button>' : req.url === '/next' ? '<main>Next page</main><button>Finish</button>' : html); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const store = new Store(join(root, 'data')), service = new ControlRoom(store), recorder = new FlowRecorder();
  try {
    const project = service.addProject({ name: 'Rich recorder', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const started = await recorder.start(project, {}, true), page = recorder.sessions.get(started.id)!.page;
    await page.getByLabel('Choice').focus(); await page.getByLabel('Choice').press('End'); await page.getByLabel('Choice').press('Tab'); await page.getByLabel('Attachment').setInputFiles(join(root, 'attachment.txt')); await page.frameLocator('iframe').getByLabel('Frame input').fill('private-frame-value'); await page.frameLocator('iframe').getByRole('button', { name: 'Apply' }).click();
    const popupPromise = page.waitForEvent('popup'); await page.getByRole('link', { name: 'Open tab' }).click(); const popup = await popupPromise; await popup.getByText('Next page').waitFor();
    // Wait for the recorder's ordered popup registration, not a timing guess.
    for (let i = 0; i < 100 && recorder.sessions.get(started.id)!.tabs.size < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await popup.getByRole('button', { name: 'Finish' }).click(); await recorder.navigate(started.id, { action: 'reload', tab: 'tab2' });
    const draft = await recorder.stop(started.id); assert.ok(!JSON.stringify(draft).includes('private-frame-value')); assert.ok(!JSON.stringify(draft).includes('attachment.txt'));
    assert.ok(draft.flow.steps.some(s => s.action === 'select')); assert.ok(draft.flow.steps.some(s => s.action === 'upload')); assert.ok(draft.flow.steps.some(s => s.frames?.length)); assert.ok(draft.flow.steps.some(s => s.action === 'popup'));
    for (const step of draft.flow.steps) if ('env' in step && step.env) process.env[step.env] = step.action === 'upload' ? 'attachment.txt' : step.action === 'select' ? 'choice-second' : 'replay-frame-value';
    draft.flow.steps.push({ action: 'assertText', text: 'Next page', tab: 'tab2' }); const flow = service.saveFlow(project.id, draft.flow), run = service.run(flow.id); await service.active.get(run.id); assert.equal(store.get<any>('runs', run.id).status, 'passed', store.get<any>('runs', run.id).error);
    service.saveFlow(project.id, { ...draft.flow, name: 'Updated' }, flow.id); assert.notEqual(store.get<any>('runs', run.id).flow.name, 'Updated');
    for (const step of draft.flow.steps) if ('env' in step && step.env) delete process.env[step.env];
  } finally { for (const id of recorder.sessions.keys()) await recorder.stop(id); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('command output redacts split secrets, records exits and stops process trees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-command-')), store = new Store(join(root, 'data')), service = new ControlRoom(store);
  process.env.DCR_TEST_SECRET = 'opaque-secret-command-value';
  writeFileSync(join(root, 'log.cjs'), "process.stdout.write(process.env.DCR_TEST_SECRET.slice(0,8)+'\\x1b[0m'); setTimeout(()=>{process.stdout.write(process.env.DCR_TEST_SECRET.slice(8)+'\\ncomplete\\n');},20);");
  writeFileSync(join(root, 'wait.cjs'), "console.log('running');setInterval(()=>{},1000)");
  try {
    const project = service.addProject({ name: 'Commands', path: root, baseUrl: 'http://localhost:3333' });
    const run = service.commands.start(project, 'task', 'Log', `"${process.execPath}" log.cjs`); const child = service.commands.children.get(run.id)!; await once(child, 'close');
    const final = store.get<any>('environments', run.id); assert.equal(final.status, 'passed'); assert.match(final.output, /complete/); assert.ok(!final.output.includes('opaque-secret')); assert.match(final.output, /\[INPUT\]/);
    const waiting = service.commands.start(project, 'task', 'Wait', `"${process.execPath}" wait.cjs`); const closed = once(service.commands.children.get(waiting.id)!, 'close'); await service.commands.stop(waiting.id); await closed; assert.equal(store.get<any>('environments', waiting.id).status, 'stopped');
  } finally { await service.commands.close(); delete process.env.DCR_TEST_SECRET; store.close(); }
});

test('scheduled cleanup preserves references and framework overrides can be reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-retention-')), store = new Store(root), service = new ControlRoom(store);
  try {
    let project: Project = service.addProject({ name: 'Retention', path: root, baseUrl: 'http://localhost:3333', config: { scheduledCleanup: true, retentionDays: 1, detectionOverride: { framework: 'Custom app', packageManager: 'bun' } } });
    assert.equal(project.detection.framework, 'Custom app');
    for (const id of ['expired', 'pinned', 'active']) store.put('runs', { id, projectId: project.id, status: id === 'active' ? 'running' : 'passed', startedAt: '2000-01-01' });
    store.put('matrices', { id: 'matrix', projectId: project.id, runIds: ['pinned'] });
    cleanupScheduled(store); assert.deepEqual(store.list<any>('runs').map(r => r.id).sort(), ['active', 'pinned']);
    project = service.saveConfig(project.id, { ...project.config, detectionOverride: {} }); assert.notEqual(project.detection.framework, 'Custom app');
  } finally { store.close(); }
});

test('React inspection resolves current hooks after a render and omits private values; loader is development only', async () => {
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';function Counter(){const [count,setCount]=useState(0);const[info]=useState({secret:'never-save',label:'hidden-private-text'});return <><button id="count" onClick={()=>setCount(count+1)}>Count {count}</button><span data-private>hidden-private-text</span></>};createRoot(document.getElementById('root')).render(<Counter/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, format: 'iife', write: false });
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = mkdtempSync(join(tmpdir(), 'dcr-react-')), store = new Store(root), service = new ControlRoom(store), browser = await chromium.launch();
  try {
    const project = service.addProject({ name: 'React', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { understanding: { reactInspection: true } } }); const page = await browser.newPage(); await page.goto(project.baseUrl); await page.getByText('Count 0').waitFor();
    const before = await inspectReact(page, '#count', project); assert.equal(before.owners[0].stateHooks[0].value, 0); await page.locator('#count').click(); await page.getByText('Count 1').waitFor();
    const after = await inspectReact(page, '#count', project); assert.equal(after.owners[0].stateHooks[0].value, 1); assert.deepEqual(after.handlers, ['onClick']); assert.ok(!JSON.stringify(after).includes('never-save')); assert.ok(!JSON.stringify(after).includes('hidden-private-text'));
    const privateReport = await inspectReact(page, '[data-private]', project); assert.equal(privateReport.status, 'private');
    const source = 'export const A=()=> <button>Hi</button>', context = { rootContext: root, resourcePath: join(root, 'A.tsx') };
    assert.equal(loader.call({ ...context, mode: 'production' }, source), source); assert.match(loader.call({ ...context, mode: 'development' }, source), /data-dcr-source/);
  } finally { await browser.close(); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('iframe input screenshots are masked and evidence follows the selected tab', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/frame' ? '<style>body{margin:0}input{width:220px;height:60px;box-sizing:border-box}</style><label><span style="display:none">Private input</span><input aria-label="Private input"></label>' : req.url === '/other' ? '<body style="background:white">Other tab</body>' : '<body style="background:rgb(17,34,51)"><iframe src="/frame" style="position:absolute;left:20px;top:30px;width:300px;height:100px;border:0"></iframe><main style="position:absolute;top:180px">Ready</main></body>'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = mkdtempSync(join(tmpdir(), 'dcr-frame-mask-')), store = new Store(root), service = new ControlRoom(store), browser = await chromium.launch(); process.env.DCR_FRAME_SECRET = 'private-frame-text';
  try {
    const project = service.addProject({ name: 'Mask', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const flow = service.saveFlow(project.id, { name: 'Frame mask', steps: [{ action: 'goto', url: '/' }, { action: 'newTab', name: 'side', url: '/other' }, { action: 'switchTab', name: 'main' }, { action: 'fill', label: 'Private input', frames: ['iframe'], env: 'DCR_FRAME_SECRET' }, { action: 'assertText', text: 'Ready' }] });
    const run = service.run(flow.id); await service.active.get(run.id); assert.equal(store.get<any>('runs', run.id).status, 'passed');
    const artifact = store.list<any>('artifacts').find(a => a.runId === run.id && a.name === 'screenshot.png'); assert.ok(artifact);
    const page = await browser.newPage(); const pixels = await page.evaluate(async base64 => { const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return [Array.from(context.getImageData(80, 50, 1, 1).data), Array.from(context.getImageData(500, 500, 1, 1).data)]; }, store.readArtifact(artifact).toString('base64'));
    assert.deepEqual(pixels[0], [255, 0, 255, 255]); assert.deepEqual(pixels[1], [17, 34, 51, 255]);
  } finally { delete process.env.DCR_FRAME_SECRET; await browser.close(); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('recorder assigns separate environment references when a field is revisited', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<label>Search<input></label><button>Apply</button><button>Done</button>'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = mkdtempSync(join(tmpdir(), 'dcr-input-episodes-')), store = new Store(root), service = new ControlRoom(store), recorder = new FlowRecorder();
  try {
    const project = service.addProject({ name: 'Episodes', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` }); const session = await recorder.start(project, {}, true), page = recorder.sessions.get(session.id)!.page;
    await page.getByLabel('Search').fill('query-alpha'); await page.getByRole('button', { name: 'Apply' }).click(); await page.getByLabel('Search').fill('query-beta'); await page.getByRole('button', { name: 'Done' }).click();
    const draft = await recorder.stop(session.id), fills = draft.flow.steps.filter(s => s.action === 'fill'); assert.equal(fills.length, 2); assert.notEqual(fills[0].env, fills[1].env); assert.ok(!JSON.stringify(draft).includes('query-alpha'));
  } finally { for (const id of recorder.sessions.keys()) await recorder.stop(id); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
