/**
 * §8.5 row 5.5 — "As J, I want to take a card on the doorstep, so I get paid
 * before I drive away. Given an active Connect account, when I tap to pay,
 * then the charge completes — and without one, a clean 409, never a silent
 * failure."
 *
 * Docker-gated proof at real Postgres of BOTH halves of that row, through the
 * real routes the mobile app calls (`packages/mobile/src/api/terminal.ts`
 * `prepareTerminalCollect` → `POST /api/terminal/connection-token` +
 * `POST /api/terminal/payment-intents`):
 *
 *   (a) THE 409 HALF — a tenant with NO Connect account taps to pay and gets
 *       a clean, coded 409 (`CONNECT_REQUIRED`). Nothing is written: no
 *       payments row, no Stripe call at all, and — pinned as CURRENT
 *       BEHAVIOUR, not as a thing the story asked for — no audit row either.
 *   (b) T1 — tenant B's ACTIVE Connect account (a real `tenants` row) does not
 *       satisfy tenant A's gate, and A's refused attempt leaves B untouched.
 *   (c) THE CHARGE HALF — the connected tenant's Terminal session persists a
 *       real `tenants.stripe_terminal_location_id`, its card_present
 *       PaymentIntent is created against the tenant's own connected account,
 *       and the money lands only when the REAL signed Stripe webhook
 *       (`POST /webhooks/stripe`, HMAC per `invoice-webhook-paid.test.ts`)
 *       delivers `payment_intent.succeeded` for that intent — payments row,
 *       invoice → paid, both audit rows read back through PgAuditRepository.
 *       T1 on this leg too.
 *
 * STUB BOUNDARY — the ONLY thing stubbed is Stripe's own REST API, at the
 * `StripeFetch` seam the route already takes (`deps.stripeFetch`), for the
 * four calls the routes must make to Stripe and cannot make here (no test
 * secret key, no Connect test account — parked on #1000):
 *     GET  https://api.stripe.com/v1/accounts/:id          (business address)
 *     POST https://api.stripe.com/v1/terminal/locations
 *     POST https://api.stripe.com/v1/terminal/connection_tokens
 *     POST https://api.stripe.com/v1/payment_intents       (the card_present PI)
 * Everything else is real: real Postgres, the real `createTerminalRouter`,
 * the real `StripeConnectService` reading/writing the real `tenants` columns,
 * real Pg invoice/payment/audit/webhook repositories, and the real signed
 * `createWebhookRouter` settlement path. No DB is mocked and the webhook is
 * not stubbed. On the 409 leg the stub is asserted to receive ZERO calls.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/stripe-terminal-doorstep.test.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createTerminalRouter } from '../../src/routes/terminal';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { StripeConnectService } from '../../src/billing/stripe-connect';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';
import type { TestTenant } from './shared';

const STRIPE_SECRET = 'whsec_test_terminal_doorstep';
const STRIPE_API_KEY = 'sk_test_doorstep_never_dialled';
const AMOUNT_CENTS = 24_500;

/** One recorded call at the Stripe HTTP boundary. */
interface StripeCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe('Postgres integration — 5.5 doorstep card (Stripe Terminal)', () => {
  let pool: Pool;
  let app: express.Express;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let webhookRepo: PgWebhookRepository;
  let connectService: StripeConnectService;

  /** Tenant A — a normally-provisioned tenant that never finished Connect. */
  let noConnect: TestTenant;
  /** Tenant B (otherTenant) — Connect live, charges enabled: neighbour, then payer. */
  let connected: TestTenant;

  let stripeCalls: StripeCall[] = [];
  /** Who the next request is authenticated as. */
  let actingTenant: TestTenant;

  const CONNECT_ACCOUNT_ID = 'acct_doorstep_tenant_b';
  const CREATED_LOCATION_ID = 'tml_doorstep_created';

  /**
   * The ONLY stub in this file: Stripe's REST API. Records every call so the
   * 409 leg can prove the gate closes BEFORE Stripe is ever dialled.
   *
   * FAILS CLOSED (xhawk-ai review, PR #1097): it matches method AND exact URL
   * for the four calls named in the file header, and throws on anything else.
   * An earlier cut fell through to a successful PaymentIntent for every
   * unmatched URL, which would have masked a fifth Stripe call or a wrong
   * endpoint while the report claimed the boundary was exactly those four —
   * the stub would have been quietly widening the very claim it backs.
   */
  const stripeFetch: StripeFetch = async (url, init) => {
    stripeCalls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    });
    if (url.includes('/v1/accounts/')) {
    const method = (init.method ?? '').toUpperCase();

    if (method === 'GET' && /^https:\/\/api\.stripe\.com\/v1\/accounts\/[^/?]+$/.test(url)) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          company: {
            address: {
              line1: '19 Doorstep Way',
              city: 'Austin',
              state: 'TX',
              postal_code: '78701',
              country: 'US',
            },
          },
        }),
      };
    }
    if (url.includes('/v1/terminal/locations')) {
    if (method === 'POST' && url === 'https://api.stripe.com/v1/terminal/locations') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: CREATED_LOCATION_ID }),
      };
    }
    if (url.includes('/v1/terminal/connection_tokens')) {
    if (method === 'POST' && url === 'https://api.stripe.com/v1/terminal/connection_tokens') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ secret: 'pst_doorstep_secret' }),
      };
    }
    if (method === 'POST' && url === 'https://api.stripe.com/v1/payment_intents') {
      const params = new URLSearchParams(String(init.body ?? ''));
      const id = `pi_term_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          id,
          client_secret: `${id}_secret_test`,
          amount: Number(params.get('amount')),
          currency: params.get('currency'),
          payment_method_types: ['card_present'],
        }),
      };
    }

    throw new Error(
      `Unstubbed Stripe call: ${method} ${url}. The stub boundary in this file is ` +
        'exactly four calls (see the header); a fifth means the route changed and ' +
        'the boundary claim in docs/audit/lane-reports/execute-8-5-terminal.md ' +
        'must be re-stated, not silently widened.',
    );
  };

  async function seedOpenInvoice(t: TestTenant): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Door',
      lastName: 'Step',
      displayName: 'Door Step',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '19 Doorstep Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: '5.5 doorstep card proof',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service call', 1, AMOUNT_CENTS, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  /** Every audit row a tenant has, by raw SQL — nothing is filtered out. */
  async function allAuditEventTypes(tenantId: string): Promise<string[]> {
    const { rows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map((r) => r.event_type);
  }

  async function countPayments(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n;
  }

  async function postSignedStripe(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  function terminalSucceededEvent(
    eventId: string,
    paymentIntentId: string,
    tenantId: string,
    invoiceId: string,
  ): Record<string, unknown> {
    // Shape of a Terminal (card_present) capture on a Connect direct charge:
    // delivered from the "Connected accounts" destination with a top-level
    // `account`, and `payment_method_details.type === 'card_present'`.
    return {
      id: eventId,
      type: 'payment_intent.succeeded',
      account: CONNECT_ACCOUNT_ID,
      data: {
        object: {
          id: paymentIntentId,
          amount: AMOUNT_CENTS,
          amount_received: AMOUNT_CENTS,
          payment_method_types: ['card_present'],
          metadata: {
            tenant_id: tenantId,
            invoice_id: invoiceId,
            collection: 'terminal',
          },
          charges: {
            data: [{ payment_method_details: { type: 'card_present' } }],
          },
        },
      },
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    webhookRepo = new PgWebhookRepository(pool);
    connectService = new StripeConnectService({
      pool,
      config: { apiKey: STRIPE_API_KEY },
    });

    noConnect = await createTestTenant(pool);
    connected = await createTestTenant(pool);
    actingTenant = noConnect;

    // Tenant B finishes Connect for real — the same columns
    // `StripeConnectService.applyAccountUpdated` writes from `account.updated`.
    await pool.query(
      `UPDATE tenants
          SET stripe_connect_account_id = $2,
              stripe_connect_charges_enabled = TRUE,
              stripe_connect_payouts_enabled = TRUE,
              stripe_connect_status = 'active'
        WHERE id = $1`,
      [connected.tenantId, CONNECT_ACCOUNT_ID],
    );

    app = express();
    // The webhook body must stay raw for HMAC verification; mounted first.
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: actingTenant.userId,
        sessionId: `sess_${actingTenant.userId}`,
        tenantId: actingTenant.tenantId,
        role: 'owner',
      };
      next();
    });

    // The REAL terminal router, wired exactly as app.ts:5122 wires it —
    // the production `connectAccountResolver` shape over the real
    // StripeConnectService, and the real Pg invoice + audit repositories.
    app.use(
      '/api/terminal',
      createTerminalRouter({
        invoiceRepo,
        auditRepo,
        stripeApiKey: STRIPE_API_KEY,
        stripeFetch,
        connectAccountResolver: {
          resolveTenantConnectAccount: async (tenantId: string) => {
            const view = await connectService.getAccount(tenantId);
            if (!view.accountId) return null;
            return { accountId: view.accountId, chargesEnabled: view.chargesEnabled };
          },
        },
        terminalLocation: {
          getExistingLocationId: async (tenantId) =>
            (await connectService.getAccount(tenantId)).terminalLocationId,
          persistLocationId: (tenantId, locationId) =>
            connectService.setTerminalLocationId(tenantId, locationId),
          resolveDisplayName: async (tenantId) => {
            const { rows } = await pool.query<{ name: string }>(
              `SELECT name FROM tenants WHERE id = $1`,
              [tenantId],
            );
            return rows[0]?.name?.trim() || 'Field location';
          },
        },
      }),
    );

    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        webhookRepo,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(() => {
    stripeCalls = [];
  });

  // ───────────────────────── (a) THE 409 HALF ─────────────────────────

  it('no Connect account: tap-to-pay is refused with a clean coded 409 and writes nothing', async () => {
    actingTenant = noConnect;
    const invoiceId = await seedOpenInvoice(noConnect);
    const auditBefore = await allAuditEventTypes(noConnect.tenantId);

    const res = await request(app)
      .post('/api/terminal/payment-intents')
      .send({ invoiceId });

    // A clean 409 with the documented code — not a 500, not a 200 with a
    // null body, not a silent success.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONNECT_REQUIRED');
    expect(res.body.message).toBe(
      'Enable Stripe Connect payouts before collecting card-present payments',
    );

    // Stripe was never dialled — the gate closes before the network.
    expect(stripeCalls).toEqual([]);

    // No money row at real Postgres. (There is no `payment_intents` table in
    // this schema — the card_present intent lives only at Stripe until the
    // webhook settles it — so "no payment_intents row" is proven as "no
    // intent was ever created", i.e. the zero Stripe calls asserted above.)
    expect(await countPayments(noConnect.tenantId)).toBe(0);
    expect(await paymentRepo.findByInvoice(noConnect.tenantId, invoiceId)).toHaveLength(0);

    // The invoice is untouched.
    const invoice = await invoiceRepo.findById(noConnect.tenantId, invoiceId);
    expect(invoice?.status).toBe('open');
    expect(invoice?.amountDueCents).toBe(AMOUNT_CENTS);
    expect(invoice?.amountPaidCents).toBe(0);

    // FINDING (pinned, not invented): the refusal writes NO audit row. The
    // route's only audit write is `terminal.payment_intent_created`, after
    // the gate (routes/terminal.ts:183). A refused doorstep charge leaves no
    // trace on the tenant's timeline. This asserts today's behaviour so a
    // change to it is visible; it is reported as a gap, not as a pass.
    expect(await allAuditEventTypes(noConnect.tenantId)).toEqual(auditBefore);
    expect(
      await auditRepo.findByEntity(noConnect.tenantId, 'invoice', invoiceId),
    ).toEqual([]);
  });

  it('no Connect account: minting a connection token is refused the same way, writing nothing', async () => {
    actingTenant = noConnect;
    const auditBefore = await allAuditEventTypes(noConnect.tenantId);

    const res = await request(app).post('/api/terminal/connection-token').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONNECT_REQUIRED');
    expect(stripeCalls).toEqual([]);
    expect(await allAuditEventTypes(noConnect.tenantId)).toEqual(auditBefore);

    // Nothing was persisted onto the tenant row either.
    const view = await connectService.getAccount(noConnect.tenantId);
    expect(view.accountId).toBeNull();
    expect(view.terminalLocationId).toBeNull();
  });

  // ───────────────── (b) T1 on the gate ─────────────────

  it("T1 cross-tenant: another tenant's active Connect account does not satisfy tenant A's gate", async () => {
    // Sanity: B really is live at real Postgres.
    const bBefore = await connectService.getAccount(connected.tenantId);
    expect(bBefore.accountId).toBe(CONNECT_ACCOUNT_ID);
    expect(bBefore.chargesEnabled).toBe(true);

    const bInvoiceId = await seedOpenInvoice(connected);
    const bAuditBefore = await allAuditEventTypes(connected.tenantId);
    const bPaymentsBefore = await countPayments(connected.tenantId);

    // Tenant A taps to pay — against its OWN invoice, and against tenant B's
    // invoice id. Neither may borrow B's account.
    actingTenant = noConnect;
    const aInvoiceId = await seedOpenInvoice(noConnect);

    const own = await request(app).post('/api/terminal/payment-intents').send({
      invoiceId: aInvoiceId,
    });
    expect(own.status).toBe(409);
    expect(own.body.error).toBe('CONNECT_REQUIRED');

    const borrowed = await request(app).post('/api/terminal/payment-intents').send({
      invoiceId: bInvoiceId,
    });
    // The Connect gate runs before the invoice lookup, so this is the same
    // clean 409 — and never a 200 charging B's account for A.
    expect(borrowed.status).toBe(409);
    expect(borrowed.body.error).toBe('CONNECT_REQUIRED');

    expect(stripeCalls).toEqual([]);

    // Cross-tenant: another tenant's rows are byte-for-byte unchanged.
    const bAfter = await connectService.getAccount(connected.tenantId);
    expect(bAfter).toEqual(bBefore);
    expect(await countPayments(connected.tenantId)).toBe(bPaymentsBefore);
    expect(await allAuditEventTypes(connected.tenantId)).toEqual(bAuditBefore);
    const bInvoice = await invoiceRepo.findById(connected.tenantId, bInvoiceId);
    expect(bInvoice?.status).toBe('open');
    expect(bInvoice?.amountPaidCents).toBe(0);

    // And tenant A cannot read B's invoice at all.
    expect(await invoiceRepo.findById(noConnect.tenantId, bInvoiceId)).toBeNull();
  });

  // ─────────────── (c) THE CHARGE HALF — settlement ───────────────

  it('connected tenant: the Terminal session persists a real location id + audit row', async () => {
    actingTenant = connected;

    const res = await request(app).post('/api/terminal/connection-token').send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('pst_doorstep_secret');
    expect(res.body.locationId).toBe(CREATED_LOCATION_ID);
    expect(res.body.stripeAccountId).toBe(CONNECT_ACCOUNT_ID);

    // Every Stripe call was scoped to the tenant's OWN connected account.
    expect(stripeCalls.length).toBeGreaterThan(0);
    for (const call of stripeCalls) {
      if (call.url.includes('/v1/accounts/')) continue; // platform-level read
      expect(call.headers['Stripe-Account']).toBe(CONNECT_ACCOUNT_ID);
    }

    // The location id landed on the REAL tenants row, read back through the
    // real StripeConnectService.
    const view = await connectService.getAccount(connected.tenantId);
    expect(view.terminalLocationId).toBe(CREATED_LOCATION_ID);
    const { rows } = await pool.query<{ stripe_terminal_location_id: string | null }>(
      `SELECT stripe_terminal_location_id FROM tenants WHERE id = $1`,
      [connected.tenantId],
    );
    expect(rows[0].stripe_terminal_location_id).toBe(CREATED_LOCATION_ID);

    // …and the audit row for it is at real Postgres.
    const events = await auditRepo.findByEntity(
      connected.tenantId,
      'tenant',
      connected.tenantId,
    );
    const minted = events.filter((e) => e.eventType === 'terminal.connection_token_minted');
    expect(minted).toHaveLength(1);
    expect(minted[0].metadata!.stripeAccountId).toBe(CONNECT_ACCOUNT_ID);
    expect(minted[0].metadata!.locationId).toBe(CREATED_LOCATION_ID);
    expect(minted[0].metadata!.locationCreated).toBe(true);

    // T1 — tenant A gained nothing from B's session.
    expect((await connectService.getAccount(noConnect.tenantId)).terminalLocationId).toBeNull();
    expect(
      await auditRepo.findByEntity(noConnect.tenantId, 'tenant', connected.tenantId),
    ).toEqual([]);
  });

  it('connected tenant: card_present intent → signed webhook settles the invoice at real Postgres', async () => {
    actingTenant = connected;
    const invoiceId = await seedOpenInvoice(connected);

    // 1. Tap to pay — the real route creates the card_present intent.
    const res = await request(app).post('/api/terminal/payment-intents').send({ invoiceId });
    expect(res.status).toBe(200);
    const paymentIntentId = res.body.paymentIntentId as string;
    expect(paymentIntentId).toMatch(/^pi_term_/);
    expect(res.body.amountCents).toBe(AMOUNT_CENTS);
    expect(res.body.stripeAccountId).toBe(CONNECT_ACCOUNT_ID);

    // The intent Stripe was asked for is card_present, server-priced from the
    // invoice balance, on the tenant's own account.
    const intentCall = stripeCalls.find((c) => c.url.endsWith('/v1/payment_intents'));
    expect(intentCall).toBeDefined();
    const sent = new URLSearchParams(intentCall!.body);
    expect(sent.get('payment_method_types[]')).toBe('card_present');
    expect(sent.get('amount')).toBe(String(AMOUNT_CENTS));
    expect(sent.get('metadata[tenant_id]')).toBe(connected.tenantId);
    expect(sent.get('metadata[invoice_id]')).toBe(invoiceId);
    expect(sent.get('metadata[collection]')).toBe('terminal');
    expect(intentCall!.headers['Stripe-Account']).toBe(CONNECT_ACCOUNT_ID);
    expect(intentCall!.headers['Idempotency-Key']).toBe(
      `term_pi_inv_${invoiceId}_${AMOUNT_CENTS}_${CONNECT_ACCOUNT_ID}`,
    );

    // The intent audit row is at real Postgres…
    const created = (
      await auditRepo.findByEntity(connected.tenantId, 'invoice', invoiceId)
    ).filter((e) => e.eventType === 'terminal.payment_intent_created');
    expect(created).toHaveLength(1);
    expect(created[0].metadata!.paymentIntentId).toBe(paymentIntentId);
    expect(created[0].metadata!.amountCents).toBe(AMOUNT_CENTS);

    // …but NO money has moved yet. Creating an intent is not a payment.
    expect(await paymentRepo.findByInvoice(connected.tenantId, invoiceId)).toHaveLength(0);
    expect((await invoiceRepo.findById(connected.tenantId, invoiceId))?.status).toBe('open');

    // 2. The card is presented on the doorstep; Stripe settles it and sends
    //    the REAL signed webhook.
    const eventId = `evt_${randomUUID()}`;
    const settled = await postSignedStripe(
      terminalSucceededEvent(eventId, paymentIntentId, connected.tenantId, invoiceId),
    );
    expect(settled.status).toBe(200);
    expect(settled.body).toEqual({ received: true });

    // The charge completed: payments row, invoice paid, at real Postgres.
    const payments = await paymentRepo.findByInvoice(connected.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].providerReference).toBe(paymentIntentId);
    // NOTE: the webhook's method mapper has no card_present branch — a
    // doorstep tap lands as `credit_card`, the same as an online card
    // (webhooks/routes.ts:77 mapStripePaymentMethod). Pinned as-is.
    expect(payments[0].method).toBe('credit_card');

    const paid = await invoiceRepo.findById(connected.tenantId, invoiceId);
    expect(paid?.status).toBe('paid');
    expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(paid?.amountDueCents).toBe(0);

    // Both audit rows, read back through the real PgAuditRepository.
    const events = await auditRepo.findByEntity(connected.tenantId, 'invoice', invoiceId);
    const recorded = events.filter((e) => e.eventType === 'payment.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].metadata!.amountCents).toBe(AMOUNT_CENTS);
    expect(recorded[0].metadata!.paymentId).toBe(payments[0].id);
    expect(recorded[0].correlationId).toBe(paymentIntentId);
    const statusChanges = events.filter((e) => e.eventType === 'invoice.status_changed');
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].metadata!.oldStatus).toBe('open');
    expect(statusChanges[0].metadata!.newStatus).toBe('paid');

    // The durable idempotency row exists, and a redelivery cannot double-credit
    // the doorstep charge.
    expect((await webhookRepo.findByIdempotencyKey('stripe', eventId))?.status).toBe('processed');
    const replay = await postSignedStripe(
      terminalSucceededEvent(eventId, paymentIntentId, connected.tenantId, invoiceId),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    expect(await paymentRepo.findByInvoice(connected.tenantId, invoiceId)).toHaveLength(1);
    expect(
      (await auditRepo.findByEntity(connected.tenantId, 'invoice', invoiceId)).filter(
        (e) => e.eventType === 'payment.recorded',
      ),
    ).toHaveLength(1);
  });

  it('an UNSIGNED delivery of the same terminal capture credits nothing', async () => {
    actingTenant = connected;
    const invoiceId = await seedOpenInvoice(connected);

    const res = await request(app).post('/api/terminal/payment-intents').send({ invoiceId });
    expect(res.status).toBe(200);
    const paymentIntentId = res.body.paymentIntentId as string;

    // Same body, no HMAC. Only the real signed path may move money.
    const raw = JSON.stringify(
      terminalSucceededEvent(`evt_${randomUUID()}`, paymentIntentId, connected.tenantId, invoiceId),
    );
    const unsigned = await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(raw);
    expect(unsigned.status).toBe(400);

    expect(await paymentRepo.findByInvoice(connected.tenantId, invoiceId)).toHaveLength(0);
    expect((await invoiceRepo.findById(connected.tenantId, invoiceId))?.status).toBe('open');
    expect(
      (await auditRepo.findByEntity(connected.tenantId, 'invoice', invoiceId)).filter(
        (e) => e.eventType === 'payment.recorded',
      ),
    ).toHaveLength(0);
  });

  it('T1 cross-tenant on settlement: a terminal intent naming another tenant credits nothing', async () => {
    actingTenant = connected;
    const invoiceId = await seedOpenInvoice(connected);

    const res = await request(app).post('/api/terminal/payment-intents').send({ invoiceId });
    expect(res.status).toBe(200);
    const paymentIntentId = res.body.paymentIntentId as string;

    const neighbourPaymentsBefore = await countPayments(noConnect.tenantId);

    // The same terminal capture, but its metadata names the NEIGHBOUR tenant
    // alongside this tenant's invoice — the tenant-scoped read finds no such
    // invoice, so nothing is credited anywhere.
    const crossEventId = `evt_${randomUUID()}`;
    const cross = await postSignedStripe(
      terminalSucceededEvent(crossEventId, paymentIntentId, noConnect.tenantId, invoiceId),
    );
    // 500 is TODAY'S behaviour, pinned as an observation, not endorsed: the
    // handler throws 'Invoice not found', so the delivery is not ACKed and
    // Stripe retries an event that can never succeed. The same shape is
    // already pinned for the online path at invoice-webhook-paid.test.ts:320.
    // Raised by xhawk-ai on PR #1097, and it has a point — a 200-with-skipped
    // would be kinder to the retry queue — but changing it is a money-surface
    // webhook change this test-only lane is barred from making, so the row's
    // real invariant is asserted independently of the status code below:
    // whatever the response, NOTHING is credited to either tenant.
    expect(cross.status).toBe(500);

    const untouched = await invoiceRepo.findById(connected.tenantId, invoiceId);
    expect(untouched?.status).toBe('open');
    expect(untouched?.amountPaidCents).toBe(0);
    expect(await paymentRepo.findByInvoice(connected.tenantId, invoiceId)).toHaveLength(0);
    expect(await countPayments(noConnect.tenantId)).toBe(neighbourPaymentsBefore);
    expect(
      await auditRepo.findByEntity(noConnect.tenantId, 'invoice', invoiceId),
    ).toEqual([]);

    // The tenant's own event still settles its own invoice.
    const ownEventId = `evt_${randomUUID()}`;
    const own = await postSignedStripe(
      terminalSucceededEvent(ownEventId, paymentIntentId, connected.tenantId, invoiceId),
    );
    expect(own.status).toBe(200);
    expect((await invoiceRepo.findById(connected.tenantId, invoiceId))?.status).toBe('paid');
    expect(await paymentRepo.findByInvoice(connected.tenantId, invoiceId)).toHaveLength(1);
    // …and the neighbour still sees none of it.
    expect(await countPayments(noConnect.tenantId)).toBe(neighbourPaymentsBefore);
    expect(
      await auditRepo.findByEntity(noConnect.tenantId, 'invoice', invoiceId),
    ).toEqual([]);
  });

  // ───────────── PRODUCT DEFECT — pinned, not fixed here ─────────────
  //
  // Raised by Codex on PR #1097 and verified against source. The leg above is
  // the WEAK cross-tenant case: it pairs one tenant's id with another's
  // invoice, which the tenant-scoped lookup rejects for free. The case that
  // matters is a *consistent* pair — the victim's own tenant_id AND the
  // victim's own invoice_id — arriving on a connected-account event whose
  // `event.account` belongs to SOMEBODY ELSE.
  //
  // `webhooks/routes.ts:1519` reads `pi.metadata.tenant_id` / `.invoice_id`
  // and nothing else: `event.account` is never compared against the tenant's
  // own `tenants.stripe_connect_account_id`. (The only `event.account` read in
  // the file, `:1095`, is the payment_method.attached branch.) Stripe signs
  // the delivery with OUR platform webhook secret, so the signature check
  // passes — it attests that Stripe sent it, not whose account earned it.
  //
  // Consequence: any tenant with a connected account on this platform can
  // create a card_present (or any) PaymentIntent on their OWN account carrying
  // a neighbour's tenant_id + invoice_id in metadata. Stripe delivers a
  // genuine, correctly-signed `payment_intent.succeeded`, and this handler
  // marks the neighbour's invoice PAID while the money sits in the attacker's
  // Stripe balance. The victim below never even enabled Connect.
  //
  // `it.fails` per the repo convention (cf. i3-voice-approval-challenge-lock,
  // #1051): the assertions are what the product SHOULD do, so this goes green
  // by itself the day the handler validates the account. Not fixed in this
  // lane — `webhooks/routes.ts` is money code and out of its scope. Surfaced
  // on the PR and in docs/audit/lane-reports/execute-8-5-terminal.md.
  it.fails(
    'PRODUCT DEFECT: a connected account can settle ANOTHER tenant\'s invoice — event.account is never validated',
    async () => {
      // The victim is the tenant that never enabled Connect at all.
      const victimInvoiceId = await seedOpenInvoice(noConnect);
      expect((await connectService.getAccount(noConnect.tenantId)).accountId).toBeNull();

      // A capture on the OTHER tenant's connected account, whose metadata
      // names the victim's own tenant and the victim's own invoice.
      const eventId = `evt_${randomUUID()}`;
      const attackerIntentId = `pi_term_attacker_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const event = terminalSucceededEvent(
        eventId,
        attackerIntentId,
        noConnect.tenantId,
        victimInvoiceId,
      );
      expect((event as { account: string }).account).toBe(CONNECT_ACCOUNT_ID);

      await postSignedStripe(event);

      // WHAT SHOULD HAPPEN — the event is refused or skipped and nothing moves.
      // WHAT HAPPENS TODAY — the invoice is 'paid' and a payments row exists.
      const victimInvoice = await invoiceRepo.findById(noConnect.tenantId, victimInvoiceId);
      expect(victimInvoice?.status).toBe('open');
      expect(victimInvoice?.amountPaidCents).toBe(0);
      expect(
        await paymentRepo.findByInvoice(noConnect.tenantId, victimInvoiceId),
      ).toHaveLength(0);
    },
  );
});
