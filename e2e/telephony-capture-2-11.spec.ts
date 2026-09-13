/**
 * #1014 §8.2 row 2.11 — "As M, I want the AI to refuse to quote a firm
 * price or haggle, so it never commits me to a number I'd lose money on."
 * Acceptance: given a price-pressure turn, when the guardrail fires, then
 * it speaks the holding line, mints exactly one owner callback, stays in
 * state, and is idempotent when already flagged.
 *
 * SMS-surface reachability leg (lane C, test/8-2-capture-r5) — the REFUSE
 * branch (#1014's row; the ALLOW branch is row 7.12, proven separately).
 * Driven through the real `/webhooks/twilio/sms/:tenantId` route — the
 * inbound-SMS surface is where this guardrail actually lives
 * (`createInboundNegotiationHandler`, sms/negotiation/inbound-negotiation
 * -handler.ts; wired in app.ts:3339 as the LAST-registered SMS handler,
 * "only fires on a customer negotiation ask no other handler claimed").
 *
 * NO LLM ANYWHERE ON THIS PATH — verified by reading the source, not
 * assumed:
 *   - `parseDiscountTarget` (conversations/negotiation/target-price-parser
 *     .ts) is a "Deterministic target-price parser" — pure regex, no I/O.
 *   - `evaluateDiscountAsk`/`evaluateNegotiationDiscount`
 *     (proposals/guardrails/negotiation-guardrail.ts) is "the pure
 *     money-correctness core" — a floor/max-bps comparison, no model call.
 *   - Customer resolution is `customerRepo.findByPhoneNormalized` (app.ts's
 *     `evaluateNegotiationDiscountForPhone`) — exact E.164 lookup, fails
 *     closed (null) unless EXACTLY one match.
 * So, unlike rows 2.6/2.4's classification-dependent legs, this row's
 * REFUSE branch is fully, deterministically reachable with no
 * `test.fail()` pin.
 *
 * Setup mirrors the vitest integration proof
 * (`negotiation-guardrail.test.ts`'s REFUSE describe block) but through
 * real routes: `discountFloorCents: 6000` / `discountMaxBps: 5000` via the
 * real `PUT /api/settings/`, a real customer + location + job + a $100.00
 * `POST /api/estimates` + `POST /api/estimates/:id/send` (status 'sent' —
 * `DefaultCurrentQuoteResolver` reads the customer's current SENT
 * estimate), then a signed inbound SMS asking for $50 off — $50.00 off a
 * $100.00 quote lands at $50.00, BELOW the $60.00 floor.
 *
 * Proof: a `callback` proposal (never auto-executed, `status:'draft'`)
 * whose `recommendation` counters AT THE FLOOR ($60) and never quotes the
 * customer's $50 ask; `negotiation_guardrail.sms_routed` audited
 * (entityType `sms_message`, entityId = the inbound MessageSid,
 * `metadata.askType:'discount'`).
 *
 * T1: tenant B's own (looser/unconfigured) discount policy never governs
 * tenant A's counter price for the identical $50-off ask on an identical
 * $100 quote.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedSmsPost,
  API_URL,
  devAuthBearerToken,
  createCustomerViaApi,
  createLocationViaApi,
  createScheduledJobViaApi,
  insertTechnician,
  laterTodaySlots,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}111`;
const B_DID = `+1512${RUN}112`;
const A_SUBACCOUNT = 'AC1014c11aaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c11bbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c11-111';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c11-111';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.11 — the negotiation guardrail refuses a below-floor discount and routes the owner a counter (SMS surface, T1)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY.',
  );

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `DELETE FROM tenant_integrations WHERE provider = 'twilio' AND provider_data->>'phoneE164' = ANY($1)`,
      [[A_DID, B_DID]],
    );
    tenantA = await provisionTenant(pool, enc, { did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN });
    tenantB = await provisionTenant(pool, enc, { did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN });

    // Tenant A: real discount policy — $60 absolute floor, 50% max.
    const putA = await fetch(`${API_URL}/api/settings/`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${devAuthBearerToken(tenantA.userId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ discountMaxBps: 5000, discountFloorCents: 6000, discountNeverBelowCatalog: false }),
    });
    expect(putA.status, await putA.text()).toBe(200);

    // Tenant B: a materially DIFFERENT (much lower) floor — its own $50 ask
    // on its own identical $100 quote ALLOWS, so its policy can never be
    // mistaken for tenant A's REFUSE outcome.
    const putB = await fetch(`${API_URL}/api/settings/`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${devAuthBearerToken(tenantB.userId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ discountMaxBps: 5000, discountFloorCents: 1000, discountNeverBelowCatalog: false }),
    });
    expect(putB.status, await putB.text()).toBe(200);
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  /** Customer + location + job + a $100.00 SENT estimate, all through the
   *  real, authenticated HTTP API. Returns the customer's phone (the SMS
   *  sender identity the guardrail resolves against) and the estimate id. */
  async function seedSentHundredDollarEstimate(
    request: import('@playwright/test').APIRequestContext,
    tenant: ProvisionedTenant,
    phone: string,
  ): Promise<{ customerId: string; estimateId: string }> {
    const owner = devAuthBearerToken(tenant.userId);
    const customer = await createCustomerViaApi(request, owner, {
      firstName: 'Neg',
      lastName: 'Otiator',
      primaryPhone: phone,
    });
    const location = await createLocationViaApi(request, owner, customer.id);
    const tech = await insertTechnician(pool, tenant.tenantId, {
      mobile: `+1512${RUN}${Math.floor(Math.random() * 900 + 100)}`,
      firstName: 'Tech',
      lastName: 'One',
    });
    const [slot] = laterTodaySlots('America/Chicago', 1, 90);
    const job = await createScheduledJobViaApi(request, owner, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Negotiation guardrail fixture job',
      technicianId: tech.id,
      scheduledStart: slot!,
      timezone: 'America/Chicago',
    });

    const estimateRes = await request.post(`${API_URL}/api/estimates`, {
      headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
      data: {
        jobId: job.id,
        lineItems: [
          {
            id: crypto.randomUUID(),
            description: 'Service call',
            quantity: 1,
            unitPriceCents: 10000,
            totalCents: 10000,
            sortOrder: 0,
            taxable: false,
            // isEstimateCatalogGrounded (estimates/estimate.ts:261) requires
            // every priced line to carry pricingSource 'catalog' OR 'manual' —
            // without it (the default for a bare API-posted line item) the
            // estimate is UNGROUNDED and the discount evaluator's floor can't
            // be trusted, landing on NEEDS_APPROVAL instead of
            // REJECT_WITH_COUNTER (verified directly: an earlier run of this
            // spec without this field produced decisionKind NEEDS_APPROVAL).
            // A human owner typing this price via the real API is exactly
            // the 'manual' case — not a test-only shortcut.
            pricingSource: 'manual',
          },
        ],
      },
    });
    expect(estimateRes.status(), `POST /api/estimates failed: ${await estimateRes.text()}`).toBe(201);
    const estimate = (await estimateRes.json()) as { id: string };

    const sendRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/send`, {
      headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
      // The fixture customer carries a phone + smsConsent but no email
      // (createCustomerViaApi never sets one) — 'email' 400s with
      // "no email provided and customer has no email on file". 'sms' is
      // this route's own default and matches what the customer actually has.
      data: { channel: 'sms' },
    });
    // The route responds 202 Accepted (routes/estimates.ts's /:id/send handler).
    expect(sendRes.status(), `send estimate failed: ${await sendRes.text()}`).toBe(202);

    return { customerId: customer.id, estimateId: estimate.id };
  }

  test('a $50-off ask on a $100 quote, below the $60 floor, is refused: the owner is routed a counter at the floor, never the ask', async ({
    request,
  }) => {
    const phone = '+15125551101';
    await seedSentHundredDollarEstimate(request, tenantA, phone);

    const messageSid = `SM2-11-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedSmsPost(request, tenantA, {
      From: phone,
      Body: 'Can you knock $50 off?',
      MessageSid: messageSid,
    });
    expect(res.status()).toBe(200);

    // TWO rows share this event type per message: the U5b discount-evaluation
    // audit (`discountAuditMetadata` — decisionKind/quotedCents) fired the
    // moment `evaluateDiscount` resolves, and the handler's own unconditional
    // final audit (askType/proposalId) — both keyed on the SAME messageSid.
    const events = await pollFor<{ metadata: Record<string, unknown> }>(
      pool,
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'negotiation_guardrail.sms_routed' AND entity_id = $2`,
      [tenantA.tenantId, messageSid],
      { timeoutMs: 15_000 },
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const routed = events.find((e) => e.metadata['askType'] !== undefined);
    expect(routed, JSON.stringify(events)).toBeTruthy();
    expect(routed!.metadata).toMatchObject({ askType: 'discount' });
    const evaluated = events.find((e) => e.metadata['decisionKind'] !== undefined);
    expect(evaluated, JSON.stringify(events)).toBeTruthy();
    expect(evaluated!.metadata).toMatchObject({ decisionKind: 'REJECT_WITH_COUNTER', quotedCents: 10000 });

    const proposals = await pool.query<{ id: string; status: string; payload: { recommendation?: string } }>(
      `SELECT id, status, payload FROM proposals
        WHERE tenant_id = $1 AND proposal_type = 'callback'
          AND source_context->>'messageSid' = $2`,
      [tenantA.tenantId, messageSid],
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]!.status).toBe('draft');
    const recommendation = String(proposals.rows[0]!.payload.recommendation ?? '');
    expect(recommendation).toMatch(/\$60/);
    expect(recommendation).not.toMatch(/\$50 off/);
  });

  test("T1: the SAME $50-off ask on tenant B's own identical $100 quote is governed by tenant B's OWN (looser) floor, never tenant A's", async ({
    request,
  }) => {
    const phone = '+15125551102';
    await seedSentHundredDollarEstimate(request, tenantB, phone);

    const messageSid = `SM2-11b-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedSmsPost(request, tenantB, {
      From: phone,
      Body: 'Can you knock $50 off?',
      MessageSid: messageSid,
    });
    expect(res.status()).toBe(200);

    // Tenant B's floor ($10.00) is well below the $50.00 ask, so B's OWN
    // policy ALLOWS — the guardrail still routes a `callback` (every branch
    // does; see the handler's unconditional final audit + proposal create),
    // but the DECISION differs: ALLOW, not REJECT_WITH_COUNTER, and the
    // recommendation approves the $50 ask instead of countering at a floor.
    const eventsB = await pollFor<{ metadata: Record<string, unknown> }>(
      pool,
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'negotiation_guardrail.sms_routed' AND entity_id = $2`,
      [tenantB.tenantId, messageSid],
      { timeoutMs: 15_000 },
    );
    expect(eventsB.length).toBeGreaterThanOrEqual(2);
    const evaluatedB = eventsB.find((e) => e.metadata['decisionKind'] !== undefined);
    expect(evaluatedB, JSON.stringify(eventsB)).toBeTruthy();
    // Never REJECT_WITH_COUNTER, and specifically NOT governed by tenant A's
    // $60 floor — B's own $10 floor allows this $50 ask outright.
    expect(evaluatedB!.metadata['decisionKind']).not.toBe('REJECT_WITH_COUNTER');

    const proposalsB = await pool.query<{ payload: { recommendation?: string } }>(
      `SELECT payload FROM proposals
        WHERE tenant_id = $1 AND proposal_type = 'callback' AND source_context->>'messageSid' = $2`,
      [tenantB.tenantId, messageSid],
    );
    expect(proposalsB.rows).toHaveLength(1);
    // Never a $60 counter — that number is tenant A's floor, not tenant B's.
    expect(String(proposalsB.rows[0]!.payload.recommendation ?? '')).not.toMatch(/\$60/);

    // Tenant A's own earlier REFUSE proposal is untouched by tenant B's run.
    const stillOneA = await pool.query(
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'callback'`,
      [tenantA.tenantId],
    );
    expect(stillOneA.rows).toHaveLength(1);
  });
});
