import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { handoff } from '../packages/modules/src/handoff.ts';
import { sourceText } from '../packages/repo-analysis/src/sources.ts';
import { sourceProps } from '../packages/core/src/bridge.ts';
import { inspectPage, scanDrift } from '../packages/runner/src/inspect.ts';

test('risk graph distinguishes changed code, transitive imports, routes, naming hints and runtime gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-graph-')), store = new Store(join(root, '.dcr')), service = new ControlRoom(store);
  const write = (name: string, text: string) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text); };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  try {
    write('src/Button.tsx', 'export const Button = () => <button>Go</button>');
    write('src/app/one/page.tsx', 'import {Button} from "../../Button"; export default Button;');
    write('src/app/two/page.tsx', 'export {Button as default} from "../../Button";');
    write('src/Button.test.ts', 'import {Button} from "./Button"; export const subject = Button;');
    write('src/Button.spec.ts', 'export const namingHint = true;');
    write('src/lazy.ts', 'export const load = (name: string) => import(name);');
    write('src/router.tsx', 'import {Button} from "./Button"; export const route = <Route path="/shop" element={<Button/>}/>;');
    write('.env', 'PRIVATE_VALUE=never-export-this');
    git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-m', 'baseline');
    write('src/Button.tsx', 'export const Button = () => <button>Changed</button>');
    const p = service.addProject({ name: 'Graph', path: root, baseUrl: 'http://localhost:3000' });
    const report = service.understanding.risk(p.id, { base: 'HEAD' });
    assert.deepEqual(report.data.changed.filter((f: string) => !f.startsWith('.dcr')), ['src/Button.tsx']);
    assert.ok(report.data.dependents.some((d: any) => d.file === 'src/app/two/page.tsx'));
    assert.deepEqual(report.data.routes.filter((r: any) => r.provenance === 'static').map((r: any) => r.path).sort(), ['/one', '/two']);
    assert.ok(report.data.routes.some((r: any) => r.path === '/shop' && r.provenance === 'heuristic'));
    assert.ok(report.data.tests.some((t: any) => t.file.endsWith('Button.spec.ts') && t.provenance === 'heuristic'));
    assert.ok(report.data.tests.some((t: any) => t.file.endsWith('Button.test.ts') && t.provenance === 'static'));
    assert.ok(report.data.gaps.some((g: string) => g.includes('runtime module expression')));
    assert.throws(() => service.understanding.risk(p.id, { base: '--output=elsewhere' }));
    assert.throws(() => sourceText(p, '.env'));
    const bundle = handoff(store, { kind: 'report', id: report.id }); assert.match(bundle.text, /src\/Button.tsx/); assert.ok(!bundle.text.includes('never-export-this'));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('general AI handoff works without errors and applies current source/body redaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-handoff-')), store = new Store(root), service = new ControlRoom(store);
  try {
    writeFileSync(join(root, 'view.ts'), 'export const privateValue = "custom-seeded-sensitive";\nexport const title = "A healthy feature";');
    const p = service.addProject({ name: 'Healthy project', path: root, baseUrl: 'http://localhost:3000', config: { redactFields: ['privateValue'] } });
    const task = service.saveTask(p.id, { name: 'Improve healthy feature', files: ['view.ts'], notes: 'Explain the feature and improve its wording.' });
    const bundle = handoff(store, { kind: 'task', id: task.id });
    assert.match(bundle.text, /A healthy feature/); assert.match(bundle.text, /Improve healthy feature/); assert.ok(!bundle.text.includes('custom-seeded-sensitive'));
    assert.match(bundle.text, /sourceExcerpts/); assert.match(bundle.text, /omissions/);
    assert.ok(!handoff(store, { kind: 'task', id: task.id, includeSource: false }).text.includes('A healthy feature'));
    assert.deepEqual(sourceProps({ file: 'view.ts', component: 'View' }), {});
    assert.equal(sourceProps({ file: 'view.ts', component: 'View' }, true)['data-dcr-source'], 'view.ts');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('source exclusions survive filesystem aliases into a private project directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-source-alias-')), store = new Store(join(root, '.dcr')), service = new ControlRoom(store);
  try {
    mkdirSync(join(root, 'private')); writeFileSync(join(root, 'private', 'data.ts'), 'export const value = "hidden-seeded-value";');
    symlinkSync(join(root, 'private'), join(root, 'public-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const p = service.addProject({ name: 'Private alias', path: root, baseUrl: 'http://localhost:3000', config: { ignorePaths: ['private'] } });
    assert.throws(() => sourceText(p, 'public-alias/data.ts'), /excluded/);
    const task = service.saveTask(p.id, { name: 'Alias reference', files: ['public-alias/data.ts'] });
    const bundle = handoff(store, { kind: 'task', id: task.id }); assert.ok(!bundle.text.includes('hidden-seeded-value')); assert.match(bundle.text, /excluded by privacy rules/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('private DOM regions omit text, attributes and metadata from persisted evidence and AI exports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-dom-privacy-')), store = new Store(root), service = new ControlRoom(store);
  const secret = 'private-fixture-abcd';
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<main><p>Public text</p><span class="private">${secret}</span><button data-private aria-label="${secret}" data-dcr-component="${secret}">${secret}</button></main>`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const p = service.addProject({ name: 'Private DOM', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { modules: ['why'], maskSelectors: ['.private'], understanding: { bridgeEnabled: true } } });
    for (const selector of ['main', 'button', '.private']) {
      const report = await service.understanding.element(p.id, { route: '/', selector });
      assert.ok(!JSON.stringify(report).includes(secret)); assert.ok(!handoff(store, { kind: 'report', id: report.id }).text.includes(secret));
      if (selector !== 'main') { assert.equal(report.data.text, '[PRIVATE]'); assert.deepEqual(report.data.attributes, {}); assert.equal(report.data.instrumentation, null); }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('drift normalizes relative tokens in element context and restores original inline styles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-relative-css-')), store = new Store(root), service = new ControlRoom(store);
  const inline = 'font-size:32px;--space:1em;padding-top:var(--space);color:rgb(20,30,40);background-color:currentColor';
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<body style="font-size:16px"><button style="${inline}">Relative values</button></body>`); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const p = service.addProject({ name: 'Relative CSS', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    await inspectPage(p, '/', async page => {
      const result = await scanDrift(page, [{ name: 'Spacing', selector: 'button', property: 'padding-top', values: ['var(--space)'], tolerance: 0 }, { name: 'Color', selector: 'button', property: 'background-color', values: ['currentColor'], tolerance: 0 }]);
      assert.deepEqual(result.results, []); assert.equal(await page.getByRole('button').getAttribute('style'), inline);
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
