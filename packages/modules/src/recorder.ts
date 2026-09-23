import { randomUUID, createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';
import { stepSchema, type FlowDefinition, type Project } from '../../core/src/index.ts';
import { assertTarget, redactText } from '../../core/src/redact.ts';
import { authSecrets, authState, engines, login } from '../../runner/src/browser.ts';

type Session = { id: string; projectId: string; browser: Browser; page: Page; project: Project; tabs: Map<string, Page>; flow: FlowDefinition; warnings: string[]; stopped: boolean; timer: ReturnType<typeof setTimeout> };
export class FlowRecorder {
  sessions = new Map<string, Session>();
  starting = false;
  async start(project: Project, input: unknown, headless = false) {
    const { route, name } = z.object({ route: z.string().default('/'), name: z.string().min(1).max(120).default('Recorded flow') }).parse(input);
    if (this.starting || this.sessions.size >= 1) throw new Error('Stop and review the current recording first');
    const target = assertTarget(route, project.baseUrl, project.config);
    if (target.search || target.hash) throw new Error('Start recording from a URL without query data or fragments');
    if (target.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Recording requires localhost or HTTPS for private input fingerprinting');
    this.starting = true;
    const browser = await engines[project.config.browser].launch({ headless }).catch(error => { this.starting = false; throw error; });
    try {
      const context = await browser.newContext({ storageState: authState(project), serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        try { const url = assertTarget(route.request().url(), project.baseUrl, project.config); if (project.config.ignoreUrls.some(p => url.href.includes(p))) return await route.abort(); const response = await route.fetch({ maxRedirects: 0, timeout: 15000 }); if (response.status() >= 300 && response.status() < 400 && response.headers().location) return await route.abort(); await route.fulfill({ response }); } catch { await route.abort().catch(() => {}); }
      });
      await context.routeWebSocket('**/*', ws => ws.close());
      const page = await context.newPage(); page.setDefaultTimeout(7000); await login(page, project);
      const id = randomUUID();
      const session: Session = { id, projectId: project.id, browser, page, project, tabs: new Map([['main', page]]), stopped: false, flow: { name, description: 'Recorded interactions. Review inputs and add an assertion before running.', steps: [{ action: 'goto', url: target.href }] }, warnings: [], timer: setTimeout(() => { void browser.close(); }, 20 * 60 * 1000) };
      session.timer.unref(); this.sessions.set(id, session); browser.on('disconnected', () => { session.stopped = true; clearTimeout(session.timer); });
      const secrets = authSecrets(project), fingerprints = new Map<string, { hash: string; length: number }>();
      let historyFull = false, inputSequence = 0;
      const lastClicks = new Map<Page, { step: FlowDefinition['steps'][number]; at: number }>();
      const warning = (message: string) => { if (!session.warnings.includes(message)) session.warnings.push(message); };
      await context.exposeBinding('__dcrRecord', async ({ frame, page: sourcePage }, raw: unknown) => {
        if (session.stopped || historyFull) return;
        const tab = [...session.tabs].find(([, p]) => p === sourcePage)?.[0]; if (!tab) return;
        const frames: string[] = []; let current = frame;
        while (current.parentFrame()) { const handle = await current.frameElement(); const selector = await handle.evaluate((element, masks) => { const el = element as Element; if (el.closest(['[data-private]', ...masks].join(','))) return null; const parts: string[] = []; let node: Element | null = el; while (node && node !== document.documentElement) { const tag = node.tagName.toLowerCase(); const siblings = [...node.parentElement!.children].filter(n => n.tagName === node!.tagName); parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'); node = node.parentElement; } return 'html > ' + parts.join(' > '); }, project.config.maskSelectors); await handle.dispose(); if (!selector || frames.length >= 5) { warning('A private or deeply nested iframe was skipped'); return; } frames.unshift(selector); current = current.parentFrame()!; }
        if (session.flow.steps.length >= 99) { warning('Recording stopped at 99 steps. Split longer flows.'); return; }
        const data = z.object({ action: z.enum(['click', 'fill', 'select', 'upload', 'check', 'unsupported']), label: z.string().max(200).optional(), selector: z.string().regex(/^html(?: > [a-z][a-z0-9-]*:nth-of-type\(\d+\))+$/).max(500).optional(), role: z.enum(['button', 'link']).optional(), name: z.string().max(200).optional(), checked: z.boolean().optional(), historyFull: z.boolean().default(false), fingerprints: z.array(z.object({ id: z.string().max(100), hash: z.string().regex(/^[a-f0-9]{64}$/), length: z.number().int().min(1).max(10000) })).max(100).default([]) }).safeParse(raw);
        if (data.success) {
          historyFull = data.data.historyFull;
          for (const item of data.data.fingerprints) { if (fingerprints.size >= 100 && !fingerprints.has(item.hash)) historyFull = true; else fingerprints.set(item.hash, item); }
          if (historyFull) { warning('Recording stopped collecting actions at its private-input history limit. Review this draft and start another recording.'); return; }
        }
        lastClicks.delete(sourcePage);
        if (!data.success || data.data.action === 'unsupported') { warning('An unlabeled, private, or unsupported control was skipped. Add its step manually.'); return; }
        const { fingerprints: _, historyFull: _history, ...value } = data.data;
        const labels = [value.label || '', value.name || ''];
        const containsInput = labels.some(label => [...fingerprints.values()].some(({ hash, length }) => { for (let i = 0; i + length <= label.length; i++) if (createHash('sha256').update(label.slice(i, i + length)).digest('hex') === hash) return true; return false; }));
        if (containsInput || redactText(JSON.stringify(value)) !== JSON.stringify(value) || secrets.some(secret => JSON.stringify(value).includes(secret))) { warning('Sensitive control metadata was skipped. Add a safe locator manually.'); return; }
        let step: unknown = value;
        const previous = session.flow.steps.at(-1);
        if (['fill', 'select', 'upload'].includes(value.action)) { const label = value.label || ''; const continuing = value.action === 'fill' && previous?.action === 'fill' && previous.label === label && previous.tab === tab && JSON.stringify(previous.frames || []) === JSON.stringify(frames); const env = continuing ? previous.env : `DCR_${value.action === 'upload' ? 'UPLOAD' : 'INPUT'}_${++inputSequence}`; step = { action: value.action, label, env, ...(value.action === 'select' ? { selector: value.selector } : {}) }; }
        step = { ...(step as object), tab, ...(frames.length ? { frames } : {}) };
        const parsed = stepSchema.safeParse(step); if (!parsed.success) { warning('An action needs a usable accessible label. Add it manually.'); return; }
        if (parsed.data.action === 'fill' && previous?.action === 'fill' && parsed.data.label === previous.label && parsed.data.tab === previous.tab && JSON.stringify(parsed.data.frames) === JSON.stringify(previous.frames)) session.flow.steps[session.flow.steps.length - 1] = parsed.data;
        else session.flow.steps.push(parsed.data);
        if (parsed.data.action === 'click') lastClicks.set(sourcePage, { step: parsed.data, at: Date.now() });
      });
      // A string script avoids build-tool serialization helpers and never sends input values.
      await context.addInitScript({ content: `(() => {
        const privateSelector = ${JSON.stringify(['[data-private]', ...project.config.maskSelectors].join(','))};
        const inputs = new Map(), seenValues = new Set(), documentId = crypto.randomUUID();
        let sequence = 0, pending = Promise.resolve(), historyFull = false;
        const text = el => (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim();
        const referenced = el => (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean);
        const labelText = el => { const copy=el.cloneNode(true); copy.querySelectorAll('input,textarea,select').forEach(node=>node.remove()); return text(copy); };
        const label = el => { const refs=referenced(el); return refs.length ? refs.map(labelText).join(' ') : el.getAttribute('aria-label') || (el.labels && el.labels[0] && labelText(el.labels[0])) || ''; };
        const path = el => { const parts=[]; let node=el; while(node && node!==document.documentElement){ const tag=node.tagName.toLowerCase(), siblings=[...node.parentElement.children].filter(n=>n.tagName===node.tagName); parts.unshift(tag+':nth-of-type('+(siblings.indexOf(node)+1)+')'); node=node.parentElement; } return 'html > '+parts.join(' > '); };
        const privateControl = el => el.closest(privateSelector) || el.querySelector(privateSelector) || [...referenced(el),...(el.labels || [])].some(node=>node.closest(privateSelector)||node.querySelector(privateSelector));
        const send = data => {
          const values = [...inputs.entries()];
          if (historyFull || values.some(([,value]) => value && [data.name,data.label].some(label => label && label.includes(value)))) data = {action:'unsupported'};
          const full = historyFull;
          pending = pending.then(async () => {
            const fingerprints = await Promise.all(values.filter(([,value])=>value.length && value.length <= 10000).slice(0,100).map(async ([id,value]) => ({id, length:value.length,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('')})));
            await window.__dcrRecord({...data,fingerprints,historyFull:full});
          }).catch(() => {});
          window.__dcrFlush = () => pending;
        };
        document.addEventListener('click', event => {
          if (!event.isTrusted) return;
          const el = event.target.closest('button,a,[role="button"],[role="link"],input,textarea,select'); if (!el) return;
          if (privateControl(el)) return send({action:'unsupported'});
          if (el.matches('input,textarea,select')) return;
          if (!label(el) && el.querySelector('img[alt],svg title,[aria-hidden="true"]')) return send({action:'unsupported'});
          send({action:'click', role:el.matches('a,[role="link"]')?'link':'button', name:(label(el) || text(el)).slice(0,200)});
        }, true);
        document.addEventListener('input', event => {
          if (!event.isTrusted) return;
          const el = event.target; if (!el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),textarea')) return;
          if (el.value && !seenValues.has(el.value)) { if (inputs.size >= 100 || el.value.length > 10000) historyFull = true; else { seenValues.add(el.value); inputs.set(documentId+'-'+(++sequence),el.value); } }
          if (privateControl(el)) return send({action:'unsupported'});
          send({action:'fill',label:label(el)});
        }, true);
        document.addEventListener('change', event => {
          if (!event.isTrusted) return;
          const el = event.target; if (!el.matches('input,textarea,select')) return;
          if (privateControl(el)) return send({action:'unsupported'});
          if (el.matches('select,[type="file"]')) { const values = el.matches('select') ? [...el.selectedOptions].flatMap(o=>[o.value,o.textContent]) : [...el.files].map(f=>f.name); for (const value of values.filter(Boolean)) { if (!seenValues.has(value)) { if (inputs.size >= 100 || value.length > 10000) historyFull = true; else { seenValues.add(value); inputs.set(documentId+'-'+(++sequence),value); } } } if (el.multiple) return send({action:'unsupported'}); return send({action:el.matches('select')?'select':'upload',label:label(el),...(el.matches('select')?{selector:path(el)}:{})}); }
          if (el.type === 'radio') return send({action:'check',label:label(el),checked:el.checked});
          send(el.type === 'checkbox' ? {action:'check',label:label(el),checked:el.checked} : {action:'fill',label:label(el)});
        }, true);
      })();` });
      context.on('page', extra => { void (async () => { const opener = await extra.opener(); if (!opener) { warning('Use New tab in the recording controls to create a repeatable tab'); return; } await opener.evaluate('window.__dcrFlush?.()').catch(() => {}); const candidate = lastClicks.get(opener), previous = candidate?.step, tab = `tab${session.tabs.size + 1}`; if (!candidate || Date.now() - candidate.at > 2000 || previous !== session.flow.steps.at(-1) || previous?.action !== 'click' || !['link', 'button'].includes(previous.role)) { warning('A popup without a recorded click was skipped'); return; } session.flow.steps[session.flow.steps.length - 1] = stepSchema.parse({ ...previous, action: 'popup', popupTab: tab }); session.tabs.set(tab, extra); session.page = extra; })().catch(() => warning('A new tab needs manual review')); });
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return { id, projectId: project.id };
    } catch (error) { await browser.close(); for (const [id, session] of this.sessions) if (session.browser === browser) this.sessions.delete(id); throw error; }
    finally { this.starting = false; }
  }
  async navigate(id: string, input: unknown) {
    const session = this.sessions.get(id); if (!session || session.stopped) throw new Error('Recording is not active');
    const data = z.object({ action: z.enum(['back', 'forward', 'reload', 'goto', 'newTab', 'switchTab']), url: z.string().optional(), tab: z.string().default('main') }).parse(input);
    const page = session.tabs.get(data.tab); if (!page || page.isClosed()) throw new Error('Unknown or closed recording tab');
    for (const frame of page.frames()) await frame.evaluate('window.__dcrFlush?.()').catch(() => {});
    if (session.flow.steps.length >= 99) throw new Error('Recording reached the step limit');
    let step: any = { action: data.action, tab: data.tab };
    if (data.action === 'goto' || data.action === 'newTab') {
      const url = assertTarget(data.url || '/', session.project.baseUrl, session.project.config); if (url.search || url.hash) throw new Error('Use a URL without query data or fragments');
      step.url = url.href;
      if (data.action === 'newTab') { step.name = 'tab' + (session.tabs.size + 1); const next = await page.context().newPage(); session.tabs.set(step.name, next); await next.goto(url.href); session.page = next; }
      else await page.goto(url.href);
    } else if (data.action === 'switchTab') { step.name = data.tab; session.page = page; await page.bringToFront(); }
    else if (data.action === 'reload') await page.reload();
    else if (data.action === 'back') await page.goBack();
    else await page.goForward();
    session.flow.steps.push(stepSchema.parse(step)); return { tabs: [...session.tabs.keys()] };
  }
  async stop(id: string) {
    const session = this.sessions.get(id); if (!session) throw new Error('Recording not found');
    for (const page of session.tabs.values()) for (const frame of page.frames()) await frame.evaluate('window.__dcrFlush?.()').catch(() => {});
    session.stopped = true; clearTimeout(session.timer); await session.browser.close(); this.sessions.delete(id);
    return { flow: session.flow, warnings: [...session.warnings, 'Typed values are never saved. Set each DCR_INPUT environment variable, review the actions and add an assertText step. Use the recording navigation controls for repeatable navigation. Address-bar changes and native browser Back/Forward are not recorded. Dropdown values and upload paths also use environment references.'] };
  }
}
