import { configSchema, type Project } from './index.ts';
import { assertTarget } from './redact.ts';
import { paymentAdapterSchema, type ScenarioDefinition, type PaymentAdapter } from './reliability.ts';

export function assertApiTarget(project: Project, raw: string, method = 'GET') {
  const config = configSchema.parse(project.config), url = assertTarget(raw, project.baseUrl, config);
  if (url.search || url.hash) throw new Error('API fixture URLs must not contain query data or fragments');
  if (!config.reliability.apiMethods.includes(method as any)) throw new Error(`Allow ${method} in reliability.apiMethods before capturing or mutating this method`);
  const path = decodeURIComponent(url.pathname);
  if (/auth|login|logout|session|token|password|payment|checkout|confirm|webhook|__fixtures/i.test(path)) throw new Error('Auth and payment endpoints cannot be API mutation targets');
  if (!config.reliability.apiPaths.includes(url.pathname)) throw new Error(`Allowlist the exact API path ${url.pathname} in project settings`);
  if (config.ignoreUrls.some(value => url.href.includes(value))) throw new Error('This API URL is ignored by project configuration');
  return url;
}
export function assertPayment(project: Project, adapter?: PaymentAdapter) {
  const config = configSchema.parse(project.config), payment = config.reliability.payment;
  if (!payment.testEnvironmentConfirmed || !payment.fixturesOnlyConfirmed) throw new Error('Confirm a test environment and fixture-only payment adapter in project settings first');
  const selected = paymentAdapterSchema.parse(adapter || payment.adapter);
  for (const key of ['createPath', 'statusPath', 'confirmPath', 'eventsPath'] as const) {
    if (selected[key] !== payment.adapter[key]) throw new Error('The saved payment adapter no longer matches the approved project configuration');
    const url = assertTarget(selected[key].replace('{orderId}', 'fixture-check'), project.baseUrl, config);
    if (!url.pathname.startsWith('/__fixtures/') || url.search || url.hash || config.ignoreUrls.some(value => url.href.includes(value))) throw new Error('Payment adapters must use allowed /__fixtures/ endpoints without query data');
  }
  if (!selected.statusPath.includes('{orderId}') || !selected.confirmPath.includes('{orderId}')) throw new Error('Status and confirmation paths must contain {orderId}');
  return selected;
}
export function assertScenario(project: Project, scenario: ScenarioDefinition) {
  const module = scenario.kind === 'api' || scenario.kind === 'capture' ? 'api' : scenario.kind === 'payment' ? 'payments' : 'time-machine';
  if (!project.config.modules.includes(module)) throw new Error(`Enable the ${module} module in project settings`);
  if (scenario.kind === 'api') assertApiTarget(project, scenario.fixture.url, scenario.fixture.method);
  if (scenario.kind === 'capture') assertApiTarget(project, scenario.url, scenario.method);
  if (scenario.kind === 'payment') assertPayment(project, scenario.adapter);
}
