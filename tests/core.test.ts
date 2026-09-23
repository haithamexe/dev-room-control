import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { redact, assertTarget } from '../packages/core/src/redact.ts';
import { Store } from '../packages/storage/src/index.ts';
import { sanitizeTrace } from '../packages/runner/src/index.ts';
import { ControlRoom } from '../packages/modules/src/service.ts';
import type { Artifact } from '../packages/core/src/index.ts';

test('redaction covers nested secrets, headers, URLs and personal data', () => {
  const result = JSON.stringify(redact({ token: 'seeded-secret', data: { email: 'alice@example.com', cardNumber: '4242424242424242' }, headers: [{ name: 'Authorization', value: 'Bearer abc' }], message: 'password=hunter2 Bearer abcd https://localhost/api?token=leak', extra: 'sensitive-custom' }, ['extra']));
  for (const secret of ['seeded-secret', 'alice@example.com', '4242424242424242', 'hunter2', 'abcd', 'leak', 'sensitive-custom']) assert.ok(!result.includes(secret), secret);
});
test('targets require loopback or explicit test/staging allowlisting', () => {
  const local = { environment: 'local', allowedOrigins: [] };
  assert.equal(assertTarget('/checkout', 'http://localhost:3000', local).pathname, '/checkout');
  for (const target of ['https://example.com', 'file:///etc/passwd', 'http://user:secret@localhost:3000', 'http://localhost:4000']) assert.throws(() => assertTarget(target, 'http://localhost:3000', local));
  assert.equal(assertTarget('https://test.example.com', 'https://test.example.com', { environment: 'staging', allowedOrigins: ['https://test.example.com'] }).origin, 'https://test.example.com');
});
test('trace sanitizer strips resources and sensitive action input', () => {
  const raw = zipSync({ 'trace.trace': strToU8(JSON.stringify({ type: 'before', params: { value: 'secret-input', url: 'http://localhost?token=leaked' } }) + '\n'), 'trace.network': strToU8('raw-auth'), 'resources/abc': strToU8('raw-body') });
  const clean = unzipSync(sanitizeTrace(raw, []));
  assert.deepEqual(Object.keys(clean), ['trace.trace']);
  assert.ok(!strFromU8(clean['trace.trace']).includes('secret-input')); assert.ok(!strFromU8(clean['trace.trace']).includes('leaked'));
});
test('migrations are repeatable, evidence persists, and project deletion cleans artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-store-test-'));
  try {
    let store = new Store(root); store.put('projects', { id: 'project-1' }); store.put('notes', { id: 'note-1', projectId: 'project-1', text: 'Resume exactly here' });
    const artifact = store.artifact('project-1', 'run-1', 'timeline.json', 'application/json', Buffer.from('{}')); store.close();
    store = new Store(root); assert.equal(store.list<any>('notes')[0].text, 'Resume exactly here'); assert.equal(store.readArtifact(artifact).toString(), '{}'); assert.equal(store.db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 1);
    store.deleteProject('project-1'); assert.equal(store.list('notes').length, 0); assert.ok(!existsSync(join(root, 'project-1'))); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('task preview pauses branch changes in a dirty repository and confines source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-task-test-'));
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' }); writeFileSync(join(root, 'example.ts'), 'export const value = 1;');
    const store = new Store(join(root, '.data')), service = new ControlRoom(store);
    const p = service.addProject({ name: 'Test', path: root, baseUrl: 'http://localhost:3000' });
    const task = service.saveTask(p.id, { name: 'Fix', files: ['example.ts'], branch: 'fix/example' });
    assert.match(service.previewTask(task.id).branchMessage, /paused/); assert.equal(service.previewTask(task.id).git.branch, 'main');
    const escaped = service.saveTask(p.id, { name: 'Escape', files: ['../outside.ts'] }); assert.throws(() => service.previewTask(escaped.id));
    assert.throws(() => service.saveFlow(p.id, { name: 'Unsafe', steps: [{ action: 'fill', label: 'Password', value: 'dont-store' }] }));
    assert.throws(() => service.deleteProject(p.id, 'wrong name')); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real browser input never survives in action traces or console events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-input-test-')), store = new Store(root), service = new ControlRoom(store);
  const secret = 'unlabelled-seeded-credential-3f9a'; process.env.DCR_REGRESSION_INPUT = secret;
  const server = createServer((req, res) => {
    if (req.url === '/echo') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: secret, nested: { type: secret } })); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<label>Password<input type="password" aria-label="Password" oninput="console.error(\'typed: \' + this.value); fetch(\'/echo\').then(() => document.querySelector(\'p\').textContent = \'Ready\')"></label><p>Waiting</p>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const p = service.addProject({ name: 'Input test', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, config: { captureBodies: true } });
    const flow = service.saveFlow(p.id, { name: 'Fill safely', steps: [{ action: 'goto', url: '/' }, { action: 'fill', label: 'Password', env: 'DCR_REGRESSION_INPUT' }, { action: 'assertText', text: 'Ready' }] });
    const run = service.run(flow.id); assert.equal((await service.active.get(run.id))!.status, 'passed');
    assert.ok(!JSON.stringify(store.list('events')).includes(secret));
    assert.ok(store.list<any>('events').some(e => e.data.body?.id === '[INPUT]' && e.data.body?.nested?.type === '[INPUT]'));
    const trace = store.list<Artifact>('artifacts').find(a => a.name === 'trace.zip')!;
    const clean = Object.values(unzipSync(store.readArtifact(trace))).map(bytes => strFromU8(bytes)).join('\n');
    assert.ok(!clean.includes(secret)); assert.ok(clean.includes('fill'));
  } finally { delete process.env.DCR_REGRESSION_INPUT; await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('HTTP redirects never contact an origin outside the configured target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-redirect-test-')), store = new Store(root), service = new ControlRoom(store);
  let destinationHits = 0;
  const destination = createServer((req, res) => { destinationHits++; res.end('unauthorized destination'); }); destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const server = createServer((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(destination.address() as any).port}/private` }); res.end(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const p = service.addProject({ name: 'Redirect test', path: root, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const flow = service.saveFlow(p.id, { name: 'Redirect boundary', steps: [{ action: 'goto', url: '/' }] });
    const run = service.run(flow.id); assert.equal((await service.active.get(run.id))!.status, 'failed');
    assert.equal(destinationHits, 0); assert.ok(store.list<any>('events').some(e => e.title === 'HTTP redirect blocked by target policy'));
  } finally { await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]); store.close(); rmSync(root, { recursive: true, force: true }); }
});
