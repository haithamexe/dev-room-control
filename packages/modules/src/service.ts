import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { configSchema, flowSchema, taskSchema, type Project, type Run, type Flow, type Task } from '../../core/src/index.ts';
import { assertTarget, redact, redactText } from '../../core/src/redact.ts';
import { Store, now, id, within } from '../../storage/src/index.ts';
import { detect, snapshot, safeSource } from '../../repo-analysis/src/index.ts';
import { createRun, executeRun } from '../../runner/src/index.ts';
import { ReliabilityCommands } from './reliability.ts';
import { assertScenario } from '../../core/src/reliability-policy.ts';
import { paymentCases, type ScenarioDefinition, type Scenario, type ApiFixture } from '../../core/src/reliability.ts';
import { UnderstandingCommands } from './understanding.ts';

export class ControlRoom extends EventEmitter {
  active = new Map<string, Promise<Run>>();
  processes = new Set<ReturnType<typeof spawn>>();
  reliability: ReliabilityCommands;
  understanding: UnderstandingCommands;
  constructor(public store: Store) { super(); this.reliability = new ReliabilityCommands(store, (flow, scenario, scenarioId) => this.startRun(flow, scenario, undefined, scenarioId), this.active); this.understanding = new UnderstandingCommands(store); this.recoverInterrupted(); }
  addProject(input: unknown) {
    const data = z.object({ name: z.string().min(1).max(100), path: z.string().min(1), baseUrl: z.url(), config: configSchema.optional() }).parse(input);
    const path = realpathSync(data.path); if (!statSync(path).isDirectory()) throw new Error('Choose a repository directory');
    if (this.store.list<Project>('projects').some(p => p.path === path)) throw new Error('This repository is already added');
    const config = configSchema.parse(data.config ?? {}); const url = assertTarget(data.baseUrl, data.baseUrl, config);
    if (url.search || url.hash) throw new Error('Base URL must not contain query parameters or fragments');
    const project = { id: id(), name: data.name, path, baseUrl: url.href.replace(/\/$/, ''), config, detection: detect(path), createdAt: now() };
    this.store.put('projects', project); return project;
  }
  saveConfig(projectId: string, input: unknown) {
    const project = this.store.get<Project>('projects', projectId); project.config = configSchema.parse(input); assertTarget(project.baseUrl, project.baseUrl, project.config);
    this.store.put('projects', project); this.store.prune(projectId, project.config.retentionDays); return project;
  }
  exportConfig(projectId: string) {
    const p = this.store.get<Project>('projects', projectId), file = join(p.path, '.devcontrolroom.json');
    if (existsSync(file)) throw new Error('Configuration already exists; move it before exporting a new copy');
    writeFileSync(file, JSON.stringify({ name: p.name, baseUrl: p.baseUrl, config: p.config }, null, 2), { flag: 'wx' }); return { path: file };
  }
  saveFlow(projectId: string, input: unknown) {
    this.store.get('projects', projectId);
    const definition = flowSchema.parse(input);
    for (const step of definition.steps) {
      if (step.action === 'fill' && step.value !== undefined && (/password|card|secret|token|email/i.test(step.label) || redactText(step.value) !== step.value)) throw new Error('Use an env reference for sensitive input values');
      if (step.action === 'goto') { const u = new URL(step.url, 'http://localhost'); if (u.search || u.hash || u.username || u.password) throw new Error('Flow URLs must not contain query data, fragments, or credentials'); }
    }
    return this.store.put('flows', { ...definition, id: id(), projectId, createdAt: now() });
  }
  run(flowId: string, replayId?: string) {
    const flow = this.store.get<Flow>('flows', flowId);
    const replay = replayId ? this.store.get<Run>('runs', replayId) : undefined;
    if (replay && replay.projectId !== flow.projectId) throw new Error('Replay project mismatch');
    return this.startRun(flow, replay?.scenario || { kind: 'baseline', name: 'Baseline', version: 1 }, replay);
  }
  private startRun(flow: Flow, scenario: ScenarioDefinition, replay?: Run, scenarioId?: string) {
    const project = this.reliability.project(flow.projectId);
    if (this.active.size >= 2) throw new Error('Two runs are already active; wait for one to finish');
    assertScenario(project, scenario);
    const run = createRun(this.store, project, flow, replay, scenario.kind === 'baseline' ? undefined : scenario, scenarioId);
    const promise = executeRun(this.store, project, run).then(result => { this.emit('run.completed', result); return result; }).finally(() => this.active.delete(run.id));
    this.active.set(run.id, promise); void promise.catch(() => {}); return run;
  }
  saveTask(projectId: string, input: unknown) {
    this.store.get('projects', projectId); const task = taskSchema.parse(input);
    if (task.flowId && this.store.get<Flow>('flows', task.flowId).projectId !== projectId) throw new Error('Task flow must belong to this project');
    return this.store.put('task_presets', { ...task, id: id(), projectId });
  }
  previewTask(taskId: string) {
    const task = this.store.get<Task>('task_presets', taskId), project = this.store.get<Project>('projects', task.projectId);
    if (!project.config.modules.includes('tasks')) throw new Error('Enable Workspace Launcher in settings');
    const files = task.files.map(file => safeSource(project.path, file));
    const urls = task.urls.map(url => assertTarget(url, project.baseUrl, project.config).href);
    const command = task.command ? project.config.commands[task.command] : undefined;
    if (task.command && !command) throw new Error('This command is no longer configured');
    const git = snapshot(project.path);
    const flow = task.flowId ? this.store.get<Flow>('flows', task.flowId) : undefined;
    const lastRun = task.flowId ? this.store.list<Run>('runs', project.id).find(run => run.flowId === task.flowId) : undefined;
    return { task, files, urls, command, git, flow, lastRun, branchMessage: task.branch && task.branch !== git.branch ? (git.dirty ? 'Uncommitted changes: branch switching is paused. Commit or stash your work, then switch manually.' : `Suggested branch: ${task.branch}. Switch manually when ready.`) : '' };
  }
  launchTask(taskId: string, approveCommand: boolean) {
    const preview = this.previewTask(taskId), project = this.store.get<Project>('projects', preview.task.projectId);
    if (preview.command && !approveCommand) throw new Error('Review and approve the command before executing it');
    if (preview.command) {
      const child = spawn(preview.command, { cwd: project.path, shell: true, windowsHide: true, stdio: 'ignore' });
      this.processes.add(child); child.on('close', () => this.processes.delete(child)); child.on('error', () => this.processes.delete(child));
    }
    const editorUrls = preview.files.map(file => `vscode://file/${file.replaceAll('\\', '/')}`);
    for (const url of [...preview.urls, ...editorUrls]) {
      const child = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
      child.on('error', () => {});
    }
    return { ...preview, editorUrls, launched: true };
  }
  recoverInterrupted(projectId?: string, confirmLegacyStopped = false) {
    let recovered = 0;
    for (const table of ['runs', 'matrices', 'environments'] as const) {
      for (const record of this.store.list<{ id: string; status: string; ownerPid?: number; endedAt?: string; error?: string }>(table, projectId)) {
        if (record.status !== 'running') continue;
        if (record.ownerPid) {
          try { process.kill(record.ownerPid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        } else if (!confirmLegacyStopped) continue;
        record.status = 'failed'; record.endedAt = now(); record.error = 'Execution interrupted: its runner stopped before completion.';
        this.store.put(table, record); recovered++;
      }
    }
    return { recovered };
  }
  deleteProject(projectId: string, confirmation: string) {
    const project = this.store.get<Project>('projects', projectId);
    if (confirmation !== project.name) throw new Error('Type the project name to confirm deletion');
    this.recoverInterrupted(projectId);
    if ([...this.understanding.active].some(key => key.startsWith(projectId + ':'))) throw new Error('Wait for active inspections to finish before deleting');
    if (this.store.list<{kind: string; status: string}>('environments', projectId).some(e => e.kind === 'inspection-lock' && e.status === 'running')) throw new Error('Wait for active inspections to finish before deleting');
    if (this.store.list<Run>('runs', projectId).some(r => r.status === 'running')) throw new Error('Wait for active runs to finish before deleting');
    if (this.store.list<{id: string; status: string}>('matrices', projectId).some(m => m.status === 'running')) throw new Error('Wait for active matrices to finish before deleting');
    this.store.deleteProject(projectId); return { deleted: true };
  }
  async seedDemo() {
    const path = resolve('examples/demo-app');
    let project = this.store.list<Project>('projects').find(p => p.path === realpathSync(path));
    if (project) return project;
    project = this.addProject({ name: 'Acme Storefront', path, baseUrl: 'http://127.0.0.1:4400', config: { commands: { dev: 'node --import tsx server.ts' } } });
    const flow = this.saveFlow(project.id, { name: 'Complete checkout', description: 'Reproduce the demo confirmation failure, with a real 500 response and a failed assertion.', steps: [{ action: 'goto', url: '/' }, { action: 'click', role: 'button', name: 'Continue to checkout' }, { action: 'click', role: 'button', name: 'Confirm order' }, { action: 'assertText', text: 'Order confirmed' }] });
    this.saveFlow(project.id, { name: 'Browse the storefront', description: 'A healthy baseline for the demo app.', steps: [{ action: 'goto', url: '/' }, { action: 'assertText', text: 'The everyday collection' }] });
    this.saveTask(project.id, { name: 'Fix checkout confirmation', files: ['server.ts'], urls: [project.baseUrl], command: 'dev', flowId: flow.id, branch: 'fix/checkout', notes: 'Inspect the confirmation request and rerun Complete checkout. The demo supports DEMO_FIXED=1 to validate the correction.' });
    this.store.put('notes', { id: project.id, projectId: project.id, text: 'The confirmation endpoint returns 500. Start with the failed request in the latest checkout run.', nextStep: 'Inspect POST /api/confirm and the missing success state.' });
    return project;
  }
  setupDemoLabs(projectId: string, input: unknown) {
    const { confirmFixtures } = z.object({ confirmFixtures: z.literal(true, { error: 'Explicitly confirm the included local fixture environment' }) }).parse(input);
    let project = this.reliability.project(projectId);
    if (project.path !== realpathSync(resolve('examples/demo-app')) || project.config.environment !== 'local') throw new Error('Automatic lab setup is only available for the included local demo repository');
    project = this.saveConfig(projectId, { ...project.config, modules: [...new Set([...project.config.modules, 'api', 'payments'])], reliability: { apiPaths: [...new Set([...project.config.reliability.apiPaths, '/api/products'])], payment: { testEnvironmentConfirmed: confirmFixtures, fixturesOnlyConfirmed: confirmFixtures } } });
    const findFlow = (name: string, steps: Flow['steps']) => this.store.list<Flow>('flows', projectId).find(flow => flow.name === name) || this.saveFlow(projectId, { name, steps });
    const capture = findFlow('Catalog fixture capture', [{ action: 'goto', url: '/catalog' }, { action: 'assertText', text: 'Catalog ready' }]);
    const api = findFlow('Catalog response resilience', [{ action: 'goto', url: '/catalog' }, { action: 'assertText', text: 'The catalog' }]);
    const checkout = findFlow('Fixture checkout', [{ action: 'goto', url: '/lab/checkout/{orderId}' }, { action: 'click', role: 'button', name: 'Confirm fixture order' }, { action: 'assertText', text: 'Order confirmed' }]);
    const fixture = this.store.list<ApiFixture>('api_fixtures', projectId).find(f => f.name === 'Demo products') || this.reliability.saveFixture(projectId, { name: 'Demo products', url: new URL('/api/products', project.baseUrl).href, json: { items: [{ id: 'tote', name: 'Everyday canvas tote', subtitle: 'Natural cotton' }] } });
    const existing = this.store.list<Scenario>('scenarios', projectId);
    const cases: [string, string, string, string][] = [
      ['Empty product list', 'empty-list', '/items', 'No products yet'],
      ['Missing optional subtitle', 'missing-field', '/items/0/subtitle', 'No description available'],
      ['Nullable subtitle', 'null-field', '/items/0/subtitle', 'No description available'],
      ['Oversized product name', 'oversized-string', '/items/0/name', 'Product name is too long'],
      ['Expired session', 'unauthorized', '', 'Please sign in again'],
      ['Server failure', 'server-error', '', 'We could not load products'],
      ['Delayed products', 'delay', '', 'Catalog ready'],
    ];
    for (const [name, kind, pointer, expectedText] of cases) if (!existing.some(s => s.definition.name === name)) this.reliability.saveScenario(projectId, { kind: 'api', name, flowId: api.id, fixtureId: fixture.id, mutation: { kind, pointer }, expectedText });
    for (const paymentCase of paymentCases) if (!existing.some(s => s.definition.kind === 'payment' && s.definition.paymentCase === paymentCase)) this.reliability.saveScenario(projectId, { kind: 'payment', name: paymentCase.replaceAll('-', ' '), paymentCase, flowId: checkout.id });
    return { project, captureFlowId: capture.id, fixture, scenarios: this.store.list<Scenario>('scenarios', projectId) };
  }
}
