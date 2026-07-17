/**
 * Multiple Stripe webhook signing secrets (Codex P1, PR #698).
 *
 * Full Connect coverage needs two Stripe endpoints — one platform-scoped
 * (SaaS subscriptions, platform account.updated) and one connected-accounts-
 * scoped (the customer payment events that settle invoices as direct charges).
 * Stripe issues a DISTINCT signing secret per endpoint, so verifying against a
 * single secret would 401 every event from the other endpoint (silently
 * breaking either settlement or SaaS billing). `STRIPE_WEBHOOK_SECRET` therefore
 * accepts a COMMA-SEPARATED list; a single value behaves exactly as before.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';

import { createWebhookRouter, type WebhookRouterDeps } from '../../src/webhooks/routes';
import {
  createWebhookSignature,
  parseWebhookSecrets,
  verifyWebhookSignatureAny,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';

const PLATFORM_SECRET = 'whsec_platform_endpoint';
const CONNECTED_SECRET = 'whsec_connected_endpoint';
const WRONG_SECRET = 'whsec_not_configured';

describe('parseWebhookSecrets', () => {
  it('returns [] for undefined / empty / whitespace', () => {
    expect(parseWebhookSecrets(undefined)).toEqual([]);
    expect(parseWebhookSecrets('')).toEqual([]);
    expect(parseWebhookSecrets('   ')).toEqual([]);
    expect(parseWebhookSecrets(',, ,')).toEqual([]);
  });

  it('parses a single secret (back-compat)', () => {
    expect(parseWebhookSecrets('whsec_a')).toEqual(['whsec_a']);
  });

  it('splits a comma-separated list and trims + drops blanks', () => {
    expect(parseWebhookSecrets('whsec_a, whsec_b ,,whsec_c')).toEqual([
      'whsec_a',
      'whsec_b',
      'whsec_c',
    ]);
  });
});

describe('verifyWebhookSignatureAny', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'ping' });

  it('verifies when the signature matches ANY configured secret', () => {
    const sig = createWebhookSignature(payload, CONNECTED_SECRET);
    expect(verifyWebhookSignatureAny(payload, sig, [PLATFORM_SECRET, CONNECTED_SECRET])).toBe(true);
    expect(verifyWebhookSignatureAny(payload, sig, [CONNECTED_SECRET, PLATFORM_SECRET])).toBe(true);
  });

  it('rejects when the signature matches NONE of the secrets', () => {
    const sig = createWebhookSignature(payload, WRONG_SECRET);
    expect(verifyWebhookSignatureAny(payload, sig, [PLATFORM_SECRET, CONNECTED_SECRET])).toBe(false);
  });

  it('an empty secret list can never verify', () => {
    const sig = createWebhookSignature(payload, PLATFORM_SECRET);
    expect(verifyWebhookSignatureAny(payload, sig, [])).toBe(false);
  });
});

describe('POST /webhooks/stripe — multi-secret signature verification', () => {
  function buildApp(secretEnv: string): express.Express {
    const deps: WebhookRouterDeps = {
      webhookRepo: new InMemoryWebhookRepository(),
      stripeWebhookSecret: secretEnv,
    };
    const app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use('/webhooks', createWebhookRouter({} as never, deps));
    return app;
  }

  async function postSignedWith(app: express.Express, eventId: string, secret: string) {
    const raw = JSON.stringify({ id: eventId, type: 'ping', data: { object: {} } });
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, secret))
      .set('content-type', 'application/json')
      .send(raw);
  }

  it('accepts events signed by EITHER of the two configured endpoint secrets', async () => {
    const app = buildApp(`${PLATFORM_SECRET},${CONNECTED_SECRET}`);

    const platform = await postSignedWith(app, 'evt_platform', PLATFORM_SECRET);
    expect(platform.status).toBe(200);
    expect(platform.body).toEqual({ received: true });

    const connected = await postSignedWith(app, 'evt_connected', CONNECTED_SECRET);
    expect(connected.status).toBe(200);
    expect(connected.body).toEqual({ received: true });
  });

  it('still rejects an event signed with a secret that is not configured', async () => {
    const app = buildApp(`${PLATFORM_SECRET},${CONNECTED_SECRET}`);
    const res = await postSignedWith(app, 'evt_wrong', WRONG_SECRET);
    expect(res.status).toBe(401);
  });

  it('single-secret configuration is unchanged (back-compat)', async () => {
    const app = buildApp(PLATFORM_SECRET);

    const ok = await postSignedWith(app, 'evt_single_ok', PLATFORM_SECRET);
    expect(ok.status).toBe(200);

    const bad = await postSignedWith(app, 'evt_single_bad', CONNECTED_SECRET);
    expect(bad.status).toBe(401);
  });

  it('rejects when no secret is configured at all (500, unchanged)', async () => {
    const app = buildApp('');
    const res = await postSignedWith(app, 'evt_none', PLATFORM_SECRET);
    expect(res.status).toBe(500);
  });
});
