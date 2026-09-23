import { requestMatches, sanitizeFixture } from '../../core/src/api-matching.ts';
import { captureInteractions } from './interactions.ts';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from '../../storage/src/index.ts';
import type { Flow, Run, Project, RunEvent } from '../../core/src/index.ts';
import { redact, redactText, assertTarget, scrubInputs } from '../../core/src/redact.ts';
import { snapshot } from '../../repo-analysis/src/index.ts';
import { mutateFixture, type ApiFixture, type ScenarioDefinition } from '../../core/src/reliability.ts';
import { assertScenario, assertApiTarget } from '../../core/src/reliability-policy.ts';
import { preparePayment, checkPayment } from './payment.ts';
import { engines, authState, authSecrets, login, performStep, type FlowTabs } from './browser.ts';

// Raw Playwright network resources can contain credentials. Keep action records only.
export function sanitizeTrace(bytes: Uint8Array, fields: string[], inputs: string[] = []) {
  const output: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (!name.endsWith('.trace') && !name.endsWith('.stacks')) continue;
    const lines = strFromU8(data).split('\n').filter(Boolean).map(line => {
      const entry = JSON.parse(line);
      if (['frame-snapshot', 'screencast-frame', 'log', 'console', 'event'].includes(entry.type)) return '';
      if (entry.params?.value) entry.params.value = '[REDACTED]';
      if (entry.params?.text) entry.params.text = '[REDACTED]';
      if (entry.method === 'setInputFiles' || entry.apiName?.includes('setInputFiles')) entry.params = { selector: entry.params?.selector, files: '[UPLOAD OMITTED]' };
      if (entry.params?.options && (entry.method === 'selectOption' || entry.apiName?.includes('selectOption'))) entry.params.options = '[INPUT OMITTED]';
      // Preserve only trace protocol metadata at the record boundary. Nested
      // request/response data must never inherit those exemptions.
      const clean = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, /^(type|method|apiName|class|callId|pageId|contextId|browserName|version|id|guid|sdkLanguage|origin|platform)$/.test(key) ? value : scrubInputs(value, inputs)]));
      return JSON.stringify(redact(clean, fields));
    }).filter(Boolean);
    output[name] = strToU8(lines.join('\n') + '\n');
  }
  return zipSync(output);
}
export function createRun(store: Store, project: Project, flow: Flow, replay?: Run, scenario?: ScenarioDefinition, scenarioId?: string): Run {
  assertTarget(replay?.baseUrl || project.baseUrl, project.baseUrl, project.config);
  const definition: ScenarioDefinition = structuredClone(replay?.scenario || scenario || { kind: 'baseline', name: 'Baseline', version: 1 });
  if (definition.kind === 'capture' && definition.request) definition.request.json = redact(definition.request.json, project.config.redactFields);
  if (definition.kind === 'api') definition.fixture = sanitizeFixture(definition.fixture, project.config.redactFields);
  return store.put('runs', { id: id(), projectId: project.id, flowId: flow.id, name: replay?.name || (scenario ? `${flow.name} · ${scenario.name}` : flow.name), status: 'running', ownerPid: process.pid, startedAt: now(), baseUrl: replay?.baseUrl || project.baseUrl, flow: replay?.flow || { name: flow.name, description: flow.description, steps: flow.steps }, scenario: definition, browser: replay?.browser || project.config.browser, scenarioId: replay?.scenarioId || scenarioId, git: snapshot(project.path), replayOf: replay?.id });
}
export async function executeRun(store: Store, project: Project, run: Run, signal?: AbortSignal) {
  let browser: Browser | undefined, context: BrowserContext | undefined, tabs: FlowTabs | undefined;
  const temp = mkdtempSync(join(tmpdir(), 'dcr-trace-'));
  const inputs = run.flow.steps.flatMap(step => (step.action === 'fill' || step.action === 'select' || step.action === 'upload') ? [step.env ? process.env[step.env] || '' : ('value' in step ? step.value || '' : '')] : []).filter(Boolean);
  const abort = () => { void context?.close().catch(() => {}); }; signal?.addEventListener('abort', abort);
  const event = (kind: RunEvent['kind'], title: string, data: Record<string, unknown> = {}) => store.put('events', { id: id(), runId: run.id, projectId: project.id, at: now(), kind, title: redactText(scrubInputs(title, inputs)), data: redact(scrubInputs(data, inputs), project.config.redactFields) });
  const pending = new Set<Promise<void>>();
  let activeStep = 'Launch browser';
  let matchedRequests = 0, capturedFixture: ApiFixture | undefined;
  const pageErrors: string[] = [];
  let signalCapture: (() => void) | undefined;
  const captureReady = new Promise<void>(resolve => { signalCapture = resolve; });
  let signalMutation: (() => void) | undefined;
  const mutationReady = new Promise<void>(resolve => { signalMutation = resolve; });
  const fail = (error: unknown) => {
    if (signal?.aborted) { run.status = 'cancelled'; run.error = 'Cancelled by user'; event('marker', 'Run cancelled'); return; }
    run.status = 'failed'; run.error = redactText(scrubInputs(error instanceof Error ? error.message : String(error), inputs));
    event('error', `Failed at ${activeStep}`, { error: run.error });
    const finding = store.put('findings', { id: id(), projectId: project.id, runId: run.id, title: `${run.name} did not complete`, expected: activeStep, observed: run.error, status: 'open', createdAt: now() });
    event('assertion', 'Flow failed', { findingId: finding.id, expected: activeStep, observed: run.error, passed: false });
  };
  try {
    assertScenario(project, run.scenario);
    signal?.throwIfAborted(); inputs.push(...authSecrets(project));
    run.browser = run.browser || project.config.browser;
    browser = await engines[run.browser].launch({ headless: true }); run.browserVersion = browser.version();
    signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', storageState: authState(project) });
    await context.route('**/*', async route => {
      const url = route.request().url();
      try {
        assertTarget(url, run.baseUrl, project.config);
        if (project.config.ignoreUrls.some(pattern => url.includes(pattern))) return route.abort();
        const resource = route.request().resourceType();
        const isApiRequest = ['fetch', 'xhr'].includes(resource), method = route.request().method();
        if (run.scenario.kind === 'api' && isApiRequest && url === run.scenario.fixture.url) {
          assertApiTarget(project, url, run.scenario.fixture.method);
          if (method !== run.scenario.fixture.method || !requestMatches(run.scenario.fixture.request, route.request().postData(), project.config.redactFields, inputs)) { event('request', 'Fixture method/body mismatch: target request blocked', { url, method }); await route.abort(); return; }
          const response = mutateFixture(run.scenario.fixture, run.scenario.mutation);
          event('request', 'Applied API mutation', { url, mutation: run.scenario.mutation, status: response.status, response: response.json, delayMs: response.delayMs });
          if (response.delayMs) await new Promise(resolve => setTimeout(resolve, response.delayMs));
          await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.json) }); return;
        }
        // Browser routing is not called again for redirect-chain requests. Fetch one
        // hop only and reject redirects before any destination can be contacted.
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          event('request', 'HTTP redirect blocked by target policy', { url, status: response.status(), location: response.headers().location });
          await route.abort(); return;
        }
        if (run.scenario.kind === 'capture' && isApiRequest && url === run.scenario.url && method === (run.scenario.method || 'GET') && requestMatches(run.scenario.request, route.request().postData(), project.config.redactFields, inputs) && !capturedFixture) {
          assertApiTarget(project, url, method);
          const rawBody = route.request().postData(); let requestBody: unknown;
          if (rawBody !== null) { if (Buffer.byteLength(rawBody) > 64000) throw new Error('Capture request body exceeds 64 KB'); try { requestBody = JSON.parse(rawBody); } catch { throw new Error('Request-body capture supports JSON only'); } }
          if (response.status() < 200 || response.status() > 299 || !response.headers()['content-type']?.includes('application/json')) throw new Error('Fixture capture requires a successful JSON response');
          const bytes = await response.body(); if (bytes.length > 64000) throw new Error('Fixture capture exceeds 64 KB');
          capturedFixture = store.put<ApiFixture>('api_fixtures', { id: id(), projectId: project.id, name: run.scenario.fixtureName, url, method: method as ApiFixture['method'], request: rawBody !== null ? { mode: 'exact', json: redact(scrubInputs(requestBody, inputs), project.config.redactFields) as any } : undefined, status: response.status(), json: redact(scrubInputs(JSON.parse(bytes.toString()), inputs), project.config.redactFields), sourceRunId: run.id, version: 1, createdAt: now() });
          event('request', 'Captured sanitized API fixture', { fixtureId: capturedFixture.id, url, status: response.status() });
          signalCapture?.();
        }
        await route.fulfill({ response });
      } catch (error) { event('request', 'Blocked or failed request', { url, error: String(error) }); await route.abort().catch(() => {}); }
    });
    await context.routeWebSocket('**/*', ws => ws.close());
    let page = await context.newPage(); tabs = { current: page, pages: new Map([['main', page]]) }; context.setDefaultTimeout(7000); context.setDefaultNavigationTimeout(15000); page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(15000);
    await captureInteractions(page, project, data => event('action', 'Instrumented interaction', data));
    await login(page, project); signal?.throwIfAborted();
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const observe = (page: import('playwright').Page) => {
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) event('console', msg.text(), { level: msg.type() }); });
    page.on('pageerror', error => { pageErrors.push(error.message); event('error', error.message); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) event('navigation', 'Page navigation', { url: frame.url() }); });
    page.on('requestfailed', request => event('request', 'Request failed', { url: request.url(), method: request.method(), error: request.failure()?.errorText }));
    page.on('response', response => {
      const job = (async () => {
        const request = response.request();
        if (!['fetch', 'xhr', 'document'].includes(request.resourceType())) return;
        if (await response.finished()) return;
        const data: Record<string, unknown> = { url: response.url(), method: request.method(), status: response.status(), duration: Math.max(0, Math.round(request.timing().responseEnd)) };
        if (project.config.captureBodies && response.headers()['content-type']?.includes('application/json')) {
          try { const body = await response.body(); if (body.length < 64000) data.body = JSON.parse(body.toString()); } catch { /* response may be interrupted */ }
        }
        event('request', `${request.method()} ${new URL(response.url()).pathname}`, data);
        if (run.scenario.kind === 'api' && request.method() === run.scenario.fixture.method && requestMatches(run.scenario.fixture.request, request.postData(), project.config.redactFields, inputs) && ['fetch', 'xhr'].includes(request.resourceType()) && response.url() === run.scenario.fixture.url) {
          matchedRequests++; signalMutation?.();
        }
      })().catch(() => {});
      pending.add(job); void job.finally(() => pending.delete(job));
    });
    }; observe(page); context.on('page', observe);
    const orderId = await preparePayment(context, project, run, event);
    for (const [index, step] of run.flow.steps.entries()) {
      signal?.throwIfAborted();
      activeStep = `${index + 1}. ${step.action}${'name' in step ? ` · ${step.name}` : 'text' in step ? ` · ${step.text}` : ''}`;
      event('action', activeStep, { step: index + 1, action: step.action });
      await performStep(page, step, project, run.baseUrl, orderId, tabs); page = tabs.current;
      if (step.action === 'goto' && run.scenario.kind === 'payment' && run.scenario.paymentCase === 'refresh-before-confirmation') { await page.reload({ waitUntil: 'domcontentloaded' }); event('action', 'Refresh before confirmation'); }
      if (step.action === 'assertText') event('assertion', `Visible: ${step.text}`, { expected: step.text, observed: 'visible', passed: true });
    }
    if (run.scenario.kind === 'capture') {
      if (!capturedFixture) { let timer: ReturnType<typeof setTimeout>; try { await Promise.race([captureReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The flow did not request the selected API fixture URL')), 7000); })]); } finally { clearTimeout(timer!); } }
      run.result = { expected: run.scenario.url, observed: 'Sanitized JSON fixture captured', fixtureId: capturedFixture!.id, passed: true };
    }
    if (run.scenario.kind === 'api') {
      activeStep = `Mutation outcome: ${run.scenario.expectedText}`;
      // A route match is only an attempt: wait until the browser received the body.
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([mutationReady, new Promise<void>(resolve => { timer = setTimeout(resolve, 7000); })]); } finally { clearTimeout(timer!); }
      // Yield through the browser event loop so fetch handlers can update UI or throw.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      let visible = false; try { await page.getByText(run.scenario.expectedText, { exact: true }).waitFor({ state: 'visible', timeout: 3000 }); visible = true; } catch { /* include observed state below */ }
      const observed = { expectedTextVisible: visible, pageErrors, route: page.url(), bodyText: (await page.locator('body').innerText()).slice(0, 2000) };
      const passed = matchedRequests > 0 && visible && pageErrors.length === 0;
      run.result = { expected: run.scenario.expectedText, observed, matchedRequests, passed };
      event('assertion', 'API mutation outcome', { expected: run.scenario.expectedText, observed, matchedRequests, passed });
      if (!passed) throw new Error(matchedRequests ? `Mutated response did not produce a healthy expected UI: ${run.scenario.expectedText}` : 'No fetch/XHR request matched this API fixture; no mutation was applied');
    }
    if (orderId) { activeStep = `Payment invariant: ${run.scenario.name}`; await checkPayment(context, page, project, run, orderId, event); }
    if (run.scenario.kind === 'payment' && pageErrors.length) {
      if (run.result) run.result = { ...run.result, passed: false, observed: { ...(run.result.observed as Record<string, unknown>), pageErrors } };
      throw new Error('Checkout raised an uncaught browser error');
    }
    signal?.throwIfAborted(); run.status = 'passed';
  } catch (error) {
    fail(error);
  } finally {
    if (context) {
      try {
        const page = tabs?.current && !tabs.current.isClosed() ? tabs.current : context.pages().find(page => !page.isClosed());
        if (page && !page.isClosed()) {
          // Mask form fields, explicit private regions, and common personal-data text.
          const masks = page.frames().flatMap(frame => [frame.locator('input, textarea, select, [data-private], [autocomplete]'), frame.getByText(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]*?){13,19}\b/), ...inputs.map(value => frame.getByText(value)), ...project.config.maskSelectors.map(s => frame.locator(s))]);
          store.artifact(project.id, run.id, 'screenshot.png', 'image/png', await page.screenshot({ fullPage: false, mask: masks, animations: 'disabled', timeout: 5000 }));
        }
      } catch (e) { event('error', 'Screenshot unavailable', { error: String(e) }); }
      try { const path = join(temp, 'trace.zip'); await context.tracing.stop({ path }); store.artifact(project.id, run.id, 'trace.zip', 'application/zip', sanitizeTrace(readFileSync(path), project.config.redactFields, inputs)); } catch (e) { event('error', 'Trace unavailable', { error: String(e) }); }
      await context.close().catch(() => {});
    }
    await Promise.allSettled([...pending]);
    await browser?.close().catch(() => {}); rmSync(temp, { recursive: true, force: true });
    signal?.removeEventListener('abort', abort);
    if (run.status === 'passed' && ['api', 'payment'].includes(run.scenario.kind || '') && pageErrors.length) {
      if (run.result) run.result = { ...run.result, passed: false, observed: { ...(run.result.observed as Record<string, unknown>), pageErrors } };
      fail(new Error('Scenario raised an uncaught browser error'));
    }
    run.endedAt = now();
    if (run.result) run.result = redact(scrubInputs(run.result, inputs), project.config.redactFields);
    if (run.scenario.kind === 'api') run.scenario.fixture = sanitizeFixture(run.scenario.fixture, project.config.redactFields, inputs);
    store.put('runs', run);
    if (run.scenario.kind && run.scenario.kind !== 'baseline') store.artifact(project.id, run.id, 'scenario.json', 'application/json', Buffer.from(JSON.stringify({ scenario: run.scenario, result: run.result, error: run.error }, null, 2)));
    store.artifact(project.id, run.id, 'timeline.json', 'application/json', Buffer.from(JSON.stringify(store.list<RunEvent>('events', project.id).filter(e => e.runId === run.id).reverse(), null, 2)));
  }
  return run;
}
