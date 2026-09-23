import { chromium, firefox, webkit, type BrowserContextOptions, type Page, type FrameLocator } from 'playwright';
import { realpathSync, statSync } from 'node:fs';
import { within } from '../../storage/src/index.ts';
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
  const values = (project.config.auth?.loginFlow?.steps || []).flatMap(s => (s.action === 'fill' || s.action === 'select') && s.env ? [process.env[s.env] || ''] : []);
  // Collect available secrets independently of login validation so offline reports
  // remain readable after credentials expire or an environment variable is removed.
  let state: Exclude<BrowserContextOptions['storageState'], string | undefined> | undefined;
  try { const raw = process.env[project.config.auth?.storageStateEnv || '']; if (raw) state = JSON.parse(raw); } catch {}
  if (state) values.push(...(state.cookies || []).map(c => c.value), ...(state.origins || []).flatMap(o => (o.localStorage || []).map(v => v.value)));
  return values.filter(Boolean);
}
export type FlowTabs = { current: Page; pages: Map<string, Page> };
export async function performStep(page: Page, step: FlowDefinition['steps'][number], project: Project, baseUrl = project.baseUrl, orderId?: string, tabs?: FlowTabs) {
  if (tabs) {
    page = step.tab ? tabs.pages.get(step.tab)! : tabs.current;
    if (!page || page.isClosed()) throw new Error('The selected browser tab is unavailable');
    tabs.current = page;
    if (step.action === 'switchTab') { const selected = tabs.pages.get(step.name); if (!selected || selected.isClosed()) throw new Error('Unknown or closed browser tab'); tabs.current = selected; return; }
    if (step.action === 'newTab' || step.action === 'popup') {
      const key = step.action === 'newTab' ? step.name : step.popupTab;
      if (tabs.pages.has(key)) throw new Error('Tab names must be unique');
      let next: Page;
      if (step.action === 'newTab') { next = await page.context().newPage(); await next.goto(assertTarget(step.url, baseUrl, project.config).href, { waitUntil: 'domcontentloaded' }); }
      else { let scope: Page | FrameLocator = page; for (const frame of step.frames || []) scope = scope.frameLocator(frame); [next] = await Promise.all([page.waitForEvent('popup'), scope.getByRole(step.role, { name: step.name, exact: step.exact ?? true }).click()]); await next.waitForLoadState('domcontentloaded'); }
      tabs.pages.set(key, next); tabs.current = next; return;
    }
    if (step.action === 'closeTab') { await page.close(); tabs.current = [...tabs.pages.values()].find(p => !p.isClosed())!; if (!tabs.current) throw new Error('A flow must keep at least one tab open'); return; }
  } else if (['newTab', 'popup', 'closeTab', 'switchTab'].includes(step.action)) throw new Error('Tab actions are unavailable in login flows');
  let target: Page | FrameLocator = page;
  for (const frame of step.frames || []) target = target.frameLocator(frame);
  if (step.action === 'goto') await page.goto(assertTarget(orderId ? step.url.replaceAll('{orderId}', orderId) : step.url, baseUrl, project.config).href, { waitUntil: 'domcontentloaded' });
  if (step.action === 'click') await target.getByRole(step.role, { name: step.name, exact: step.exact ?? true }).click();
  if (step.action === 'fill' || step.action === 'select') { const value = step.env ? process.env[step.env] : step.value; if (value === undefined) throw new Error(`Missing environment reference: ${step.env}`); const control = step.action === 'select' && step.selector ? target.locator(step.selector) : target.getByLabel(step.label, { exact: step.exact ?? true }); if (step.action === 'fill') await control.fill(value); else await control.selectOption(value); }
  if (step.action === 'upload') { const path = process.env[step.env]; if (!path) throw new Error(`Missing upload environment reference: ${step.env}`); const file = realpathSync(within(project.path, path)); within(realpathSync(project.path), file); if (!statSync(file).isFile() || statSync(file).size > 20 * 1024 * 1024) throw new Error('Upload must be a file inside the repository, at most 20 MB'); await target.getByLabel(step.label, { exact: step.exact ?? true }).setInputFiles(file); }
  if (step.action === 'check') await target.getByLabel(step.label, { exact: step.exact ?? true }).setChecked(step.checked);
  if (step.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
  if (step.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
  if (step.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
  if (step.action === 'assertText') await target.getByText(step.text, { exact: step.exact ?? true }).waitFor({ state: 'visible' });
}
export async function login(page: Page, project: Project) { for (const step of project.config.auth?.loginFlow?.steps || []) await performStep(page, step, project); }
