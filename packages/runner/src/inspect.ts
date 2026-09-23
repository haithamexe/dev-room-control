import { chromium, type Page } from 'playwright';
import type { Project } from '../../core/src/index.ts';
import { assertTarget, redact } from '../../core/src/redact.ts';
import type { DriftRule, SourceLink } from '../../core/src/understanding.ts';
import { permittedPath } from '../../repo-analysis/src/sources.ts';

export async function inspectPage<T>(project: Project, route: string, inspect: (page: Page) => Promise<T>) {
  const target = assertTarget(route, project.baseUrl, project.config);
  if (target.search || target.hash) throw new Error('Inspection URLs must not contain query data or fragments');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
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
    await page.goto(target.href, { waitUntil: 'load', timeout: 20000 });
    return await inspect(page);
  } finally { await browser.close(); }
}
export async function evidenceScreenshot(page: Page, project: Project) {
  return page.screenshot({ animations: 'disabled', mask: [page.locator('input, textarea, [data-private], [autocomplete]'), page.getByText(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]*?){13,19}\b/), ...project.config.maskSelectors.map(s => page.locator(s))] });
}
export function bridgeSource(project: Project, metadata: { file?: string; line?: string; component?: string }): SourceLink[] {
  if (!project.config.understanding.bridgeEnabled || !metadata.file) return [];
  try { permittedPath(project, metadata.file); } catch { return []; }
  return [{ file: metadata.file.replaceAll('\\', '/'), line: Math.max(1, Math.min(100000, Number(metadata.line) || 1)), component: metadata.component, provenance: 'instrumented', reason: 'Opt-in data-dcr-source metadata supplied by the application; not compiler-verified' }];
}
export async function elementFacts(page: Page, selector: string, bridgeEnabled: boolean) {
  const locator = page.locator(selector).first(); await locator.waitFor({ state: 'visible' });
  return locator.evaluate((element, bridge) => {
    const style = getComputedStyle(element), owner = bridge ? element.closest('[data-dcr-source]') : null;
    const privateElement = !!element.closest('input,textarea,[data-private],[autocomplete]');
    const visibleText = element.cloneNode(true) as Element; visibleText.querySelectorAll('input,textarea,[data-private],[autocomplete],script,style').forEach(el => el.remove());
    return { selector: '', tag: element.tagName.toLowerCase(), text: privateElement ? '[PRIVATE]' : (visibleText.textContent || '').slice(0, 500), attributes: Object.fromEntries(['id', 'class', 'role', 'type', 'aria-label'].map(k => [k, element.getAttribute(k)])), styles: Object.fromEntries(['color', 'background-color', 'font-size', 'padding', 'margin', 'border-radius', 'display'].map(k => [k, style.getPropertyValue(k)])), bounds: element.getBoundingClientRect().toJSON(), metadata: owner ? { file: owner.getAttribute('data-dcr-source') || undefined, line: owner.getAttribute('data-dcr-line') || undefined, component: owner.getAttribute('data-dcr-component') || undefined } : {}, instrumentation: owner ? { route: owner.getAttribute('data-dcr-route'), handler: owner.getAttribute('data-dcr-handler'), state: owner.getAttribute('data-dcr-state') } : null };
  }, bridgeEnabled);
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
          const probe = document.createElement('span'); probe.style.setProperty(rule.property, value); probe.style.position = 'absolute'; probe.style.visibility = 'hidden'; element.parentElement?.append(probe); const normalized = getComputedStyle(probe).getPropertyValue(rule.property).trim(); probe.remove(); return { reference: token, value: normalized };
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
