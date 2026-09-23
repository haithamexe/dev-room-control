import { randomUUID, createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';
import { stepSchema, type FlowDefinition, type Project } from '../../core/src/index.ts';
import { assertTarget, redactText } from '../../core/src/redact.ts';
import { authSecrets, authState, engines, login } from '../../runner/src/browser.ts';

type Session = { id: string; projectId: string; browser: Browser; page: Page; flow: FlowDefinition; warnings: string[]; stopped: boolean; timer: ReturnType<typeof setTimeout> };
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
      const session: Session = { id, projectId: project.id, browser, page, stopped: false, flow: { name, description: 'Recorded interactions. Review inputs and add an assertion before running.', steps: [{ action: 'goto', url: target.href }] }, warnings: [], timer: setTimeout(() => { void browser.close(); }, 20 * 60 * 1000) };
      session.timer.unref(); this.sessions.set(id, session); browser.on('disconnected', () => { session.stopped = true; clearTimeout(session.timer); });
      const fields = new Map<string, string>(), secrets = authSecrets(project), fingerprints = new Map<string, { hash: string; length: number }>();
      let historyFull = false;
      const warning = (message: string) => { if (!session.warnings.includes(message)) session.warnings.push(message); };
      await page.exposeBinding('__dcrRecord', async ({ frame }, raw: unknown) => {
        if (frame !== page.mainFrame() || session.stopped || historyFull) return;
        if (session.flow.steps.length >= 99) { warning('Recording stopped at 99 steps. Split longer flows.'); return; }
        const data = z.object({ action: z.enum(['click', 'fill', 'check', 'unsupported']), label: z.string().max(200).optional(), role: z.enum(['button', 'link']).optional(), name: z.string().max(200).optional(), checked: z.boolean().optional(), historyFull: z.boolean().default(false), fingerprints: z.array(z.object({ id: z.string().max(100), hash: z.string().regex(/^[a-f0-9]{64}$/), length: z.number().int().min(1).max(10000) })).max(100).default([]) }).safeParse(raw);
        if (data.success) {
          historyFull = data.data.historyFull;
          for (const item of data.data.fingerprints) { if (fingerprints.size >= 100 && !fingerprints.has(item.hash)) historyFull = true; else fingerprints.set(item.hash, item); }
          if (historyFull) { warning('Recording stopped collecting actions at its private-input history limit. Review this draft and start another recording.'); return; }
        }
        if (!data.success || data.data.action === 'unsupported') { warning('An unlabeled, private, or unsupported control was skipped. Add its step manually.'); return; }
        const { fingerprints: _, historyFull: _history, ...value } = data.data;
        const labels = [value.label || '', value.name || ''];
        const containsInput = labels.some(label => [...fingerprints.values()].some(({ hash, length }) => { for (let i = 0; i + length <= label.length; i++) if (createHash('sha256').update(label.slice(i, i + length)).digest('hex') === hash) return true; return false; }));
        if (containsInput || redactText(JSON.stringify(value)) !== JSON.stringify(value) || secrets.some(secret => JSON.stringify(value).includes(secret))) { warning('Sensitive control metadata was skipped. Add a safe locator manually.'); return; }
        let step: unknown = value;
        if (value.action === 'fill') { const label = value.label || ''; if (!fields.has(label)) fields.set(label, `DCR_INPUT_${fields.size + 1}`); step = { action: 'fill', label, env: fields.get(label) }; }
        const parsed = stepSchema.safeParse(step); if (!parsed.success) { warning('An action needs a usable accessible label. Add it manually.'); return; }
        const previous = session.flow.steps.at(-1);
        if (parsed.data.action === 'fill' && previous?.action === 'fill' && parsed.data.label === previous.label) session.flow.steps[session.flow.steps.length - 1] = parsed.data;
        else session.flow.steps.push(parsed.data);
      });
      // A string script avoids build-tool serialization helpers and never sends input values.
      await page.addInitScript({ content: `(() => {
        const privateSelector = ${JSON.stringify(['[data-private]', ...project.config.maskSelectors].join(','))};
        const inputs = new Map(), seenValues = new Set(), documentId = crypto.randomUUID();
        let sequence = 0, pending = Promise.resolve(), historyFull = false;
        const text = el => (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim();
        const referenced = el => (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean);
        const label = el => { const refs=referenced(el); return refs.length ? refs.map(text).join(' ') : el.getAttribute('aria-label') || (el.labels && el.labels[0] && text(el.labels[0])) || ''; };
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
          if (privateControl(el) || el.matches('select,[type="file"],[type="radio"]')) return send({action:'unsupported'});
          send(el.type === 'checkbox' ? {action:'check',label:label(el),checked:el.checked} : {action:'fill',label:label(el)});
        }, true);
      })();` });
      context.on('page', extra => { if (extra !== page) { warning('A new tab was skipped. Record that tab as a separate flow.'); void extra.close(); } });
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return { id, projectId: project.id };
    } catch (error) { await browser.close(); for (const [id, session] of this.sessions) if (session.browser === browser) this.sessions.delete(id); throw error; }
    finally { this.starting = false; }
  }
  async stop(id: string) {
    const session = this.sessions.get(id); if (!session) throw new Error('Recording not found');
    await session.page.evaluate('window.__dcrFlush?.()').catch(() => {});
    session.stopped = true; clearTimeout(session.timer); await session.browser.close(); this.sessions.delete(id);
    return { flow: session.flow, warnings: [...session.warnings, 'Typed values are never saved. Set each DCR_INPUT environment variable, review the actions and add an assertText step. Manual address-bar navigation and browser Back/Forward are not recorded.'] };
  }
}
