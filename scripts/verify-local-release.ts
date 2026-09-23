import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../packages/storage/src/index.ts';
const profile = mkdtempSync(join(tmpdir(), 'dcr-installed-'));
const executablePath = process.env.DCR_RELEASE_EXE || resolve('build-artifacts/release/win-unpacked/Developer Control Room.exe');
const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: { ...process.env, DCR_DATA_DIR: join(profile, 'data'), DCR_PORT: '', PATH: process.env.SystemRoot + '\\System32' } });
let commandPid: number | undefined;
let shutdownMatrixId: string | undefined;
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
  await window.reload();
  await window.getByLabel('Current project').selectOption(project.id);
  await window.getByRole('button', { name: 'Bug Time Machine', exact: true }).click();
  await window.getByRole('button', { name: 'Create / import flow' }).click();
  const editor = window.getByRole('dialog', { name: 'Create a browser flow' });
  await editor.getByLabel('Flow name', { exact: true }).fill('Visual release check');
  await editor.getByRole('group', { name: 'Step 2', exact: true }).getByLabel('text', { exact: true }).fill('The everyday collection');
  await editor.getByRole('button', { name: 'Save flow', exact: true }).click();
  const card = window.getByRole('article').filter({ has: window.getByRole('heading', { name: 'Visual release check', exact: true }) });
  await card.getByRole('button', { name: 'Edit steps' }).click();
  await window.getByRole('dialog').getByLabel('Description', { exact: true }).fill('Edited visually in the packaged app');
  await window.getByRole('dialog').getByRole('button', { name: 'Save flow' }).click();
  await card.getByText('Edited visually in the packaged app').waitFor();
  const script = join(profile, 'import.spec.ts'); writeFileSync(script, "import {test,expect} from '@playwright/test'; test('Imported release check',async({page})=>{await page.goto('/');await expect(page.getByText('The everyday collection',{exact:true})).toBeVisible();});");
  await window.getByRole('button', { name: 'Create / import flow' }).click();
  await window.getByLabel('Import JSON or a Playwright test').setInputFiles(script);
  await expect(window.getByRole('dialog').getByLabel('Flow name', { exact: true })).toHaveValue('Imported release check');
  await window.getByRole('dialog').getByRole('button', { name: 'Save flow' }).click();
  await window.getByRole('heading', { name: 'Imported release check', exact: true }).waitFor();
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByLabel('Framework override', { exact: true }).fill('Release fixture');
  await window.getByLabel('Package manager override').selectOption('npm');
  await window.getByRole('checkbox', { name: /Clean expired run evidence hourly/ }).check();
  await window.getByRole('button', { name: 'Save settings' }).click();
  await window.getByText('Project settings saved', { exact: true }).waitFor();
  const updated = (await api('/overview')).projects.find((p: any) => p.id === project.id); assert.equal(updated.detection.framework, 'Release fixture'); assert.equal(updated.config.scheduledCleanup, true);
  await api(`/projects/${project.id}/config`, { ...updated.config, commands: { log: 'echo packaged-output-check', linger: 'ping -t 127.0.0.1' } }, 'PUT');
  const task = await api(`/projects/${project.id}/tasks`, { name: 'Packaged command', command: 'log' });
  await api(`/tasks/${task.id}/launch`, { approveCommand: true });
  await window.getByRole('button', { name: 'Workspace Launcher', exact: true }).click();
  await window.getByText(/log.*passed.*exit 0/).waitFor();
  await window.getByText(/log.*passed.*exit 0/).click();
  await window.getByText('packaged-output-check', { exact: true }).waitFor();
  const linger = await api(`/projects/${project.id}/tasks`, { name: 'Shutdown ownership', command: 'linger' });
  commandPid = (await api(`/tasks/${linger.id}/launch`, { approveCommand: true })).commandRun.pid;
  const latestConfig = (await api('/overview')).projects.find((p: any) => p.id === project.id).config;
  await api(`/projects/${project.id}/config`, { ...latestConfig, modules: [...new Set([...latestConfig.modules, 'api'])], reliability: { ...latestConfig.reliability, apiPaths: ['/api/products'] } }, 'PUT');
  const pendingFlow = await api(`/projects/${project.id}/flows`, { name: 'Shutdown matrix flow', steps: [{ action: 'goto', url: '/catalog' }, { action: 'assertText', text: 'Intentionally pending shutdown assertion' }] });
  const fixture = await api(`/projects/${project.id}/fixtures`, { name: 'Shutdown fixture', url: project.baseUrl + '/api/products', json: { items: [] } });
  const cases = [];
  for (const name of ['First pending case', 'Remaining case']) cases.push((await api(`/projects/${project.id}/scenarios`, { kind: 'api', name, flowId: pendingFlow.id, fixtureId: fixture.id, mutation: { kind: 'empty-list', pointer: '/items' }, expectedText: 'Intentionally pending shutdown assertion' })).id);
  shutdownMatrixId = (await api(`/projects/${project.id}/matrices`, { name: 'Shutdown matrix', scenarioIds: cases })).id;
  await window.screenshot({ path: 'test-results/local-release.png', timeout: 15000 });
  console.log('PASS packaged visual create/edit, Playwright import, settings, command output, context export and sandbox. Test profile:', profile);
} finally { await app.close(); }
if (commandPid) { assert.throws(() => process.kill(commandPid!, 0), /ESRCH|No such process/); console.log('PASS native shutdown stops the owned command process tree.'); }
if (shutdownMatrixId) { const store = new Store(join(profile, 'data')); try { const matrix = store.get<any>('matrices', shutdownMatrixId); assert.equal(matrix.status, 'cancelled'); assert.equal(matrix.runIds.length, 1); assert.ok(matrix.plans.length === 2); console.log('PASS native shutdown preserves the remaining matrix plan without starting another case.'); } finally { store.close(); } }
