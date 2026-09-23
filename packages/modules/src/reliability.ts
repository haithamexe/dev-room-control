import { sanitizeFixture } from '../../core/src/api-matching.ts';
import { z } from 'zod';
import { Store, id, now } from '../../storage/src/index.ts';
import { configSchema, type Project, type Flow, type Run } from '../../core/src/index.ts';
import { fixtureInputSchema, apiMethodSchema, requestMatchSchema, scenarioInputSchema, mutateFixture, type Scenario, type ScenarioDefinition, type ApiFixture, type Matrix } from '../../core/src/reliability.ts';
import { assertApiTarget, assertPayment, assertScenario } from '../../core/src/reliability-policy.ts';
import { redact, redactText } from '../../core/src/redact.ts';

export class ReliabilityCommands {
  activeMatrices = new Map<string, Promise<Matrix>>();
  constructor(private store: Store, private start: (flow: Flow, scenario: ScenarioDefinition, scenarioId?: string) => Run, private active: Map<string, Promise<Run>>, private cancelRun: (runId: string) => unknown = () => {}) {}
  project(projectId: string) { const project = this.store.get<Project>('projects', projectId); return { ...project, config: configSchema.parse(project.config) }; }
  capture(projectId: string, input: unknown) {
    const data = z.object({ name: z.string().min(1).max(120), flowId: z.string().uuid(), url: z.url(), method: apiMethodSchema.default('GET'), request: requestMatchSchema.optional() }).parse(input);
    const project = this.project(projectId), flow = this.store.get<Flow>('flows', data.flowId);
    if (flow.projectId !== projectId) throw new Error('Capture flow must belong to this project');
    const url = assertApiTarget(project, data.url, data.method).href;
    return this.start(flow, { kind: 'capture', name: `Capture ${data.name}`, version: 1, fixtureName: data.name, url, method: data.method, request: data.request ? { ...data.request, json: redact(data.request.json, project.config.redactFields) } : undefined });
  }
  saveFixture(projectId: string, input: unknown, fixtureId?: string) {
    const project = this.project(projectId), parsed = fixtureInputSchema.parse(input);
    assertApiTarget(project, parsed.url, parsed.method);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 64000) throw new Error('Fixtures must be at most 64 KB');
    const previous = fixtureId ? this.store.get<ApiFixture>('api_fixtures', fixtureId) : undefined;
    if (previous && previous.projectId !== projectId) throw new Error('Fixture project mismatch');
    return this.store.put('api_fixtures', { ...parsed, request: parsed.request ? { ...parsed.request, json: redact(parsed.request.json, project.config.redactFields) } : undefined, schema: parsed.schema ? redact(parsed.schema, project.config.redactFields) : undefined, name: redactText(parsed.name), json: redact(parsed.json, project.config.redactFields), id: previous?.id || id(), projectId, version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now(), sourceRunId: previous?.sourceRunId }) as ApiFixture;
  }
  saveScenario(projectId: string, input: unknown, scenarioId?: string) {
    const parsed = scenarioInputSchema.parse(input), project = this.project(projectId);
    const flow = this.store.get<Flow>('flows', parsed.flowId);
    if (flow.projectId !== projectId) throw new Error('Scenario flow must belong to this project');
    const previous = scenarioId ? this.store.get<Scenario>('scenarios', scenarioId) : undefined;
    if (previous && previous.projectId !== projectId) throw new Error('Scenario project mismatch');
    const version = (previous?.definition.version || 0) + 1;
    let definition: ScenarioDefinition;
    if (parsed.kind === 'api') {
      const fixture = this.store.get<ApiFixture>('api_fixtures', parsed.fixtureId);
      if (fixture.projectId !== projectId) throw new Error('Fixture must belong to this project');
      assertApiTarget(project, fixture.url, fixture.method); mutateFixture(fixture, parsed.mutation);
      const snapshot = sanitizeFixture(fixtureInputSchema.parse(fixture), project.config.redactFields);
      if (redactText(parsed.expectedText) !== parsed.expectedText) throw new Error('Use non-sensitive UI text for the expected outcome');
      definition = { kind: 'api', name: redactText(parsed.name), version, fixture: snapshot, mutation: parsed.mutation, expectedText: parsed.expectedText };
    } else definition = { kind: 'payment', name: redactText(parsed.name), version, paymentCase: parsed.paymentCase, adapter: assertPayment(project) };
    assertScenario(project, definition);
    return this.store.put('scenarios', { id: previous?.id || id(), projectId, flowId: parsed.flowId, definition, createdAt: previous?.createdAt || now(), fixtureId: parsed.kind === 'api' ? parsed.fixtureId : undefined }) as Scenario;
  }
  plan(scenarioId: string) {
    const scenario = this.store.get<Scenario>('scenarios', scenarioId), flow = this.store.get<Flow>('flows', scenario.flowId);
    if (flow.projectId !== scenario.projectId) throw new Error('Scenario project mismatch');
    assertScenario(this.project(scenario.projectId), scenario.definition);
    return { scenario, flow };
  }
  run(scenarioId: string) { const { scenario, flow } = this.plan(scenarioId); return this.start(flow, scenario.definition, scenario.id); }
  matrix(projectId: string, input: unknown) {
    const data = z.object({ name: z.string().min(1).max(120).default('Scenario matrix'), scenarioIds: z.array(z.string().uuid()).min(1).max(20) }).parse(input);
    if (new Set(data.scenarioIds).size !== data.scenarioIds.length) throw new Error('Select each scenario only once');
    const plans = data.scenarioIds.map(scenarioId => this.plan(scenarioId));
    if (plans.some(plan => plan.scenario.projectId !== projectId)) throw new Error('Matrix scenarios must belong to one project');
    if (this.activeMatrices.size >= 2) throw new Error('Two matrices are already active');
    const matrix: Matrix = this.store.put('matrices', { id: id(), projectId, name: data.name, status: 'running', ownerPid: process.pid, runIds: [], scenarioIds: data.scenarioIds, plans, nextIndex: 0, createdAt: now() });
    return this.schedule(matrix);
  }
  cancel(matrixId: string) {
    const matrix = this.store.get<Matrix>('matrices', matrixId);
    if (!this.activeMatrices.has(matrixId)) throw new Error('Matrix is not running in this service');
    matrix.status = 'cancelled'; this.store.put('matrices', matrix);
    const current = matrix.runIds.at(-1); if (current && this.active.has(current)) this.cancelRun(current);
    return matrix;
  }
  resume(matrixId: string) {
    const matrix = this.store.get<Matrix>('matrices', matrixId);
    if (this.activeMatrices.size >= 2) throw new Error('Two matrices are already active');
    if (!['interrupted', 'cancelled', 'failed'].includes(matrix.status) || !matrix.plans) throw new Error('Only interrupted/cancelled matrices with saved execution plans can resume');
    for (const runId of matrix.runIds) if (this.store.get<Run>('runs', runId).status === 'running') throw new Error('A previous matrix run is still active');
    matrix.status = 'running'; matrix.ownerPid = process.pid; delete matrix.endedAt; delete matrix.error; this.store.put('matrices', matrix);
    return this.schedule(matrix);
  }
  private schedule(matrix: Matrix) {
    const job = (async () => {
      try {
        for (let index = matrix.nextIndex || 0; index < matrix.plans!.length; index++) {
          while (this.active.size >= 2) await Promise.race([...this.active.values()]).catch(() => {});
          if (this.store.get<Matrix>('matrices', matrix.id).status === 'cancelled') { matrix.status = 'cancelled'; break; }
          const plan = matrix.plans![index];
          const run = this.start(plan.flow, plan.scenario.definition, plan.scenario.id); matrix.runIds.push(run.id); this.store.put('matrices', matrix);
          await this.active.get(run.id);
          const status = this.store.get<Run>('runs', run.id).status;
          if (status === 'passed' || status === 'failed') matrix.nextIndex = index + 1;
          if (this.store.get<Matrix>('matrices', matrix.id).status === 'cancelled') { matrix.status = 'cancelled'; break; }
          if (status === 'cancelled') { matrix.status = 'cancelled'; break; }
          this.store.put('matrices', matrix);
        }
        if (matrix.status !== 'cancelled') matrix.status = 'completed';
      } catch (error) { matrix.status = 'failed'; matrix.error = String(error); }
      finally { matrix.endedAt = now(); this.store.put('matrices', matrix); this.activeMatrices.delete(matrix.id); }
      return matrix;
    })();
    this.activeMatrices.set(matrix.id, job); return matrix;
  }
}
