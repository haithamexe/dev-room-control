import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const profile = mkdtempSync(join(tmpdir(), 'dcr-installed-'));
const executablePath = process.env.DCR_RELEASE_EXE || resolve('build-artifacts/release/win-unpacked/Developer Control Room.exe');
const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: { ...process.env, DCR_DATA_DIR: join(profile, 'data'), DCR_PORT: '', PATH: process.env.SystemRoot + '\\System32' } });
try {
  const window = await app.firstWindow(); await window.getByRole('heading', { name: 'Your development, in focus.' }).waitFor();
  const url = new URL(window.url()).origin;
  const session = await (await fetch(url + '/api/session')).json() as any;
  const api = async (path: string, data?: unknown, method = 'POST') => { const response = await fetch(url + '/api' + path, { method: data === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'X-DCR-Token': session.token }, body: data === undefined ? undefined : JSON.stringify(data) }); const result = await response.json() as any; assert.ok(response.ok, JSON.stringify(result)); return result; };
  const project = await api('/demo', {});
  const overview = await api('/overview'); const flow = overview.flows.find((f: any) => f.name === 'Browse the storefront'); assert.ok(flow);
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    await api(`/projects/${project.id}/config`, { ...project.config, browser }, 'PUT');
    const run = await api(`/flows/${flow.id}/run`, {}); let detail;
    for (let tries = 0; tries < 150; tries++) { detail = await api(`/runs/${run.id}`); if (detail.run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.equal(detail.run.status, 'passed', `${browser}: ${detail.run.error}`); assert.ok(detail.artifacts.some((a: any) => a.name === 'screenshot.png'));
    console.log(`PASS packaged ${browser}: embedded runtime, bundled engine, worker and evidence (Node excluded from PATH).`);
  }
  const context = await api('/handoff', { kind: 'project', id: project.id, includeSource: true }); assert.ok(context.text.includes(project.name));
  const preferences = await app.evaluate(({ BrowserWindow }) => { const p = (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences(); return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox }; });
  assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  mkdirSync('test-results', { recursive: true });
  await app.evaluate(({ BrowserWindow }) => { const win=BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  await window.bringToFront();
  await window.screenshot({ path: 'test-results/local-release.png', timeout: 15000 });
  console.log('PASS packaged demo, context export, sandbox and dashboard. Test profile:', profile);
} finally { await app.close(); }
