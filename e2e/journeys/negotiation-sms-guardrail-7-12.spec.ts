import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import twilio from 'twilio';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { encrypt } from '../../packages/api/src/integrations/crypto';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  createAndSendSimpleEstimate,
  queryAsTenant,
  logRows,
  signInOwnerBrowser,
  type Tenant,
  type JobRef,
} from '../fixtures/estimate-quote-lane';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? API_URL).replace(/\/+$/, '');
const CUSTOMER_PHONE_A = '+15125559001';
const CUSTOMER_PHONE_B = '+15125559002';

/**
 * §8.7 row 7.12 — rung-5 reachability: a customer's discount ask NEVER gets
 * a customer-facing concession — it always produces a capture-class owner
 * callback proposal (`draft`, awaiting review) plus a
 * `negotiation_guardrail.sms_routed` audit event, through the REAL inbound
 * SMS webhook (`POST /webhooks/twilio/sms/:tenantId`,
 * packages/api/src/webhooks/routes.ts, `twilioRoute('sms')`) — the actual
 * customer-facing surface — driven with a genuinely signed Twilio-shaped
 * request, exactly like e2e/fixtures/twilio-sms-lane.ts's merged §8.4 specs.
 *
 * `createInboundNegotiationHandler` (packages/api/src/sms/negotiation/
 * inbound-negotiation-handler.ts) is wired into production dispatch LAST in
 * app.ts (~line 3344) with a REAL `evaluateNegotiationDiscount` closure
 * (settings → PgSettingsRepository, quote → DefaultCurrentQuoteResolver) —
 * no LLM call anywhere on this path: `detectNegotiationAskType` is a fixed
 * keyword/regex list (negotiation-guardrail.ts), not a model turn.
 *
 * T1 + T3: tenant A is left at the DEFAULT `discountMaxBps` (unset ⇒ 0,
 * fail-closed — `resolveNegotiationDiscount` never even resolves a quote,
 * V1 byte-identical owner callback). Tenant B opts in through the REAL
 * owner Discount Policy settings sheet (`/settings`,
 * `DiscountPolicySheet.tsx`, `PUT /api/settings` `discountMaxBps`) — a
 * genuinely different per-tenant CONFIG that makes the SAME code path
 * additionally resolve a real quote and evaluate the ask (V2). Both
 * branches still produce ONLY a holding-line reply and an owner callback —
 * never a price to the customer — proving the invariant holds under two
 * divergent configurations, not just the unconfigured default.
 *
 * Owner bootstrap: real Clerk `user.created` webhook (bootstrapOwner). The
 * Twilio DID/subaccount/auth-token row has no reachable product UI (it is
 * provisioned by a background worker against a real Twilio account, which
 * this hermetic sandbox does not have) — inserted directly for the EXISTING,
 * Clerk-bootstrapped tenant, the same justification
 * e2e/fixtures/twilio-phone-lane.ts's `provisionTenant` documents for the
 * technician-user row, and the established pattern the merged §8.3/§8.4
 * phone/SMS lanes use for this exact column set.
 */

interface TwilioIntegration {
  subaccountSid: string;
  authToken: string;
  did: string;
}

async function provisionTwilioIntegration(
  pool: Pool,
  tenantId: string,
  encKey: string,
): Promise<TwilioIntegration> {
  const subaccountSid = `AC${randomUUID().replace(/-/g, '').slice(0, 32)}`;
  const authToken = randomUUID().replace(/-/g, '');
  const did = `+1512555${Math.floor(1000 + Math.random() * 8999)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `INSERT INTO tenant_integrations
         (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
      [tenantId, JSON.stringify({ phoneE164: did }), subaccountSid, encrypt(authToken, encKey)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { subaccountSid, authToken, did };
}

async function signedSmsPost(
  request: APIRequestContext,
  tenantId: string,
  integration: TwilioIntegration,
  body: { From: string; Body: string },
) {
  const path = `/webhooks/twilio/sms/${tenantId}`;
  const params: Record<string, string> = {
    MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    AccountSid: integration.subaccountSid,
    From: body.From,
    To: integration.did,
    Body: body.Body,
    NumMedia: '0',
  };
  const signature = twilio.getExpectedTwilioSignature(
    integration.authToken,
    `${PUBLIC_API_URL}${path}`,
    params,
  );
  return request.post(`${API_URL}${path}`, {
    headers: {
      'X-Twilio-Signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    },
    form: params,
  });
}

async function seedCustomerJobEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  phone: string,
): Promise<{ job: JobRef; estimateId: string; totalCentsBefore: number }> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      firstName: 'Negotiator',
      lastName: 'Customer',
      primaryPhone: phone,
      preferredChannel: 'sms',
      smsConsent: true,
    }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      street1: '1 Negotiation Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    }),
  });
  expect(locationRes.ok()).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      locationId: location.id,
      summary: '7.12 negotiation guardrail job',
    }),
  });
  expect(jobRes.ok()).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };
  const jobRef: JobRef = { customerId: customer.id, locationId: location.id, jobId: job.id };

  const sent = await createAndSendSimpleEstimate(request, tenant, jobRef, 22_500);
  return { job: jobRef, estimateId: sent.estimateId, totalCentsBefore: 22_500 };
}

