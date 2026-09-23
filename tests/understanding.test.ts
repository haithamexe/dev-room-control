import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../packages/storage/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import { handoff } from '../packages/modules/src/handoff.ts';
import { sourceText } from '../packages/repo-analysis/src/sources.ts';
import { sourceProps } from '../packages/core/src/bridge.ts';

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
