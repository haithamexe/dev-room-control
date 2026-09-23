import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { configSchema, type Project } from '../packages/core/src/index.ts';
import { instrumentJsx, dcrSourceBridge } from '../packages/instrumentation/src/vite.ts';
import { importResolver } from '../packages/repo-analysis/src/imports.ts';
import { FlowRecorder } from '../packages/modules/src/recorder.ts';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';

test('development JSX mapping preserves explicit metadata and identifies enclosing source declarations', () => {
  const root = join(tmpdir(), 'dcr-source-test'), file = join(root, 'src', 'Button.tsx');
  const code = 'export const Button = () => (\n <button>Save</button>\n);\nconst Manual = () => <div data-dcr-source="custom.tsx"/>;';
  const transformed = instrumentJsx(code, file, root);
  assert.match(transformed, /data-dcr-source=\{"src\/Button.tsx"\}/); assert.match(transformed, /data-dcr-line="2"/); assert.match(transformed, /data-dcr-component=\{"Button"\}/);
  assert.equal((transformed.match(/data-dcr-provenance/g) || []).length, 1); assert.equal(dcrSourceBridge().apply, 'serve');
  assert.equal(instrumentJsx(code, join(root, '../private.tsx'), root), code);
});

test('import resolver handles JSONC, local extends and path aliases under privacy restrictions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-alias-test-')); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'base.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}');
  writeFileSync(join(root, 'tsconfig.json'), '{ // comment\n "extends":"./base.json", "compilerOptions":{"jsx":"react-jsx"}}');
  writeFileSync(join(root, 'src/Button.tsx'), 'export const Button = 1;');
  const project = { path: root, config: configSchema.parse({}) } as Project, gaps: string[] = [];
  const resolve = importResolver(project, ['src/Button.tsx', 'src/Page.tsx'], gaps);
  assert.equal(resolve('src/Page.tsx', '@/Button'), 'src/Button.tsx'); assert.equal(resolve('src/Page.tsx', './Button.js'), 'src/Button.tsx');
  assert.equal(resolve('src/Page.tsx', '../../outside'), undefined); assert.ok(gaps.some(gap => gap.includes('unresolved')));
});

test('recorded typed values become environment references and reviewed flow replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-recorder-')), store = new Store(root), service = new ControlRoom(store), recorder = new FlowRecorder();
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<label>Name<input id="name"></label><label><input type="checkbox" id="agree">Agree</label><button onclick="document.querySelector(\'main\').textContent=\'Saved\'">Save</button><main></main>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const project = service.addProject({ name: 'Recorder', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const started = await recorder.start(project, {}, true), page = recorder.sessions.get(started.id)!.page;
    await page.getByLabel('Name', { exact: true }).fill('opaque-sensitive-input'); await page.getByLabel('Agree', { exact: true }).check(); await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    const draft = await recorder.stop(started.id); assert.ok(!JSON.stringify(draft).includes('opaque-sensitive-input'));
    assert.ok(draft.flow.steps.some(step => step.action === 'fill' && step.env === 'DCR_INPUT_1')); assert.ok(draft.flow.steps.some(step => step.action === 'check' && step.checked));
    draft.flow.steps.push({ action: 'assertText', text: 'Saved' }); process.env.DCR_INPUT_1 = 'different-safe-input';
    const flow = service.saveFlow(project.id, draft.flow), run = service.run(flow.id); assert.equal((await service.active.get(run.id))!.status, 'passed');
  } finally { for (const id of recorder.sessions.keys()) await recorder.stop(id); delete process.env.DCR_INPUT_1; store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('instrumented interaction links explicit request and state evidence to a run and inspector', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-causal-')); writeFileSync(join(root, 'handler.ts'), '// instrumented test handler');
  const built = await build({ entryPoints: ['packages/instrumentation/src/runtime.ts'], bundle: true, format: 'iife', globalName: 'Dcr', write: false, platform: 'browser' });
  const script = built.outputFiles[0].text;
  const server = createServer((req, res) => { if (req.url?.startsWith('/api/value')) return res.end('{}'); res.setHeader('Content-Type', 'text/html'); res.end(`<button id="load">Load</button><main>Idle</main><script>${script}\nlet state={phase:'idle',secret:'must-not-persist'};document.querySelector('button').onclick=()=>Dcr.traceInteraction({file:'handler.ts',component:'Example',handler:'load'},async scope=>{await scope.request('/api/value?token=private');state.phase='ready';document.querySelector('main').textContent='Ready'},{enabled:true,state:()=>state});</script>`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const store = new Store(join(root, 'evidence')), service = new ControlRoom(store);
  try {
    const project = service.addProject({ name: 'Instrumented', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { understanding: { bridgeEnabled: true } } });
    const flow = service.saveFlow(project.id, { name: 'Load', steps: [{ action: 'goto', url: '/' }, { action: 'click', name: 'Load' }, { action: 'assertText', text: 'Ready' }] });
    const run = service.run(flow.id); assert.equal((await service.active.get(run.id))!.status, 'passed');
    const event = store.list<any>('events').find(event => event.title === 'Instrumented interaction'); assert.ok(event); assert.equal(event.data.before.phase, 'idle'); assert.equal(event.data.after.phase, 'ready'); assert.equal(event.data.requests[0].status, 200); assert.ok(!JSON.stringify(event).includes('must-not-persist')); assert.ok(!event.data.requests[0].url.includes('?'));
    const report = await service.understanding.element(project.id, { route: '/', selector: '#load', interact: true }); assert.equal(report.data.interactions.length, 1); assert.equal(report.data.interactions[0].metadata.handler, 'load');
  } finally { store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('recorder excludes reflected inputs/private descendants and records aria-labelledby names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-recorder-privacy-')), recorder = new FlowRecorder();
  const server = createServer((_req, res) => { res.setHeader('Content-Type','text/html'); res.end('<label>Name<input oninput="document.querySelector(\'#reflected\').textContent=this.value"></label><button id="reflected">Next</button><button id="private">Open <span data-private>opaque-private-descendant</span></button><span id="accessible">Save changes</span><button aria-labelledby="accessible">Icon</button>'); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const project = { id:'recording', path:root, baseUrl:`http://127.0.0.1:${(server.address() as any).port}`, config:configSchema.parse({}) } as Project;
    const started = await recorder.start(project, {}, true), page=recorder.sessions.get(started.id)!.page;
    await page.getByLabel('Name').fill('opaque-entered-value');
    await page.getByLabel('Name').evaluate(element => element.removeAttribute('oninput'));
    await page.getByLabel('Name').fill('replacement-entered-value'); await page.getByLabel('Name').fill('');
    await page.locator('#reflected').click(); await page.locator('#private').click(); await page.getByRole('button',{name:'Save changes'}).click();
    const draft = await recorder.stop(started.id); assert.ok(!JSON.stringify(draft).includes('opaque-entered-value')); assert.ok(!JSON.stringify(draft).includes('opaque-private-descendant'));
    assert.ok(draft.flow.steps.some(step=>step.action==='click' && step.name==='Save changes')); assert.ok(draft.warnings.length>1);
  } finally { for(const id of recorder.sessions.keys()) await recorder.stop(id); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
