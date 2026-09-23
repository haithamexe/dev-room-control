import { chromium, firefox, webkit, type BrowserContextOptions, type Page } from 'playwright';
import type { Project, FlowDefinition } from '../../core/src/index.ts';
import { assertTarget } from '../../core/src/redact.ts';

export const engines = { chromium, firefox, webkit };
export function authState(project: Project): BrowserContextOptions['storageState'] {
  const name = project.config.auth?.storageStateEnv; if (!name) return;
  const raw = process.env[name]; if (!raw) throw new Error(`Missing authentication state environment reference: ${name}`);
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error('Authentication state must contain valid JSON'); }
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Authentication state must be a Playwright storage-state JSON object');
  const origins = [project.baseUrl, ...project.config.allowedOrigins].map(url => new URL(url));
  if (state.cookies.some((c: any) => !origins.some(u => u.hostname === String(c.domain).replace(/^\./, ''))) || state.origins.some((o: any) => !origins.some(u => u.origin === o.origin))) throw new Error('Authentication state contains an origin outside the project allowlist');
  return state;
}
export function authSecrets(project: Project): string[] {
  const values = (project.config.auth?.loginFlow?.steps || []).flatMap(s => s.action === 'fill' && s.env ? [process.env[s.env] || ''] : []);
  // Collect available secrets independently of login validation so offline reports
  // remain readable after credentials expire or an environment variable is removed.
  let state: Exclude<BrowserContextOptions['storageState'], string | undefined> | undefined;
  try { const raw = process.env[project.config.auth?.storageStateEnv || '']; if (raw) state = JSON.parse(raw); } catch {}
  if (state) values.push(...(state.cookies || []).map(c => c.value), ...(state.origins || []).flatMap(o => (o.localStorage || []).map(v => v.value)));
  return values.filter(Boolean);
}
export async function performStep(page: Page, step: FlowDefinition['steps'][number], project: Project, baseUrl = project.baseUrl, orderId?: string) {
  if (step.action === 'goto') await page.goto(assertTarget(orderId ? step.url.replaceAll('{orderId}', orderId) : step.url, baseUrl, project.config).href, { waitUntil: 'domcontentloaded' });
  if (step.action === 'click') await page.getByRole(step.role, { name: step.name, exact: true }).click();
  if (step.action === 'fill') { const value = step.env ? process.env[step.env] : step.value; if (value === undefined) throw new Error(`Missing environment reference: ${step.env}`); await page.getByLabel(step.label, { exact: true }).fill(value); }
  if (step.action === 'select') await page.getByLabel(step.label, { exact: true }).selectOption(step.value);
  if (step.action === 'check') await page.getByLabel(step.label, { exact: true }).setChecked(step.checked);
  if (step.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
  if (step.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
  if (step.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
  if (step.action === 'assertText') await page.getByText(step.text, { exact: true }).waitFor({ state: 'visible' });
}
export async function login(page: Page, project: Project) { for (const step of project.config.auth?.loginFlow?.steps || []) await performStep(page, step, project); }
