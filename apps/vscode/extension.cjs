const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
function base() { const port = vscode.workspace.getConfiguration('developerControlRoom').get('port', 4310); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local service port'); return `http://127.0.0.1:${port}`; }
async function api(route, data) {
  const origin = base(); let headers = {};
  if (data) { const session = await fetch(`${origin}/api/session`, { redirect: 'error', signal: AbortSignal.timeout(5000) }); if (!session.ok) throw new Error('Local service unavailable'); headers = { 'Content-Type': 'application/json', 'X-DCR-Token': (await session.json()).token }; }
  const response = await fetch(`${origin}/api${route}`, { method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Local service request failed'); return result;
}
async function chooseProject(overview) { const item = await vscode.window.showQuickPick(overview.projects.map(p => ({ label: p.name, description: p.path, project: p })), { title: 'Control Room project' }); return item?.project; }
function contained(root, file) { const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file)); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Source must remain inside its project'); }
async function openEvidenceSource(argument) {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before opening project evidence');
  const overview = await api('/overview'); let project, source;
  if (argument?.projectId && argument?.reportId) { project = overview.projects.find(p => p.id === argument.projectId); const report = overview.reports.find(r => r.id === argument.reportId && r.projectId === project?.id); source = report?.sources.find(s => s.file === argument.file); }
  else {
    project = await chooseProject(overview); if (!project) return;
    const candidates = overview.reports.filter(r => r.projectId === project.id).flatMap(r => r.sources.map(source => ({ label: source.file, description: `${r.kind} · ${source.provenance} · ${source.component || source.reason}`, source })));
    const choice = await vscode.window.showQuickPick(candidates, { title: 'Source referenced by saved evidence' }); source = choice?.source;
  }
  if (!project || !source) throw new Error('No matching source reference found in saved evidence');
  const approved = await api(`/projects/${project.id}/source?path=${encodeURIComponent(source.file)}`);
  contained(project.path, approved.path);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(approved.path));
  const line = Math.max(0, Math.min(document.lineCount - 1, (source.line || 1) - 1));
  await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
  return approved.path;
}
function activate(context) {
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => { try { return await fn(...args); } catch (error) { void vscode.window.showErrorMessage(`Control Room: ${error.message}`); throw error; } }));
  register('dcr.openEvidenceSource', openEvidenceSource);
  register('dcr.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(base())));
  register('dcr.copyContext', async () => {
    const overview = await api('/overview'), project = await chooseProject(overview); if (!project) return;
    const choices = [{ label: 'Whole project', kind: 'project', id: project.id }, ...overview.runs.filter(r => r.projectId === project.id).map(r => ({ label: `${r.status}: ${r.name}`, kind: 'run', id: r.id })), ...overview.reports.filter(r => r.projectId === project.id).map(r => ({ label: `${r.kind}: ${r.createdAt}`, kind: 'report', id: r.id }))];
    const target = await vscode.window.showQuickPick(choices, { title: 'Context to copy for AI' }); if (!target) return;
    const result = await api('/handoff', { kind: target.kind, id: target.id, includeSource: true });
    await vscode.env.clipboard.writeText(result.text); await vscode.window.showInformationMessage('Context copied. Nothing was sent to an AI service.');
  });
}
module.exports = { activate, deactivate() {} };
