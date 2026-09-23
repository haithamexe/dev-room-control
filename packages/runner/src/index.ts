import { chromium, type Browser, type BrowserContext } from 'playwright';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from '../../storage/src/index.ts';
import type { Flow, Run, Project, RunEvent } from '../../core/src/index.ts';
import { redact, redactText, assertTarget } from '../../core/src/redact.ts';
import { snapshot } from '../../repo-analysis/src/index.ts';

// Raw Playwright network resources can contain credentials. Keep action records only.
export function sanitizeTrace(bytes: Uint8Array, fields: string[]) {
  const output: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (!name.endsWith('.trace') && !name.endsWith('.stacks')) continue;
    const lines = strFromU8(data).split('\n').filter(Boolean).map(line => {
      const entry = JSON.parse(line);
      if (entry.type === 'frame-snapshot' || entry.type === 'screencast-frame') return '';
      if (entry.params?.value) entry.params.value = '[REDACTED]';
      if (entry.params?.text) entry.params.text = '[REDACTED]';
      return JSON.stringify(redact(entry, fields));
    }).filter(Boolean);
    output[name] = strToU8(lines.join('\n') + '\n');
  }
  return zipSync(output);
}
export function createRun(store: Store, project: Project, flow: Flow, replay?: Run): Run {
  assertTarget(replay?.baseUrl || project.baseUrl, project.baseUrl, project.config);
  return store.put('runs', { id: id(), projectId: project.id, flowId: flow.id, name: replay?.name || flow.name, status: 'running', startedAt: now(), baseUrl: replay?.baseUrl || project.baseUrl, flow: replay?.flow || { name: flow.name, description: flow.description, steps: flow.steps }, scenario: replay?.scenario || { name: 'Baseline', version: 1 }, git: snapshot(project.path), replayOf: replay?.id });
}
export async function executeRun(store: Store, project: Project, run: Run) {
  let browser: Browser | undefined, context: BrowserContext | undefined;
  const temp = mkdtempSync(join(tmpdir(), 'dcr-trace-'));
  const event = (kind: RunEvent['kind'], title: string, data: Record<string, unknown> = {}) => store.put('events', { id: id(), runId: run.id, projectId: project.id, at: now(), kind, title: redactText(title), data: redact(data, project.config.redactFields) });
  const pending = new Set<Promise<void>>();
  let activeStep = 'Launch browser';
  try {
    browser = await chromium.launch({ headless: true }); run.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = route.request().url();
      try {
        assertTarget(url, run.baseUrl, project.config);
        if (project.config.ignoreUrls.some(pattern => url.includes(pattern))) return route.abort();
        await route.continue();
      } catch { event('request', 'Blocked non-allowlisted request', { url }); await route.abort(); }
    });
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(15000);
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) event('console', msg.text(), { level: msg.type() }); });
    page.on('pageerror', error => event('error', error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) event('navigation', 'Page navigation', { url: frame.url() }); });
    page.on('requestfailed', request => event('request', 'Request failed', { url: request.url(), method: request.method(), error: request.failure()?.errorText }));
    page.on('response', response => {
      const job = (async () => {
        const request = response.request();
        if (!['fetch', 'xhr', 'document'].includes(request.resourceType())) return;
        await response.finished();
        const data: Record<string, unknown> = { url: response.url(), method: request.method(), status: response.status(), duration: Math.max(0, Math.round(request.timing().responseEnd)) };
        if (project.config.captureBodies && response.headers()['content-type']?.includes('application/json')) {
          try { const body = await response.body(); if (body.length < 64000) data.body = JSON.parse(body.toString()); } catch { /* response may be interrupted */ }
        }
        event('request', `${request.method()} ${new URL(response.url()).pathname}`, data);
      })().catch(() => {});
      pending.add(job); void job.finally(() => pending.delete(job));
    });
    for (const [index, step] of run.flow.steps.entries()) {
      activeStep = `${index + 1}. ${step.action}${'name' in step ? ` · ${step.name}` : 'text' in step ? ` · ${step.text}` : ''}`;
      event('action', activeStep, { step: index + 1, action: step.action });
      if (step.action === 'goto') await page.goto(assertTarget(step.url, run.baseUrl, project.config).href, { waitUntil: 'domcontentloaded' });
      if (step.action === 'click') await page.getByRole(step.role, { name: step.name, exact: true }).click();
      if (step.action === 'fill') { const value = step.env ? process.env[step.env] : step.value; if (value === undefined) throw new Error(`Missing environment reference: ${step.env}`); await page.getByLabel(step.label, { exact: true }).fill(value); }
      if (step.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      if (step.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      if (step.action === 'assertText') { await page.getByText(step.text, { exact: true }).waitFor({ state: 'visible' }); event('assertion', `Visible: ${step.text}`, { expected: step.text, observed: 'visible', passed: true }); }
    }
    run.status = 'passed';
  } catch (error) {
    run.status = 'failed'; run.error = redactText(error instanceof Error ? error.message : String(error));
    event('error', `Failed at ${activeStep}`, { error: run.error });
    const finding = store.put('findings', { id: id(), projectId: project.id, runId: run.id, title: `${run.name} did not complete`, expected: activeStep, observed: run.error, status: 'open', createdAt: now() });
    event('assertion', 'Flow failed', { findingId: finding.id, expected: activeStep, observed: run.error, passed: false });
  } finally {
    if (context) {
      try {
        const page = context.pages()[0];
        if (page && !page.isClosed()) {
          // Mask form fields, explicit private regions, and common personal-data text.
          const masks = [page.locator('input, textarea, [data-private], [autocomplete]'), page.getByText(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]*?){13,19}\b/), ...project.config.maskSelectors.map(s => page.locator(s))];
          store.artifact(project.id, run.id, 'screenshot.png', 'image/png', await page.screenshot({ fullPage: false, mask: masks, animations: 'disabled', timeout: 5000 }));
        }
      } catch (e) { event('error', 'Screenshot unavailable', { error: String(e) }); }
      try { const path = join(temp, 'trace.zip'); await context.tracing.stop({ path }); store.artifact(project.id, run.id, 'trace.zip', 'application/zip', sanitizeTrace(readFileSync(path), project.config.redactFields)); } catch (e) { event('error', 'Trace unavailable', { error: String(e) }); }
      await context.close().catch(() => {});
    }
    await Promise.allSettled([...pending]);
    await browser?.close().catch(() => {}); rmSync(temp, { recursive: true, force: true });
    run.endedAt = now(); store.put('runs', run);
    store.artifact(project.id, run.id, 'timeline.json', 'application/json', Buffer.from(JSON.stringify(store.list<RunEvent>('events', project.id).filter(e => e.runId === run.id).reverse(), null, 2)));
  }
  return run;
}
