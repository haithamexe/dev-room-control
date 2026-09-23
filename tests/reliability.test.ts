import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, type Project } from '../packages/core/src/index.ts';
import { mutateFixture, mutationSchema, fixtureInputSchema, paymentAdapterSchema } from '../packages/core/src/reliability.ts';
import { assertApiTarget, assertPayment } from '../packages/core/src/reliability-policy.ts';
const fixture = fixtureInputSchema.parse({ name: 'Products', url: 'http://localhost:3000/api/products', json: { items: [{ name: 'Tote', subtitle: 'Cotton' }] } });
const mutate = (kind: string, pointer = '') => mutateFixture(fixture, mutationSchema.parse({ kind, pointer }));
test('all API mutations are deterministic and leave the captured fixture unchanged', () => {
  const original = structuredClone(fixture);
  assert.deepEqual(mutate('empty-list', '/items').json, { items: [] });
  assert.deepEqual(mutate('missing-field', '/items/0/subtitle').json, { items: [{ name: 'Tote' }] });
  assert.deepEqual(mutate('null-field', '/items/0/subtitle').json.items[0].subtitle, null);
  assert.equal(mutate('oversized-string', '/items/0/name').json.items[0].name.length, 4096);
  assert.equal(mutate('unauthorized').status, 401); assert.equal(mutate('server-error').status, 500); assert.equal(mutate('delay').delayMs, 800);
  assert.deepEqual(mutate('empty-list', '/items'), mutate('empty-list', '/items')); assert.deepEqual(fixture, original);
});
test('JSON Pointer traversal rejects unsafe keys and incompatible field types', () => {
  for (const pointer of ['/__proto__/x', '/items/constructor', '/items/4', 'items']) assert.throws(() => mutate('null-field', pointer));
  assert.throws(() => mutate('empty-list', '/items/0/name')); assert.throws(() => mutate('missing-field', '/items/0')); assert.throws(() => mutate('missing-field'));
  assert.equal(({} as any).x, undefined);
});
test('Phase 1 configurations migrate with labs disabled and no payment confirmation', () => {
  const config = configSchema.parse({ modules: ['time-machine', 'tasks'] });
  assert.deepEqual(config.reliability.apiPaths, []); assert.equal(config.reliability.payment.fixturesOnlyConfirmed, false); assert.equal(config.reliability.payment.testEnvironmentConfirmed, false);
});
test('API allowlist is exact and cannot include auth or payment endpoints', () => {
  const p = { baseUrl: 'http://localhost:3000', config: configSchema.parse({ reliability: { apiPaths: ['/api/products', '/api/payment', '/api/auth', '/api/session', '/__fixtures/orders'] } }) } as Project;
  assert.equal(assertApiTarget(p, '/api/products').pathname, '/api/products');
  for (const path of ['/api/products/1', '/api/payment', '/api/auth', '/api/session', '/__fixtures/orders', '/api/products?token=x', 'http://localhost:4000/api/products']) assert.throws(() => assertApiTarget(p, path));
});
test('payment protocol requires both confirmations and approved fixture endpoint paths', () => {
  const p = { baseUrl: 'http://localhost:3000', config: configSchema.parse({}) } as Project;
  assert.throws(() => assertPayment(p));
  p.config.reliability.payment.testEnvironmentConfirmed = true; assert.throws(() => assertPayment(p));
  p.config.reliability.payment.fixturesOnlyConfirmed = true; assert.equal(assertPayment(p).kind, 'fixture-http');
  assert.throws(() => assertPayment(p, paymentAdapterSchema.parse({ confirmPath: '/api/charge/{orderId}' })));
  p.config.reliability.payment.adapter.createPath = '/__fixtures/../charge'; assert.throws(() => assertPayment(p));
});
