/**
 * TEST-07 — app-level HTTP wiring, exercised against the REAL createApp().
 *
 * test/app/wiring.test.ts already pins the pool-ternary wiring via a
 * source-text assertion (booting createApp() there was deliberately
 * avoided — see that file's header comment). This file complements it
 * with an actual route-level boot, mirroring the pattern already used by
 * test/decisions/tenant-isolation.test.ts and test/routes/pack-activation.route.test.ts
 * (createApp() with NODE_ENV=test so no DATABASE_URL is required — the
 * pool stays null and every repo falls back to its InMemory variant).
 *
 * Hermetic: no real Postgres, no real Stripe/Clerk network calls — just
 * the in-process Express app.
 *
 * Covers:
 *   (a) POST /webhooks/stripe with a bad signature → 401 (raw-body
 *       signature verification is actually engaged end-to-end through
 *       the real app.ts mount order, not a hand-rolled express app like
 *       webhook-raw-body-order.route.test.ts uses for SendGrid).
 *   (b) a protected /api route without auth → 401.
 *   (c) malformed JSON to an /api route → 400 (express.json() error
 *       surfaces through app.ts's global error handler / toErrorResponse).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../../src/app';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';

const STRIPE_SECRET = 'whsec_http_wiring_test_secret';

describe('TEST-07 — app.ts HTTP wiring (real createApp())', () => {
  let app: Express;
  let prevNodeEnv: string | undefined;
  let prevStripeSecret: string | undefined;

  beforeAll(() => {
    prevNodeEnv = process.env.NODE_ENV;
    prevStripeSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // NODE_ENV must be non-prod/staging so createApp() doesn't require
    // DATABASE_URL (see app.ts's `pool initialization is gated on
    // DATABASE_URL` wiring, pinned by test/app/wiring.test.ts).
    if (process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'staging') {
      process.env.NODE_ENV = 'test';
    }
    // app.ts reads STRIPE_WEBHOOK_SECRET straight off process.env when
    // building WebhookRouterDeps — set it before createApp() so the
    // /webhooks/stripe route is actually configured (otherwise it 500s
    // "not configured" instead of exercising signature verification).
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;

    app = createApp();
  });

  afterAll(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevStripeSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevStripeSecret;
  });

  describe('(a) POST /webhooks/stripe — raw-body signature verification', () => {
    it('rejects a bad/forged stripe-signature header with 401', async () => {
      const rawBody = JSON.stringify({
        id: 'evt_bad_sig_1',
        type: 'checkout.session.completed',
        data: { object: {} },
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 't=1700000000,v1=deadbeefnotarealsignature')
        .set('content-type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(401);
    });

    it('rejects a missing stripe-signature header with 400', async () => {
      const res = await request(app)
        .post('/webhooks/stripe')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ id: 'evt_no_sig', type: 'checkout.session.completed', data: { object: {} } }));

      expect(res.status).toBe(400);
    });

    it('accepts a correctly-signed, unhandled event type with 200 (proves the raw mount + verifier both work end to end)', async () => {
      // An event type app.ts's router doesn't specifically branch on still
      // passes signature verification and is ACKed — this isolates "does
      // signature verification work through the real app.ts mount order"
      // from "does business logic for a specific event type work" (already
      // covered by the webhooks/*.test.ts suite).
      const rawBody = JSON.stringify({
        id: 'evt_unhandled_type_1',
        type: 'some.unhandled.event.type',
        data: { object: {} },
      });
      const signature = createWebhookSignature(rawBody, STRIPE_SECRET);

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('content-type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true });
    });
  });

  describe('(b) protected /api route without auth', () => {
    it('GET /api/customers without an Authorization header returns 401', async () => {
      const res = await request(app).get('/api/customers');
      expect(res.status).toBe(401);
    });

    it('POST /api/jobs without an Authorization header returns 401 (write path too)', async () => {
      const res = await request(app).post('/api/jobs').send({ summary: 'no auth' });
      expect(res.status).toBe(401);
    });

    it('a garbage bearer token (not a valid JWT) also returns 401, not 500', async () => {
      const res = await request(app)
        .get('/api/customers')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
    });
  });

  describe('(c) malformed JSON to an /api route', () => {
    it('POST /api/customers with unparseable JSON returns 400, not 500', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set('content-type', 'application/json')
        .send('{ this is not valid json');

      expect(res.status).toBe(400);
      // toErrorResponse's body-parser branch — proves express.json()'s
      // SyntaxError reached app.ts's global error handler rather than
      // crashing the process or falling through to the SPA catch-all.
      expect(res.body).toMatchObject({ error: expect.any(String) });
    });

    it('does not leak a stack trace or raw error message for the malformed body', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('content-type', 'application/json')
        .send('{"unterminated":');

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // no stack frame
    });
  });
});
