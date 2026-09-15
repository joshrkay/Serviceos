/**
 * #1014 §8.2 row 2.1 — "As M, I want my phone answered 24/7 in my shop's
 * voice, so I stop losing jobs to whoever answers first." Acceptance:
 * given a customer dials my number, when the call lands, then the tenant
 * is resolved from the real `phoneE164` column and the greeting is my
 * shop's.
 *
 * Phone-surface reachability leg (lane C, test/8-2-capture-r5), same shape
 * as e2e/telephony-e1-signed-webhook.spec.ts / telephony-book-3-1-proposed
 * -booking.spec.ts: a self-signed Twilio-shaped webhook POST through the
 * real `/api/telephony/voice` route at a real Postgres. The vitest
 * integration proof (`voice-inbound-appointment.test.ts`, #1014-A) already
 * covers this at the handler level with T2 — this spec drives the SAME
 * story through the real HTTP surface instead of calling the adapter
 * directly.
 *
 * Proof: the tenant is resolved purely from the dialled `To` number
 * (`resolveTenantIdByPhoneNumber`, app.ts, reading
 * `tenant_integrations.provider_data->>'phoneE164'`).
 *
 * CORRECTION (verified by reading the actual wiring, not assumed): the
 * default greeting template (`buildTelephonyGreeting`'s branch 2/3,
 * telephony/twilio-adapter.ts:490-498) is built from `this.deps.businessName`
 * — a SINGLE STATIC value fixed at process boot
 * (`process.env.TWILIO_BUSINESS_NAME ?? 'our team'`, app.ts:3611 and every
 * other `new TwilioGatherAdapter(...)` call site), NOT the dialled tenant's
 * own `tenant_settings.business_name`. `routes/telephony.ts`'s `/voice`
 * handler calls `deps.adapter.handleInbound({ callSid, from, to, tenantId })`
 * with no businessName override (routes/telephony.ts:495-497) — there is no
 * per-tenant plumbing into the default template at all. An earlier draft of
 * this spec assumed `tenant_settings.business_name` flowed into the greeting
 * verbatim; it does not, and would have failed against the real product.
 *
 * The ONLY way a tenant's own words reach the greeting is branch 1 —
 * `persona.greeting` (`tenant_settings.voice_greeting`, resolved per-tenant by
 * `createVoicePersonaResolver`, settings/voice-persona-resolver.ts) — which
 * REPLACES the entire default opener verbatim
 * (`buildTelephonyGreeting`:487-489) before the recording disclosure is
 * appended. This is the real, product-supported way a shop's own greeting
 * reaches its callers ("the greeting is my shop's" — Settings › Voice), so
 * this spec sets each tenant's OWN `voice_greeting` and asserts the `/voice`
 * TwiML contains EACH tenant's own custom text, never the other tenant's
 * (T2: two tenants, two DIDs, two distinct custom greetings, in one run). A
 * `voice_sessions` row read back by `call_sid` corroborates the same tenant
 * resolution at the DB layer.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  voiceSessionRow,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}201`;
const B_DID = `+1512${RUN}202`;
const A_SUBACCOUNT = 'AC1014caaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014cbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c-21';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c-21';
const CALLER = '+15125557301';
const A_BUSINESS = 'Alpha Rooter and Drain 21';
const B_BUSINESS = 'Bravo HVAC Services 21';
// The tenant's OWN words (tenant_settings.voice_greeting) — the only path a
// business's own name reaches the /voice TwiML (see file header). Plain
// ASCII, no apostrophes/ampersands, so no XML-escaping subtlety enters the
// substring match against the raw TwiML.
const A_GREETING = `Thanks for calling ${A_BUSINESS}, how can we help`;
const B_GREETING = `Thanks for calling ${B_BUSINESS}, how can we help`;

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.1 — a dialled number resolves its own tenant and greeting (phone surface, T2)', () => {
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
    tenantA = await provisionTenant(pool, enc, {
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      authToken: A_TOKEN,
      businessName: A_BUSINESS,
    });
    tenantB = await provisionTenant(pool, enc, {
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
      businessName: B_BUSINESS,
    });
    // The real, product-supported per-tenant override (Settings › Voice) —
    // see file header for why the default template can't carry a tenant's
    // own name.
    await pool.query(`UPDATE tenant_settings SET voice_greeting = $1 WHERE tenant_id = $2`, [
      A_GREETING,
      tenantA.tenantId,
    ]);
    await pool.query(`UPDATE tenant_settings SET voice_greeting = $1 WHERE tenant_id = $2`, [
      B_GREETING,
      tenantB.tenantId,
    ]);
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test("tenant A's dialled number greets with tenant A's own business name, never tenant B's", async ({
    request,
  }) => {
    const callSid = `CA-2-1-a-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
      A_TOKEN,
    );
    expect(res.status()).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain(A_GREETING);
    expect(twiml).not.toContain(B_GREETING);
    expect(twiml).not.toContain(B_BUSINESS);

    const rows = await pollFor<{ tenant_id: string }>(
      pool,
      `SELECT tenant_id FROM voice_sessions WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA.tenantId);
  });

  test("T2: tenant B's OWN dialled number resolves to tenant B and greets with tenant B's name, in the same run", async ({
    request,
  }) => {
    const callSid = `CA-2-1-b-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(res.status()).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain(B_GREETING);
    expect(twiml).not.toContain(A_GREETING);
    expect(twiml).not.toContain(A_BUSINESS);

    const rows = await pollFor<{ tenant_id: string }>(
      pool,
      `SELECT tenant_id FROM voice_sessions WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantB.tenantId);

    // Tenant A's earlier session is untouched by tenant B's call.
    const aStillOwn = await voiceSessionRow(pool, tenantA.tenantId, callSid);
    expect(aStillOwn).toHaveLength(0);
  });
});
