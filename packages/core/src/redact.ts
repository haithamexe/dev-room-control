const sensitive = /authorization|cookie|token|password|passwd|secret|api.?key|card|cvv|cvc|email|phone|address|customer|first.?name|last.?name/i;
export function redactText(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD]')
    .replace(/((?:token|password|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s&,;"<>]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/g, value => { try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return '[URL]'; } });
}
export function redact(value: unknown, extra: string[] = []): any {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(v => redact(v, extra));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string' && sensitive.test(obj.name) && 'value' in obj) return { ...obj, value: '[REDACTED]' };
    return Object.fromEntries(Object.entries(obj).map(([key, v]) => [key, sensitive.test(key) || extra.includes(key) ? '[REDACTED]' : redact(v, extra)]));
  }
  return value;
}
export function assertTarget(raw: string, base: string, config: { environment: string; allowedOrigins: string[] }): URL {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) targets without embedded credentials are allowed');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (config.environment === 'local' ? !local : !config.allowedOrigins.includes(url.origin)) throw new Error(`Target is not allowed: ${url.origin}`);
  if (url.origin !== new URL(base).origin && !config.allowedOrigins.includes(url.origin)) throw new Error(`Add ${url.origin} to allowed origins first`);
  return url;
}
