import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '../../src/bootstrap';
import type { ConsoleSmsProvider } from '../../src/modules/comms/sms-provider';
import { createTenant } from '../../src/modules/platform/tenants';
import { createTestDb, waitFor, type TestDb } from './helpers';

/**
 * The irreducible core, end to end against the real stack (Fastify +
 * Postgres + pg-boss + outbox + stub LLM provider + console SMS provider):
 *
 *   inbound SMS -> AI interpretation -> typed proposal -> owner SMS
 *   -> "YES n" approval -> undo window -> deterministic execution
 *   -> canonical invoice + events -> Stripe payment webhook -> paid.
 */
describe('the loop, end to end', () => {
  let env: TestDb;
  let runtime: Runtime;
  let app: FastifyInstance;
  let sms: ConsoleSmsProvider;
  let tenantId: string;
  let ownerUserId: string;
  const TENANT_PHONE = '+15557770001';
  const OWNER_PHONE = '+15557770099';
  const CUSTOMER_PHONE = '+15557770111';

  beforeAll(async () => {
    env = await createTestDb();
    runtime = await createRuntime({
      databaseUrl: env.databaseUrl,
      databaseAdminUrl: env.databaseAdminUrl,
      undoWindowSeconds: 1,
      env: 'test',
    });
    app = runtime.app;
    sms = runtime.sms as ConsoleSmsProvider;
    const t = await createTenant(env.db, {
      name: 'Loop HVAC',
      phone: TENANT_PHONE,
      owner: { name: 'Loop Owner', phone: OWNER_PHONE },
    });
    tenantId = t.tenantId;
    ownerUserId = t.ownerUserId;
  }, 60_000);

  afterAll(async () => {
    await runtime.shutdown();
    await env.destroy();
  });

  const authed = { 'x-dev-user-id': '' };

  function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      headers: { 'x-dev-user-id': ownerUserId, 'content-type': 'application/json' },
    });
  }

  function inboundSms(from: string, body: string, sid: string) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/twilio/sms',
      payload: new URLSearchParams({ From: from, To: TENANT_PHONE, Body: body, MessageSid: sid }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }

  it('rejects unauthenticated API access', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/proposals' });
    expect(response.statusCode).toBe(401);
  });

  it('runs SMS -> proposal -> YES approval -> executed invoice', async () => {
    authed['x-dev-user-id'] = ownerUserId;

    // Seed the customer the owner will reference.
    const created = await api('POST', '/api/customers', {
      name: 'Sarah Johnson',
      phone: CUSTOMER_PHONE,
    });
    expect(created.statusCode).toBe(201);

    // 1. Owner texts the business number.
    const webhook = await inboundSms(
      OWNER_PHONE,
      'invoice Sarah Johnson $250 for capacitor replacement',
      'SM_loop_1',
    );
    expect(webhook.statusCode).toBe(200);

    // 2. Stub LLM extracts a draft_invoice proposal; owner is notified by SMS.
    const proposal = await waitFor(async () => {
      const response = await api('GET', '/api/proposals?status=ready_for_review');
      const { proposals } = response.json() as { proposals: Array<Record<string, unknown>> };
      return proposals.find((p) => p.type === 'draft_invoice');
    });
    expect(proposal.summary).toContain('Sarah Johnson');
    expect(proposal.confidenceBps).toBeGreaterThan(8_000);

    const notify = await waitFor(async () =>
      sms.sent.find((m) => m.to === OWNER_PHONE && m.body.includes(`YES ${proposal.shortCode}`)),
    );
    expect(notify.body).toContain('reply YES');

    // 3. Owner replies YES n.
    const approval = await inboundSms(OWNER_PHONE, `YES ${proposal.shortCode}`, 'SM_loop_2');
    expect(approval.body).toContain('Approved');

    // 4. After the undo window the executor materializes the invoice.
    const executed = await waitFor(async () => {
      const response = await api('GET', '/api/proposals?status=executed');
      const { proposals } = response.json() as { proposals: Array<Record<string, unknown>> };
      return proposals.find((p) => p.id === proposal.id);
    });
    const result = executed.result as { invoiceId: string; totalCents: number };
    expect(result.totalCents).toBe(25_000);

    const invoice = await api('GET', `/api/invoices/${result.invoiceId}`);
    expect(invoice.statusCode).toBe(200);
    expect(invoice.json()).toMatchObject({
      customerName: 'Sarah Johnson',
      status: 'draft',
      totalCents: 25_000,
    });
  }, 60_000);

  it('outbound provider message ids never collide with the inbound dedup index', async () => {
    // Regression: the dedup index used to constrain outbound rows too, so a
    // provider reusing an external id (e.g. dev provider across restarts)
    // crashed the notify worker after the SMS was already sent.
    const { recordOutboundMessageCommand } = await import('../../src/modules/comms/messages');
    const scope = { tenantId, actor: { type: 'system' as const, id: 'test' } };
    for (const body of ['ping one', 'ping two']) {
      await runtime.bus.execute(recordOutboundMessageCommand, scope, {
        channel: 'sms' as const,
        to: OWNER_PHONE,
        from: TENANT_PHONE,
        body,
        externalId: 'reused-provider-sid',
      });
    }
    const recorded = await env.db.admin.query(
      `SELECT COUNT(*) FROM messages WHERE direction = 'outbound' AND external_id = 'reused-provider-sid'`,
    );
    expect(Number(recorded.rows[0].count)).toBe(2);
  });

  it('redelivered inbound SMS does not duplicate proposals', async () => {
    const before = await api('GET', '/api/proposals');
    const countBefore = (before.json() as { proposals: unknown[] }).proposals.length;
    const redelivery = await inboundSms(
      OWNER_PHONE,
      'invoice Sarah Johnson $250 for capacitor replacement',
      'SM_loop_1',
    );
    expect(redelivery.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const after = await api('GET', '/api/proposals');
    expect((after.json() as { proposals: unknown[] }).proposals.length).toBe(countBefore);
  }, 30_000);

  it('runs voice transcript -> schedule_job proposal -> web approval -> job + appointment', async () => {
    const call = await app.inject({
      method: 'POST',
      url: '/webhooks/voice/completed',
      payload: {
        callId: 'CALL_loop_1',
        to: TENANT_PHONE,
        from: '+15557770222',
        transcript: 'Hi, my AC is broken and the house is heating up, can someone come look at it?',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(call.statusCode).toBe(200);

    const proposal = await waitFor(async () => {
      const response = await api('GET', '/api/proposals?status=ready_for_review');
      const { proposals } = response.json() as { proposals: Array<Record<string, unknown>> };
      return proposals.find((p) => p.type === 'schedule_job');
    });
    expect(proposal.source).toBe('voice');

    const approve = await api('POST', `/api/proposals/${proposal.id}/approve`, {});
    expect(approve.statusCode).toBe(200);

    const executed = await waitFor(async () => {
      const response = await api('GET', '/api/proposals?status=executed');
      const { proposals } = response.json() as { proposals: Array<Record<string, unknown>> };
      return proposals.find((p) => p.id === proposal.id);
    });
    const result = executed.result as { jobId: string; appointmentId: string };

    const jobsList = await api('GET', '/api/jobs');
    const jobs = (jobsList.json() as { jobs: Array<Record<string, unknown>> }).jobs;
    const job = jobs.find((j) => j.id === result.jobId);
    expect(job).toBeDefined();
    expect(job!.status).toBe('scheduled');
  }, 60_000);

  it('NO n rejects a proposal from SMS', async () => {
    await inboundSms(OWNER_PHONE, 'new customer Bob Vance +15557770333', 'SM_loop_3');
    const proposal = await waitFor(async () => {
      const response = await api('GET', '/api/proposals?status=ready_for_review');
      const { proposals } = response.json() as { proposals: Array<Record<string, unknown>> };
      return proposals.find((p) => p.type === 'create_customer');
    });
    const rejection = await inboundSms(OWNER_PHONE, `no ${proposal.shortCode}`, 'SM_loop_4');
    expect(rejection.body).toContain('Rejected');
    const list = await api('GET', '/api/proposals?status=rejected');
    expect(
      (list.json() as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id),
    ).toContain(proposal.id);
  }, 60_000);

  it('records Stripe payment webhooks idempotently and marks the invoice paid', async () => {
    const customers = await api('GET', '/api/customers');
    const customer = (customers.json() as { customers: Array<{ id: string }> }).customers[0]!;
    const invoiceResponse = await api('POST', '/api/invoices', {
      customerId: customer.id,
      lineItems: [{ description: 'Thermostat', quantityHundredths: 100, unitPriceCents: 19_900 }],
      taxRateBps: 0,
    });
    const invoice = invoiceResponse.json() as { id: string; totalCents: number };
    await api('POST', `/api/invoices/${invoice.id}/send`, {});

    const stripeEvent = {
      id: 'evt_loop_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_loop_1',
          amount_received: invoice.totalCents,
          metadata: { tenant_id: tenantId, invoice_id: invoice.id },
        },
      },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: stripeEvent,
      headers: { 'content-type': 'application/json' },
    });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: stripeEvent,
      headers: { 'content-type': 'application/json' },
    });
    expect(duplicate.json()).toMatchObject({ duplicate: true });

    await waitFor(async () => {
      const response = await api('GET', `/api/invoices/${invoice.id}`);
      const body = response.json() as { status: string };
      return body.status === 'paid' ? body : null;
    });

    const summary = await api('GET', '/api/reports/money-summary');
    expect((summary.json() as { paidLast30DaysCents: number }).paidLast30DaysCents).toBeGreaterThanOrEqual(
      invoice.totalCents,
    );
  }, 60_000);

  it('the audit trail covers the whole loop', async () => {
    const response = await api('GET', '/api/events?limit=200');
    const events = (response.json() as { events: Array<{ eventType: string; actorType: string }> }).events;
    const types = new Set(events.map((e) => e.eventType));
    for (const expected of [
      'message.received',
      'proposal.created',
      'proposal.approved',
      'proposal.executed',
      'proposal.rejected',
      'invoice.created',
      'invoice.sent',
      'payment.recorded',
      'invoice.paid',
      'customer.created',
      'job.created',
      'appointment.scheduled',
      'message.sent',
    ]) {
      expect(types).toContain(expected);
    }
    // AI actor never appears on canonical mutations other than proposal creation.
    const aiEvents = events.filter((e) => e.actorType === 'ai');
    expect(aiEvents.every((e) => ['proposal.created', 'ai.intent_unrecognized'].includes(e.eventType))).toBe(true);
  });
});
