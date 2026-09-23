import type { BrowserContext, Page } from 'playwright';
import type { Project, Run, RunEvent } from '../../core/src/index.ts';
import { assertPayment } from '../../core/src/reliability-policy.ts';
import { assertTarget } from '../../core/src/redact.ts';
type Emit = (kind: RunEvent['kind'], title: string, data?: Record<string, unknown>) => unknown;

export async function paymentRequest(context: BrowserContext, project: Project, path: string, method: 'GET' | 'POST', data?: unknown) {
  const url = assertTarget(path, project.baseUrl, project.config);
  if (!url.pathname.startsWith('/__fixtures/')) throw new Error('Only the fixture HTTP protocol is supported');
  const response = await context.request.fetch(url.href, { method, data, maxRedirects: 0, timeout: 10000 });
  if (response.status() < 200 || response.status() >= 300 || response.headers()['x-dcr-fixture'] !== '1') throw new Error(`Fixture adapter rejected ${method} ${url.pathname} (HTTP ${response.status()}). Required header: X-DCR-Fixture: 1`);
  const bytes = await response.body(); if (bytes.length > 64000) throw new Error('Fixture adapter response exceeds 64 KB');
  return JSON.parse(bytes.toString());
}
export async function preparePayment(context: BrowserContext, project: Project, run: Run, event: Emit) {
  if (run.scenario.kind !== 'payment') return undefined;
  const adapter = assertPayment(project, run.scenario.adapter);
  // Read-only handshake must succeed before creating or confirming any fixture order.
  const capability = await paymentRequest(context, project, adapter.createPath, 'GET');
  if (capability.protocol !== 'dcr-fixture-v1') throw new Error('Adapter must advertise dcr-fixture-v1');
  const order = await paymentRequest(context, project, adapter.createPath, 'POST', { id: `dcr-${run.id}`, amount: 3200, currency: 'USD' });
  if (typeof order.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(order.id) || order.id !== `dcr-${run.id}`) throw new Error('Fixture adapter must return the isolated requested order ID');
  event('action', 'Created isolated fixture order', { orderId: order.id, adapter: adapter.kind });
  return order.id as string;
}
export async function checkPayment(context: BrowserContext, page: Page, project: Project, run: Run, orderId: string, event: Emit) {
  if (run.scenario.kind !== 'payment') return;
  const { adapter, paymentCase } = run.scenario;
  const readState = async () => {
    const raw = await paymentRequest(context, project, adapter.statusPath.replace('{orderId}', orderId), 'GET');
    if (raw.id !== orderId || typeof raw.state !== 'string' || !Number.isInteger(raw.confirmationCount)) throw new Error('Adapter status must return this order id, state, and integer confirmationCount');
    return { state: raw.state as string, confirmationCount: raw.confirmationCount as number };
  };
  const initial = await readState();
  event('assertion', 'Authoritative state before stress action', { expected: { state: 'confirmed', confirmationCount: 1 }, observed: initial, passed: initial.state === 'confirmed' && initial.confirmationCount === 1 });
  if (initial.state !== 'confirmed' || initial.confirmationCount !== 1) throw new Error('The base checkout did not confirm exactly once according to the fixture server');
  event('action', `Payment scenario: ${paymentCase}`, { orderId });
  if (paymentCase === 'back-after-success') await page.goBack({ waitUntil: 'domcontentloaded' });
  if (paymentCase === 'refresh-after-success') await page.reload({ waitUntil: 'domcontentloaded' });
  if (paymentCase === 'duplicate-confirmation') await paymentRequest(context, project, adapter.confirmPath.replace('{orderId}', orderId), 'POST', { eventId: `confirmation-${orderId}` });
  let visible = false;
  try { await page.getByText(adapter.expectedText, { exact: true }).waitFor({ state: 'visible', timeout: 3000 }); visible = true; } catch { /* still collect authoritative server evidence */ }
  const server = await readState();
  const browserState = await page.locator(adapter.stateSelector).first().textContent({ timeout: 1500 }).catch(() => 'State element not found');
  const expected = { browserText: adapter.expectedText, server: { state: 'confirmed', confirmationCount: 1 } };
  const observed = { browserState, route: page.url(), server, expectedTextVisible: visible };
  const passed = visible && server.state === 'confirmed' && server.confirmationCount === 1;
  run.result = { expected, observed, orderId, passed };
  event('assertion', 'Browser and authoritative fixture state', { expected, observed, passed, orderId });
  if (!passed) throw new Error(`Payment invariant failed: ${paymentCase}. Browser: ${browserState}; server: ${server.state}, confirmation count ${server.confirmationCount} (expected 1).`);
}
