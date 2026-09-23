import type { FixtureSnapshot, Mutation } from './reliability.ts';
import { redact, scrubInputs } from './redact.ts';

export function sanitizeFixture<T extends FixtureSnapshot>(fixture: T, fields: string[], inputs: string[] = []): T {
  return { ...fixture, json: redact(scrubInputs(fixture.json, inputs), fields),
    request: fixture.request ? { ...fixture.request, json: redact(scrubInputs(fixture.request.json, inputs), fields) } : undefined,
    schema: fixture.schema ? redact(scrubInputs(fixture.schema, inputs), fields) : undefined };
}

export function bodyMatches(expected: unknown, actual: unknown, subset = false): boolean {
  if (expected === actual) return true;
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return false;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  if ((!subset || Array.isArray(expected)) && keys.length !== Object.keys(actual).length) return false;
  return keys.every(key => Object.hasOwn(actual, key) && bodyMatches((expected as any)[key], (actual as any)[key], subset));
}
export function requestMatches(match: FixtureSnapshot['request'], raw: string | null, fields: string[], inputs: string[] = []) {
  if (!match) return true;
  try { const actual = raw === null ? null : JSON.parse(raw); return bodyMatches(redact(scrubInputs(match.json, inputs), fields), redact(scrubInputs(actual, inputs), fields), match.mode === 'subset'); } catch { return false; }
}

export function suggestMutations(fixture: FixtureSnapshot): { name: string; reason: string; mutation: Mutation }[] {
  const result: ReturnType<typeof suggestMutations> = [];
  const add = (kind: Mutation['kind'], pointer: string, reason: string, length = 4096) => result.push({ name: `${kind}: ${pointer || '/'}`, reason, mutation: { kind, pointer, delayMs: 800, stringLength: length } });
  const visit = (value: any, schema: any, pointer: string, depth: number) => {
    if (depth > 6 || result.length >= 30 || !schema || typeof schema !== 'object' || schema.$ref) return;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (value !== null && (types.includes('null') || schema.nullable === true)) add('null-field', pointer, 'Schema allows null');
    if (Array.isArray(value)) { if (!(schema.minItems > 0)) add('empty-list', pointer, 'Schema permits an empty list'); if (value.length) visit(value[0], schema.items, pointer + '/0', depth + 1); }
    else if (typeof value === 'string') { const length = Number.isInteger(schema.maxLength) ? schema.maxLength + 1 : 4096; if (length <= 16000) add('oversized-string', pointer, schema.maxLength !== undefined ? 'Exceeds schema maxLength' : 'Long-string resilience probe', Math.max(1, length)); }
    else if (value && typeof value === 'object' && schema.properties) {
      for (const key of Object.keys(value).slice(0, 30)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(schema.properties, key)) continue;
        const path = pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
        if (!(schema.required || []).includes(key)) add('missing-field', path, 'Schema marks this property optional');
        visit(value[key], schema.properties[key], path, depth + 1); if (result.length >= 30) break;
      }
    }
  };
  visit(fixture.json, fixture.schema, '', 0);
  return result.slice(0, 30);
}
