import { inspectReact } from '../../runner/src/react-inspection.ts';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Store, id, now } from '../../storage/src/index.ts';
import { configSchema, type Project, type Run, type RunEvent, type Finding } from '../../core/src/index.ts';
import { driftRuleSchema, type Report, type SessionSnapshot, type SourceLink } from '../../core/src/understanding.ts';
import { redact, scrubInputs } from '../../core/src/redact.ts';
import { authSecrets } from '../../runner/src/browser.ts';
import { captureInteractions } from '../../runner/src/interactions.ts';
import { snapshot } from '../../repo-analysis/src/index.ts';
import { riskMap } from '../../repo-analysis/src/risk.ts';
import { inspectPage, scanDrift, evidenceScreenshot, elementFacts, bridgeSource } from '../../runner/src/inspect.ts';

export class UnderstandingCommands {
  active = new Set<string>();
  constructor(private store: Store) {}
  private begin(projectId: string, reportId: string) {
    if (this.store.list<any>('environments').filter(r => r.kind === 'inspection-lock' && r.status === 'running').length >= 2) throw new Error('Two inspections are already running');
    this.store.put('environments', { id: reportId, projectId, kind: 'inspection-lock', status: 'running', ownerPid: process.pid, startedAt: now() });
    this.active.add(projectId + ':' + reportId);
  }
  private end(projectId: string, reportId: string) { this.active.delete(projectId + ':' + reportId); this.store.db.prepare('DELETE FROM environments WHERE id=?').run(reportId); }
  project(projectId: string, module?: string) { const p = this.store.get<Project>('projects', projectId); p.config = configSchema.parse(p.config); if (module && !p.config.modules.includes(module as any)) throw new Error(`Enable ${module} in project settings`); return p; }
  private report(project: Project, kind: Report['kind'], input: unknown): Report { return { id: id(), projectId: project.id, kind, name: `${kind} inspection`, createdAt: now(), git: redact(snapshot(project.path)), input, data: {}, sources: [], artifactIds: [] }; }
  private save(project: Project, report: Report) {
    report = redact(scrubInputs(report, authSecrets(project)), project.config.redactFields);
    const artifact = this.store.artifact(project.id, report.id, `${report.kind}.json`, 'application/json', Buffer.from(JSON.stringify(report, null, 2))); report.artifactIds.push(artifact.id);
    return this.store.put('reports', report);
  }
  risk(projectId: string, input: unknown) {
    const { base } = z.object({ base: z.string().default('HEAD') }).parse(input), project = this.project(projectId, 'risk');
    const report = this.report(project, 'risk', { base }); report.data = riskMap(project, base, this.store.list<Run>('runs', projectId), this.store.list<RunEvent>('events', projectId));
    report.sources = [...report.data.changed.map((file: string) => ({ file, provenance: 'static', reason: 'Git diff: directly changed' })), ...report.data.dependents.map((d: any) => ({ file: d.file, provenance: 'static', reason: d.reason }))];
    return this.save(project, report);
  }
  async drift(projectId: string, input: unknown) {
    const data = z.object({ routes: z.array(z.string().min(1)).min(1).max(5), rules: z.array(driftRuleSchema).min(1).max(50).optional() }).parse(input), project = this.project(projectId, 'drift');
    const rules = data.rules || project.config.understanding.driftRules; if (!rules.length) throw new Error('Import or configure at least one explicit token rule');
    const report = this.report(project, 'drift', { ...data, rules }), groups = new Map<string, any>(), gaps: string[] = [];
    this.begin(projectId, report.id);
    try {
      for (const route of data.routes) await inspectPage(project, route, async page => {
        const scan = await scanDrift(page, rules); gaps.push(...scan.gaps);
        for (const result of scan.results) {
          const fingerprint = createHash('sha256').update(JSON.stringify([new URL(route, project.baseUrl).pathname, result.rule, result.property, result.observed, result.expected])).digest('hex');
          const group = groups.get(fingerprint) || { ...result, fingerprint, route: page.url(), selectors: [], locations: [], sources: bridgeSource(project, result.metadata) };
          group.selectors.push(result.selector); group.locations.push(result.bounds); delete group.metadata; groups.set(fingerprint, group);
        }
        const artifact = this.store.artifact(projectId, report.id, `drift-${report.artifactIds.length + 1}.png`, 'image/png', await evidenceScreenshot(page, project)); report.artifactIds.push(artifact.id);
      });
      const suppressions = this.store.list<any>('suppressions', projectId);
      const findings = [...groups.values()].map(group => {
        const suppression = suppressions.find(s => s.fingerprint === group.fingerprint);
        const finding = this.store.put<Finding>('findings', redact(scrubInputs({ id: id(), projectId, reportId: report.id, fingerprint: group.fingerprint, sources: group.sources, title: `${group.rule}: ${group.property} outside tokens`, expected: group.expected.map((e: any) => `${e.reference} = ${e.value}`).join(', ') + ` (tolerance ${group.tolerance}px)`, observed: `${group.observed} at ${group.selectors.join(', ')}`, status: suppression ? 'suppressed' : 'open', createdAt: now() }, authSecrets(project)), project.config.redactFields));
        return { ...group, findingId: finding.id, status: finding.status, disposition: suppression?.reason };
      });
      report.data = { findings, gaps, note: 'Only explicitly configured properties and selectors are checked. Repeated identical outliers on a route are grouped.' }; report.sources = findings.flatMap(f => f.sources);
      return this.save(project, report);
    } finally { this.end(projectId, report.id); }
  }
  async element(projectId: string, input: unknown) {
    const data = z.object({ route: z.string().min(1), selector: z.string().min(1).max(500), interact: z.boolean().default(false) }).parse(input), project = this.project(projectId, 'why');
    const report = this.report(project, 'element', data);
    const interactions: Record<string, unknown>[] = []; let capturing = false, signal: (() => void) | undefined;
    const observed = new Promise<void>(resolve => { signal = resolve; });
    this.begin(projectId, report.id);
    try {
      return await inspectPage(project, data.route, async page => {
        const facts = await elementFacts(page, data.selector, project.config.understanding.bridgeEnabled, project.config.maskSelectors);
        if (facts.instrumentation?.state) { try { facts.instrumentation.state = JSON.stringify(redact(JSON.parse(facts.instrumentation.state), project.config.redactFields)); } catch { facts.instrumentation.state = redact(facts.instrumentation.state, project.config.redactFields); } }
        report.sources = bridgeSource(project, facts.metadata);
        const react = await inspectReact(page, data.selector, project);
        report.data = { ...facts, react, selector: data.selector, route: page.url(), provenance: 'observed', sourceConfidence: report.sources.length ? 'Application-supplied instrumentation' : 'Unknown: no verified source mapping', instrumentation: facts.instrumentation, limitations: ['DOM styles and attributes are observed facts.', 'Application labels and best-effort React runtime observations are reported separately.', 'No API causality is inferred from temporal proximity.'] };
        await page.locator(data.selector).first().evaluate(el => { (el as HTMLElement).style.outline = '3px solid #15b88a'; });
        if (data.interact) {
          capturing = true; await page.locator(data.selector).first().click();
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([observed, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); if (timer) clearTimeout(timer);
          report.data.interactions = interactions;
          report.data.reactAfter = await inspectReact(page, data.selector, project).catch(() => ({ status: 'unavailable', note: 'Element changed after the interaction' }));
          report.data.limitations.push(interactions.length ? 'Only requests explicitly routed through traceInteraction scope.request are associated. State comes from the application-provided getter.' : 'No completed instrumented interaction arrived within five seconds. Handler/state/request ownership remains unknown.');
        }
        delete report.data.metadata;
        const artifact = this.store.artifact(projectId, report.id, 'element.png', 'image/png', await evidenceScreenshot(page, project)); report.artifactIds.push(artifact.id);
        return this.save(project, report);
      }, page => captureInteractions(page, project, evidence => { if (capturing) { interactions.push(evidence); signal?.(); } }));
    } finally { this.end(projectId, report.id); }
  }
  disposition(findingId: string, reason: 'suppressed' | 'intentional' | 'open') {
    reason = z.enum(['suppressed', 'intentional', 'open']).parse(reason);
    const finding = this.store.get<Finding>('findings', findingId);
    if (!finding.fingerprint) throw new Error('This finding has no drift fingerprint');
    const key = `${finding.projectId}-${finding.fingerprint}`;
    if (reason === 'open') this.store.db.prepare('DELETE FROM suppressions WHERE id=?').run(key);
    else this.store.put('suppressions', { id: key, projectId: finding.projectId, fingerprint: finding.fingerprint, reason, createdAt: now() });
    finding.status = reason === 'open' ? 'open' : 'suppressed'; return this.store.put('findings', finding);
  }
  session(projectId: string, input: unknown) {
    const data = z.object({ note: z.string().max(10000).optional(), nextStep: z.string().max(1000).optional(), proposedAction: z.string().max(1000).optional(), taskId: z.string().optional() }).parse(input), project = this.project(projectId, 'context');
    const notes = this.store.list<any>('notes', projectId)[0] || {}, runs = this.store.list<Run>('runs', projectId), findings = this.store.list<Finding>('findings', projectId).filter(f => f.status === 'open');
    if (data.taskId && this.store.get<any>('task_presets', data.taskId).projectId !== projectId) throw new Error('Task belongs to another project');
    const previous = this.store.list<SessionSnapshot>('repo_snapshots', projectId)[0];
    const session: SessionSnapshot = { id: id(), projectId, createdAt: now(), git: snapshot(project.path), note: data.note ?? notes.text ?? '', nextStep: data.nextStep ?? notes.nextStep ?? '', proposedAction: runs.find(r => r.status === 'failed') ? 'Inspect the last failing flow and its evidence.' : findings.length ? 'Review the open findings.' : 'Choose a flow or task to continue.', taskId: data.taskId === undefined ? previous?.taskId : data.taskId || undefined, lastRunId: runs[0]?.id, lastFailedRunId: runs.find(r => r.status === 'failed')?.id, openFindingIds: findings.map(f => f.id) };
    const clean = redact(session, project.config.redactFields) as SessionSnapshot;
    if (data.proposedAction !== undefined) clean.proposedAction = redact(data.proposedAction, project.config.redactFields);
    this.store.put('notes', { id: projectId, projectId, text: clean.note, nextStep: clean.nextStep }); return this.store.put('repo_snapshots', clean);
  }
}