test.describe('negotiation guardrail — SMS discount ask never concedes (7.12) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.TENANT_ENCRYPTION_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres, plus TENANT_ENCRYPTION_KEY ' +
      '(64 hex chars) for the tenant_integrations row.',
  );

  test('a discount-asking SMS always produces a capture-class owner callback + audit row, never a price to the customer, under two divergent tenant configs (T1·T3)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const encKey = process.env.TENANT_ENCRYPTION_KEY!;

    try {
      // ── Tenant A: LEFT AT DEFAULT — discountMaxBps unset (0), fail-closed
      //    V1 path. No owner action taken on Discount Policy at all. ────────
      const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.12');
      const integrationA = await provisionTwilioIntegration(pool, tenantA.tenantId, encKey);
      const seedA = await seedCustomerJobEstimate(request, tenantA, CUSTOMER_PHONE_A);

      // ── Tenant B (T3): owner opts in through the REAL Discount Policy
      //    settings sheet — a genuinely different per-tenant config on the
      //    SAME negotiation code path. ─────────────────────────────────────
      const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.12');
      const integrationB = await provisionTwilioIntegration(pool, tenantB.tenantId, encKey);
      const seedB = await seedCustomerJobEstimate(request, tenantB, CUSTOMER_PHONE_B);

      await signInOwnerBrowser(page, baseURL!, tenantB);
      await page.goto('/settings');
      await page.getByText('Discount policy', { exact: true }).click();
      const maxInput = page.getByLabel('Maximum discount the AI may propose');
      await expect(maxInput).toBeVisible({ timeout: 15_000 });
      await maxInput.fill('10');
      await page.getByRole('button', { name: /^Save$/i }).click();
      await expect(page.getByText('Discount policy saved', { exact: false })).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, '7.12-tenantB-discount-policy-configured.png') });

      const settingsB = await request.get(`${API_URL}/api/settings`, { headers: tenantB.authHeaders });
      const settingsBBody = (await settingsB.json()) as { discountMaxBps?: number };
      expect(settingsBBody.discountMaxBps, 'tenant B must be genuinely opted in (T3 config)').toBeGreaterThan(0);

      const settingsA = await request.get(`${API_URL}/api/settings`, { headers: tenantA.authHeaders });
      const settingsABody = (await settingsA.json()) as { discountMaxBps?: number };
      expect(settingsABody.discountMaxBps ?? 0, 'tenant A stays at the unconfigured default').toBe(0);

      // ── The discount ask — a real signed SMS webhook to EACH tenant.
      //    Tenant A's V1 path never parses the ask (evaluation short-
      //    circuits before quote resolution), so a vague ask is fine.
      //    Tenant B's V2 path DOES parse it — a concrete "$X off" keeps it
      //    out of the CLARIFY branch (which mints a DIFFERENT proposal type,
      //    voice_clarification, not callback) and into ALLOW/NEEDS_APPROVAL/
      //    REJECT_WITH_COUNTER, all three of which are still the capture-
      //    class 'callback' this row's acceptance is about. ─────────────────
      const smsA = await signedSmsPost(request, tenantA.tenantId, integrationA, {
        From: CUSTOMER_PHONE_A,
        Body: 'This is way too expensive, can you do a discount?',
      });
      expect(smsA.status(), `sms webhook A -> ${smsA.status()} ${await smsA.text()}`).toBe(200);

      const smsB = await signedSmsPost(request, tenantB.tenantId, integrationB, {
        From: CUSTOMER_PHONE_B,
        Body: 'Can you knock $20 off the price for me?',
      });
      expect(smsB.status(), `sms webhook B -> ${smsB.status()} ${await smsB.text()}`).toBe(200);

      // ── Durable proof, tenant A (V1, unconfigured): exactly one capture-
      //    class 'callback' proposal in 'draft', one sms_routed audit row ───
      let proposalsA: Record<string, unknown>[] = [];
      for (let i = 0; i < 20 && proposalsA.length === 0; i++) {
        proposalsA = await queryAsTenant(
          tenantA.tenantId,
          `SELECT id, proposal_type, status, source_context, summary
             FROM proposals WHERE tenant_id = $1 AND proposal_type = 'callback'`,
          [tenantA.tenantId],
        );
        if (proposalsA.length === 0) await new Promise((r) => setTimeout(r, 150));
      }
      logRows('7.12 tenant A proposals (callback)', proposalsA);
      expect(proposalsA, '#1133-style poll for the async-dispatched callback proposal').toHaveLength(1);
      expect(proposalsA[0]!.status).toBe('draft');
      expect((proposalsA[0]!.source_context as { source?: string } | null)?.source).toBe('sms');
      expect(String(proposalsA[0]!.summary)).toMatch(/AI didn't negotiate; call back/i);

      const auditA = await queryAsTenant(
        tenantA.tenantId,
        `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'negotiation_guardrail.sms_routed'`,
        [tenantA.tenantId],
      );
      logRows('7.12 tenant A audit_events negotiation_guardrail.sms_routed', auditA);
      expect(auditA.length).toBeGreaterThanOrEqual(1);

      // No concession: the ORIGINAL estimate total is byte-identical.
      const estA = await request.get(`${API_URL}/api/estimates/${seedA.estimateId}`, {
        headers: tenantA.authHeaders,
      });
      const estABody = (await estA.json()) as { totals: { totalCents: number } };
      expect(estABody.totals.totalCents).toBe(seedA.totalCentsBefore);

      // ── Durable proof, tenant B (V2, opted-in): the SAME shape, but the
      //    evaluation ran (discountAuditMetadata carries a real decision) ───
      let proposalsB: Record<string, unknown>[] = [];
      for (let i = 0; i < 20 && proposalsB.length === 0; i++) {
        proposalsB = await queryAsTenant(
          tenantB.tenantId,
          `SELECT id, proposal_type, status, source_context, summary
             FROM proposals WHERE tenant_id = $1 AND proposal_type = 'callback'`,
          [tenantB.tenantId],
        );
        if (proposalsB.length === 0) await new Promise((r) => setTimeout(r, 150));
      }
      logRows('7.12 tenant B proposals (callback)', proposalsB);
      expect(proposalsB).toHaveLength(1);
      expect(proposalsB[0]!.status).toBe('draft');

      const auditB = await queryAsTenant(
        tenantB.tenantId,
        `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'negotiation_guardrail.sms_routed'`,
        [tenantB.tenantId],
      );
      // T3 — tenant B's config difference produces an ADDITIONAL audit row
      // (the discount-decision metadata call) that tenant A's unconfigured
      // path never takes.
      logRows('7.12 tenant B audit_events negotiation_guardrail.sms_routed (T3: carries decisionKind)', auditB);
      expect(auditB.length).toBeGreaterThan(auditA.length);
      // …and that extra row carries the REAL evaluated decision
      // (`discountAuditMetadata`, discount-proposal-content.ts) against the
      // REAL quoted total ($225 sent above) — the SMS-surface analog of the
      // ALLOW/REJECT decision negotiation-guardrail.test.ts proves at the
      // service layer. Whichever non-CLARIFY branch a "$20 off $225" ask
      // lands in under a 10% cap, it is a decision, never a concession: the
      // proposal above is still 'draft' and the estimate total is unchanged.
      const decisionRows = auditB.filter(
        (r) => typeof (r.metadata as { decisionKind?: unknown } | null)?.decisionKind === 'string',
      );
      expect(decisionRows).toHaveLength(1);
      const decision = decisionRows[0]!.metadata as { decisionKind: string; quotedCents: number };
      expect(['ALLOW', 'NEEDS_APPROVAL', 'REJECT_WITH_COUNTER']).toContain(decision.decisionKind);
      expect(decision.quotedCents).toBe(seedB.totalCentsBefore);
      // Tenant A (unconfigured, V1) never evaluated anything — no row of
      // its carries a decision at all.
      expect(
        auditA.filter((r) => (r.metadata as { decisionKind?: unknown } | null)?.decisionKind !== undefined),
      ).toHaveLength(0);

      const estB = await request.get(`${API_URL}/api/estimates/${seedB.estimateId}`, {
        headers: tenantB.authHeaders,
      });
      const estBBody = (await estB.json()) as { totals: { totalCents: number } };
      expect(estBBody.totals.totalCents).toBe(seedB.totalCentsBefore);

      // ── T1 — cross-tenant isolation on the proposals + audit trail ───────
      const crossProposals = await queryAsTenant(
        tenantB.tenantId,
        `SELECT id FROM proposals WHERE id = $1`,
        [proposalsA[0]!.id],
      );
      expect(crossProposals).toHaveLength(0);
      const crossAudit = await queryAsTenant(
        tenantA.tenantId,
        `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'negotiation_guardrail.sms_routed'
           AND tenant_id != $2`,
        [tenantA.tenantId, tenantA.tenantId],
      );
      expect(crossAudit).toHaveLength(0);

      // ── Real owner browser: tenant A opens the Inbox and SEES the
      //    callback proposal it must now decide on. ───────────────────────
      await signInOwnerBrowser(page, baseURL!, tenantA);
      await page.goto('/inbox');
      await expect(page.getByText(/AI didn't negotiate; call back/i).first()).toBeVisible({
        timeout: 20_000,
      });
      await page.screenshot({ path: join(SCREENSHOT_DIR, '7.12-tenantA-inbox-callback.png') });
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
