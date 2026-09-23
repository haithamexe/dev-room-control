import { z } from 'zod';
export type StripeEvidence = { provider: 'stripe-test'; paymentIntentId: string; state: string; amount: number; currency: string };

export const endpointPath = z.string().regex(/^\/(?!\/)[^?#]*$/, 'Use an absolute path without a query or fragment');
export const paymentCases = ['back-after-success', 'refresh-after-success', 'duplicate-confirmation', 'forward-after-success', 'reopen-success', 'two-tabs', 'session-expiry', 'delayed-callback', 'failed-callback', 'refresh-before-confirmation'] as const;
export const paymentAdapterSchema = z.object({
  kind: z.literal('fixture-http').default('fixture-http'),
  createPath: endpointPath.default('/__fixtures/orders'),
  statusPath: endpointPath.default('/__fixtures/orders/{orderId}'),
  confirmPath: endpointPath.default('/__fixtures/orders/{orderId}/confirm'),
  eventsPath: endpointPath.default('/__fixtures/orders/{orderId}/events'),
  stateSelector: z.string().min(1).max(200).default('[data-payment-state]'),
  expectedText: z.string().min(1).max(200).default('Order confirmed'),
});
export const reliabilityConfigSchema = z.object({
  apiPaths: z.array(endpointPath).max(30).default([]),
  apiMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1).default(['GET']),
  payment: z.object({ testEnvironmentConfirmed: z.boolean().default(false), fixturesOnlyConfirmed: z.boolean().default(false), adapter: paymentAdapterSchema.default(() => paymentAdapterSchema.parse({})), gateway: z.object({ provider: z.enum(['fixture', 'stripe-test']).default('fixture'), enabled: z.boolean().default(false), secretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).default('STRIPE_TEST_SECRET_KEY') }).default({ provider: 'fixture', enabled: false, secretEnv: 'STRIPE_TEST_SECRET_KEY' }) }).default(() => ({ testEnvironmentConfirmed: false, fixturesOnlyConfirmed: false, adapter: paymentAdapterSchema.parse({}), gateway: { provider: 'fixture' as const, enabled: false, secretEnv: 'STRIPE_TEST_SECRET_KEY' } })),
});
export const mutationKinds = ['missing-field', 'null-field', 'empty-list', 'oversized-string', 'unauthorized', 'server-error', 'delay'] as const;
export const mutationSchema = z.object({ kind: z.enum(mutationKinds), pointer: z.string().max(300).default(''), delayMs: z.number().int().min(1).max(5000).default(800), stringLength: z.number().int().min(1).max(16000).default(4096) });
export const apiMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const requestMatchSchema = z.object({ mode: z.enum(['exact', 'subset']).default('exact'), json: z.json() });
export const fixtureInputSchema = z.object({ name: z.string().min(1).max(120), url: z.url(), method: apiMethodSchema.default('GET'), request: requestMatchSchema.optional(), schema: z.record(z.string(), z.json()).optional(), status: z.number().int().min(200).max(299).default(200), json: z.json() });
export type FixtureSnapshot = z.infer<typeof fixtureInputSchema>;
export type ApiFixture = FixtureSnapshot & { id: string; projectId: string; version: number; sourceRunId?: string; createdAt: string };
export type PaymentAdapter = z.infer<typeof paymentAdapterSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
export const scenarioInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api'), name: z.string().min(1).max(120), flowId: z.string().uuid(), fixtureId: z.string().uuid(), mutation: mutationSchema, expectedText: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('payment'), name: z.string().min(1).max(120), flowId: z.string().uuid(), paymentCase: z.enum(paymentCases) }),
]);
export type ScenarioDefinition =
  | { kind?: 'baseline'; name: string; version: number }
  | { kind: 'capture'; name: string; version: number; url: string; fixtureName: string; method?: z.infer<typeof apiMethodSchema>; request?: z.infer<typeof requestMatchSchema> }
  | { kind: 'api'; name: string; version: number; fixture: FixtureSnapshot; mutation: Mutation; expectedText: string }
  | { kind: 'payment'; name: string; version: number; paymentCase: typeof paymentCases[number]; adapter: PaymentAdapter };
export type Scenario = { id: string; projectId: string; flowId: string; definition: ScenarioDefinition; createdAt: string; fixtureId?: string };
export type Matrix = { id: string; ownerPid?: number; projectId: string; name: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; runIds: string[]; scenarioIds: string[]; nextIndex?: number; plans?: { scenario: Scenario; flow: import('./index.ts').Flow }[]; createdAt: string; endedAt?: string; error?: string };
export type ScenarioResult = { expected: unknown; observed: unknown; matchedRequests?: number; fixtureId?: string; orderId?: string; passed: boolean };

// Exact JSON Pointer traversal; only existing own properties may be changed.
export function mutateFixture(fixture: FixtureSnapshot, mutation: Mutation) {
  let json: any = structuredClone(fixture.json), status = fixture.status;
  if (mutation.kind === 'unauthorized') return { status: 401, json: { error: 'Fixture session expired' }, delayMs: 0 };
  if (mutation.kind === 'server-error') return { status: 500, json: { error: 'Fixture server failure' }, delayMs: 0 };
  if (mutation.kind === 'delay') return { status, json, delayMs: mutation.delayMs };
  const parts = mutation.pointer === '' ? [] : mutation.pointer.startsWith('/') ? mutation.pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~')) : null;
  if (!parts || parts.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('Use a safe JSON Pointer such as /items or /items/0/subtitle');
  let parent: any = null, key = '', current = json;
  for (const part of parts) { if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) throw new Error(`Fixture has no field at ${mutation.pointer}`); parent = current; key = part; current = current[part]; }
  let replacement: any;
  if (mutation.kind === 'empty-list') { if (!Array.isArray(current)) throw new Error('empty-list requires an array'); replacement = []; }
  if (mutation.kind === 'oversized-string') { if (typeof current !== 'string') throw new Error('oversized-string requires a string'); replacement = 'X'.repeat(mutation.stringLength); }
  if (mutation.kind === 'null-field') replacement = null;
  if (mutation.kind === 'missing-field') { if (!parent || Array.isArray(parent)) throw new Error('missing-field requires an object property'); delete parent[key]; }
  else if (!parts.length) json = replacement;
  else parent[key] = replacement;
  return { status, json, delayMs: 0 };
}
