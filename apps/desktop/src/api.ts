let token = '';
export async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
  if (!token && method !== 'GET') token = (await (await fetch('/api/session')).json()).token;
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-DCR-Token': token }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'The local service could not complete this request'); return result;
}
