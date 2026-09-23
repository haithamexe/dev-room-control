import type { Project } from '../../core/src/index.ts';
import type { StripeEvidence } from '../../core/src/reliability.ts';

/** Fixed Stripe API origin; only explicitly enabled test keys and synthetic methods. */
export async function stripeRequest(project: Project, path: string, fields?: Record<string, string>, request = fetch) {
  const config = project.config.reliability.payment.gateway;
  if (config.provider !== 'stripe-test' || !config.enabled) throw new Error('Enable Stripe test mode explicitly in payment settings');
  const key = process.env[config.secretEnv];
  if (!key || !/^sk_test_[A-Za-z0-9]+$/.test(key)) throw new Error(`Set ${config.secretEnv} to a Stripe test secret key. Live and restricted keys are rejected.`);
  if (!/^\/v1\/payment_intents(?:\/pi_[A-Za-z0-9]+(?:\/confirm)?)?$/.test(path)) throw new Error('Unsupported Stripe test operation');
  const response = await request(`https://api.stripe.com${path}`, { method: fields ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: fields ? new URLSearchParams(fields) : undefined, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Stripe test operation failed (HTTP ${response.status}, ${String(data.error?.code || 'request_error').replace(/[^a-z_]/g, '')})`);
  if (data.livemode !== false || !/^pi_[A-Za-z0-9]+$/.test(data.id)) throw new Error('Stripe response was not a verified test PaymentIntent');
  return { provider: 'stripe-test', paymentIntentId: data.id, state: data.status, amount: data.amount, currency: data.currency } as StripeEvidence;
}
export async function createStripeFixture(project: Project) {
  if (project.config.reliability.payment.gateway.provider === 'fixture') return;
  return stripeRequest(project, '/v1/payment_intents', { amount: '3200', currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never', description: 'Developer Control Room synthetic test fixture' });
}
