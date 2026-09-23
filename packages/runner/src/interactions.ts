import type { Page } from 'playwright';
import { z } from 'zod';
import type { Project } from '../../core/src/index.ts';
import { assertTarget, redact, scrubInputs } from '../../core/src/redact.ts';
import { permittedPath } from '../../repo-analysis/src/sources.ts';
import { authSecrets } from './browser.ts';

export async function captureInteractions(page: Page, project: Project, onEvidence: (data: Record<string, unknown>) => void) {
  if (!project.config.understanding.bridgeEnabled) return;
  let count = 0;
  const schema = z.object({ id: z.string().uuid(), metadata: z.object({ file: z.string().max(500), line: z.number().int().positive().optional(), component: z.string().max(200), handler: z.string().max(200) }), startedAt: z.number(), durationMs: z.number().min(0), before: z.json(), after: z.json(), requests: z.array(z.object({ url: z.url(), method: z.string().max(20), status: z.number().optional(), failed: z.boolean().optional() })).max(30), failed: z.boolean(), provenance: z.literal('explicit-instrumentation') });
  await page.exposeBinding('__dcrInteraction', ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame() || count >= 100 || JSON.stringify(raw).length > 32000) return;
    const parsed = schema.safeParse(raw); if (!parsed.success) return;
    try { permittedPath(project, parsed.data.metadata.file); } catch { return; }
    parsed.data.requests = parsed.data.requests.filter(request => { try { const target = assertTarget(request.url, project.baseUrl, project.config); return !project.config.ignoreUrls.some(pattern => target.href.includes(pattern)); } catch { return false; } });
    count++; onEvidence(redact(scrubInputs(parsed.data, authSecrets(project)), project.config.redactFields));
  });
  await page.addInitScript({ content: "window.addEventListener('dcr:interaction', event => { try { const detail = JSON.parse(JSON.stringify(event.detail)); if (JSON.stringify(detail).length <= 32000) window.__dcrInteraction(detail).catch(() => {}); } catch {} });" });
}
