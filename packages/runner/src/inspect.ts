import { chromium, type Page } from 'playwright';
import type { Project } from '../../core/src/index.ts';
import { assertTarget, redact } from '../../core/src/redact.ts';
import type { DriftRule, SourceLink } from '../../core/src/understanding.ts';
import { permittedPath } from '../../repo-analysis/src/sources.ts';
import { engines, authState, authSecrets, login } from './browser.ts';

export async function inspectPage<T>(project: Project, route: string, inspect: (page: Page) => Promise<T>, prepare?: (page: Page) => Promise<void>) {
  const target = assertTarget(route, project.baseUrl, project.config);
  if (target.search || target.hash) throw new Error('Inspection URLs must not contain query data or fragments');
  const browser = await engines[project.config.browser].launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', storageState: authState(project) });
    await context.route('**/*', async route => {
      try {
        const url = assertTarget(route.request().url(), project.baseUrl, project.config);
        if (project.config.ignoreUrls.some(p => url.href.includes(p))) return await route.abort();
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) return await route.abort();
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
    });
    await context.routeWebSocket('**/*', ws => ws.close());
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await prepare?.(page);
    await login(page, project);
    await page.goto(target.href, { waitUntil: 'load', timeout: 20000 });
    return await inspect(page);
  } finally { await browser.close(); }
}
export async function evidenceScreenshot(page: Page, project: Project) {
  return page.screenshot({ animations: 'disabled', mask: page.frames().flatMap(frame => [frame.locator('input, textarea, select, [data-private], [autocomplete]'), frame.getByText(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]*?){13,19}\b/), ...project.config.maskSelectors.map(s => frame.locator(s)), ...authSecrets(project).map(value => frame.getByText(value, { exact: false }))]) });
}
export function bridgeSource(project: Project, metadata: { file?: string; line?: string; component?: string; provenance?: string }): SourceLink[] {
  if (!project.config.understanding.bridgeEnabled || !metadata.file) return [];
  try { permittedPath(project, metadata.file); } catch { return []; }
  return [{ file: metadata.file.replaceAll('\\', '/'), line: Math.max(1, Math.min(100000, Number(metadata.line) || 1)), component: metadata.component, provenance: 'instrumented', reason: metadata.provenance === 'compiler' ? 'Development JSX transform: source location and enclosing declaration; metadata is supplied by the application' : 'Opt-in data-dcr-source metadata supplied by the application; not compiler-verified' }];
}
export async function elementFacts(page: Page, selector: string, bridgeEnabled: boolean, maskSelectors: string[] = []) {
  const locator = page.locator(selector).first(); await locator.waitFor({ state: 'visible' });
  return locator.evaluate((element, options) => {
    const privacySelector = ['input', 'textarea', '[data-private]', '[autocomplete]', ...options.maskSelectors].join(',');
    const privateElement = !!element.closest(privacySelector);
    const style = getComputedStyle(element), candidate = options.bridgeEnabled ? element.closest('[data-dcr-source]') : null;
    const owner = !privateElement && candidate && !candidate.closest(privacySelector) ? candidate : null;
    const visibleText = element.cloneNode(true) as Element, originals = [...element.querySelectorAll('*')], copies = [...visibleText.querySelectorAll('*')];
    originals.forEach((node, i) => { if (node.matches(privacySelector + ',script,style')) copies[i].remove(); });
    return { selector: '', tag: element.tagName.toLowerCase(), text: privateElement ? '[PRIVATE]' : (visibleText.textContent || '').slice(0, 500), attributes: privateElement ? {} : Object.fromEntries(['id', 'class', 'role', 'type', 'aria-label'].map(k => [k, element.getAttribute(k)])), styles: Object.fromEntries(['color', 'background-color', 'font-size', 'padding', 'margin', 'border-radius', 'display'].map(k => [k, style.getPropertyValue(k)])), bounds: element.getBoundingClientRect().toJSON(), metadata: owner ? { provenance: owner.getAttribute('data-dcr-provenance') || undefined, file: owner.getAttribute('data-dcr-source') || undefined, line: owner.getAttribute('data-dcr-line') || undefined, component: owner.getAttribute('data-dcr-component') || undefined } : {}, instrumentation: owner ? { route: owner.getAttribute('data-dcr-route'), handler: owner.getAttribute('data-dcr-handler'), state: owner.getAttribute('data-dcr-state') } : null };
  }, { bridgeEnabled, maskSelectors });
}
export async function scanDrift(page: Page, rules: DriftRule[]) {
  return page.evaluate(rules => {
    const results: any[] = [], gaps: string[] = [];
    for (const rule of rules) {
      let elements: Element[]; try { elements = [...document.querySelectorAll(rule.selector)]; } catch { throw new Error(`Invalid selector: ${rule.selector}`); }
      if (elements.length > 500) gaps.push(`${rule.name}: limited to first 500 matching elements`);
      if (!elements.length) gaps.push(`${rule.name}: selector matched no elements`);
      for (const element of elements.slice(0, 500)) {
        const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(element), observed = style.getPropertyValue(rule.property).trim();
        const expected = rule.values.map(token => {
          let value = token;
          if (/^var\(--[\w-]+\)$/.test(token)) value = style.getPropertyValue(token.slice(4, -1)).trim();
          if (!value || !CSS.supports(rule.property, value)) throw new Error(`Unresolved or invalid token ${token} for ${rule.name}`);
          // Resolve relative units/currentColor against the actual element. Restore
          // its exact inline style before collecting evidence or testing another value.
          const original = element.getAttribute('style'), target = element as HTMLElement;
          let normalized: string;
          try { target.style.setProperty('transition', 'none', 'important'); target.style.setProperty(rule.property, value, 'important'); normalized = getComputedStyle(element).getPropertyValue(rule.property).trim(); }
          finally { if (original === null) element.removeAttribute('style'); else element.setAttribute('style', original); }
          return { reference: token, value: normalized };
        });
        const allowed = expected.some(e => e.value === observed || /^-?\d+(?:\.\d+)?px$/.test(e.value) && /^-?\d+(?:\.\d+)?px$/.test(observed) && Math.abs(parseFloat(e.value) - parseFloat(observed)) <= rule.tolerance);
        if (!allowed) {
          const source = element.closest('[data-dcr-source]');
          const parts: string[] = []; let current: Element | null = element;
          while (current && current !== document.body) { const tag = current.tagName.toLowerCase(), siblings = current.parentElement ? [...current.parentElement.children].filter(n => n.tagName === current!.tagName) : []; parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`); current = current.parentElement; }
          const selector = element.id ? '#' + CSS.escape(element.id) : 'body > ' + parts.join(' > ');
          results.push({ rule: rule.name, property: rule.property, observed, expected, tolerance: rule.tolerance, selector, bounds: rect.toJSON(), metadata: source ? { file: source.getAttribute('data-dcr-source'), line: source.getAttribute('data-dcr-line'), component: source.getAttribute('data-dcr-component') } : {} });
          (element as HTMLElement).style.outline = '3px solid #e5484d'; (element as HTMLElement).style.outlineOffset = '2px';
        }
      }
    }
    return { results, gaps };
  }, rules);
}
