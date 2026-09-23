export type InteractionMetadata = { file: string; line?: number; component: string; handler: string };
type RequestRecord = { url: string; method: string; status?: number; failed?: boolean };

/** Explicit scope, not time-based correlation. Use scope.request for related calls. */
export async function traceInteraction<T>(metadata: InteractionMetadata, handler: (scope: { request: typeof fetch }) => Promise<T>, options: { enabled?: boolean; state?: () => unknown } = {}) {
  if (!options.enabled) return handler({ request: fetch });
  const requests: RequestRecord[] = [], id = crypto.randomUUID(), startedAt = Date.now();
  const state = () => { try { return JSON.parse(JSON.stringify(options.state?.() ?? null)); } catch { return '[Unavailable]'; } };
  const before = state(); let failed = false;
  const request: typeof fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input), url = new URL(raw, location.href);
    const record: RequestRecord = { url: url.origin + url.pathname, method: init?.method || (input instanceof Request ? input.method : 'GET') };
    if (requests.length < 30) requests.push(record);
    try { const response = await fetch(input, init); record.status = response.status; return response; } catch (error) { record.failed = true; throw error; }
  };
  try { return await handler({ request }); }
  catch (error) { failed = true; throw error; }
  finally { window.dispatchEvent(new CustomEvent('dcr:interaction', { detail: { id, metadata, startedAt, durationMs: Date.now() - startedAt, before, after: state(), requests, failed, provenance: 'explicit-instrumentation' } })); }
}
