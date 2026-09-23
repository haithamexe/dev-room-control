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

export class ControlRoom extends EventEmitter {
  active = new Map<string, Promise<Run>>();
  processes = new Set<ReturnType<typeof spawn>>();
  constructor(public store: Store) { super(); }
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
    const flow = this.store.get<Flow>('flows', flowId), project = this.store.get<Project>('projects', flow.projectId);
    if (!project.config.modules.includes('time-machine')) throw new Error('Enable Bug Time Machine in project settings');
    if (this.active.size >= 2) throw new Error('Two runs are already active; wait for one to finish');
    const replay = replayId ? this.store.get<Run>('runs', replayId) : undefined;
    if (replay && replay.projectId !== project.id) throw new Error('Replay project mismatch');
    const run = createRun(this.store, project, flow, replay);
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
  deleteProject(projectId: string, confirmation: string) {
    const project = this.store.get<Project>('projects', projectId);
    if (confirmation !== project.name) throw new Error('Type the project name to confirm deletion');
    if (this.store.list<Run>('runs', projectId).some(r => this.active.has(r.id))) throw new Error('Wait for active runs to finish before deleting');
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
}
