import type { Page } from 'playwright';
import type { Project } from '../../core/src/index.ts';
import { redact, scrubInputs } from '../../core/src/redact.ts';
import { authSecrets } from './browser.ts';

export async function inspectReact(page: Page, selector: string, project: Project) {
  if (!project.config.understanding.reactInspection) return undefined;
  const inspectElement = (element: Element, options: { masks: string[]; fields: string[] }) => {
    const privacy = ['input', 'textarea', '[data-private]', '[autocomplete]', ...options.masks].join(',');
    if (element.closest(privacy) || element.querySelector(privacy)) return { status: 'private', owners: [], note: 'Private element: runtime inspection omitted' };
    const privateValues = [...document.querySelectorAll(privacy)].flatMap(node => ['value' in node ? String(node.value || '') : '', node.textContent || '']).filter(Boolean);
    const sensitive = /authorization|cookie|token|password|passwd|secret|api.?key|card|cvv|cvc|email|phone|address|customer|first.?name|last.?name/i;
    const own = (value: any, key: string) => { try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
    const cleanString = (value: string) => privateValues.reduce((text, secret) => text.split(secret).join('[PRIVATE]'), value).slice(0, 300);
    const snapshot = (value: any, depth = 0): any => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') return cleanString(value);
      if (typeof value !== 'object' || depth >= 3) return '[Not expanded]';
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return '[Non-JSON value]';
      if (Array.isArray(value)) return Array.from({ length: Math.min(12, value.length) }, (_, i) => snapshot(own(value, String(i)), depth + 1));
      return Object.fromEntries(Object.keys(value).slice(0, 20).filter(key => key !== 'children').map(key => [cleanString(key), sensitive.test(key) || options.fields.includes(key) ? '[REDACTED]' : snapshot(own(value, key), depth + 1)]));
    };
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? own(element, key) : undefined;
    if (!fiber) return { status: 'unavailable', owners: [], note: 'No supported React fiber found on this element' };
    let root = fiber, hops = 0;
    while (own(root, 'return') && hops++ < 200) root = own(root, 'return');
    const currentRoot = own(own(root, 'stateNode'), 'current');
    if (!currentRoot) return { status: 'unavailable', owners: [], note: 'Unable to resolve the committed React tree' };
    // DOM pointers can point at the alternate fiber. Resolve from the committed root.
    const stack = [currentRoot]; fiber = undefined; let visited = 0;
    while (stack.length && visited++ < 20000) { const candidate = stack.pop(); if (own(candidate, 'stateNode') === element) { fiber = candidate; break; } const sibling = own(candidate, 'sibling'), child = own(candidate, 'child'); if (sibling) stack.push(sibling); if (child) stack.push(child); }
    if (!fiber) return { status: 'unavailable', owners: [], note: 'Element not found within the committed-tree inspection limit' };
    const handlers = Object.keys(own(fiber, 'memoizedProps') || {}).filter(key => /^on[A-Z]/.test(key) && typeof own(own(fiber, 'memoizedProps'), key) === 'function').slice(0, 30);
    const owners: any[] = []; hops = 0;
    for (let owner = own(fiber, 'return'); owner && owners.length < 12 && hops++ < 200; owner = own(owner, 'return')) {
      const tag = own(owner, 'tag'); if (![0, 1, 11, 14, 15].includes(tag)) continue;
      const type = own(owner, 'type'), render = own(type, 'render');
      const name = own(type, 'displayName') || own(type, 'name') || own(render, 'name') || 'Anonymous component';
      const state = own(owner, 'memoizedState'), hooks: any[] = [];
      if (tag !== 1) { let hook = state; for (let index = 0; hook && index < 30; index++, hook = own(hook, 'next')) if (own(hook, 'queue')) hooks.push({ slot: index, value: snapshot(own(hook, 'memoizedState')) }); }
      owners.push({ name: cleanString(String(name)), kind: tag === 1 ? 'class' : 'function', props: snapshot(own(owner, 'memoizedProps')), ...(tag === 1 ? { state: snapshot(state) } : { stateHooks: hooks }) });
    }
    return { status: 'observed', owners, handlers, note: 'Best-effort React internals from the committed tree. Hook slots have no inferred variable names; handlers are prop names, not proven call paths.' };
  };
  const result = await page.locator(selector).first().evaluate(new Function('element', 'options', `const __name = fn => fn; return (${inspectElement.toString()})(element, options);`) as (element: Element, options: { masks: string[]; fields: string[] }) => unknown, { masks: project.config.maskSelectors, fields: project.config.redactFields });
  return redact(scrubInputs(result, authSecrets(project)), project.config.redactFields);
}
