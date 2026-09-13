/**
 * #1015 §8.3 row 3.7 — "As M, I want the AI to ask instead of guessing when
 * two customers share a name, so it never books the wrong customer."
 * Phone-surface leg, rung-5 reachability per #1004's definition: a
 * self-signed Twilio-shaped webhook driven through the real
 * `/api/telephony/*` routes at a real Postgres.
 *
 * GAP FOUND, NOT FIXED (mirrors e2e/telephony-e1-signed-webhook.spec.ts's
 * "SECURITY GAP FOUND, NOT FIXED" convention — this lane is test-only and
 * may not touch product code). `entity_ambiguous` — the FSM event that
 * turns a same-name collision into a disambiguation question — is
 * dispatched from exactly ONE place in the whole codebase:
 * `ai/agents/customer-calling/inapp-adapter.ts` (the in-app/chat operator
 * surface). Neither the classic `/api/telephony/gather` adapter
 * (telephony/twilio-adapter.ts) nor the media-streams voice-turn processor
 * (`ai/voice-turn/create-voice-turn-processor.ts`) ever dispatches it: both
 * call the SAME `resolveTurnEntities` → `resolveSchedulingEntities`
 * pipeline, but unconditionally fold whatever `resolution.refs` comes back
 * into an `entity_resolved` event and move straight to `intent_confirm` —
 * an ambiguous resolution (multiple same-scored candidates) is silently
 * dropped rather than surfaced. Verified two ways below: (1) a direct
 * `PgEntityResolver.resolve()` call against the exact fixture confirms
 * Postgres genuinely reports `{kind: 'ambiguous', candidates: [...]}` for
 * two same-named customers — so this is not a seeding problem; (2) the RED
 * capture (see the lane report) shows the live phone call proceeding
 * straight to the `create_job` confirm readback with no disambiguation
 * prompt at all, for the identical fixture.
 *
 * `create_job` (not `create_appointment`) is the vehicle: it is the
 * nearest deterministic, entity-bearing, customer-naming write intent
 * reachable without a model — `OWNER_OPERATOR_COMMAND_PATTERNS`
 * (intent-classifier.ts) has no `create_appointment`/`reschedule_
 * appointment`/`cancel_appointment` entry at all (never entity-bearing on
 * this surface), and `matchNewBookingPhrase`'s `create_appointment`
 * short-circuit is entity-free BY DESIGN (see its own doc comment) — so no
 * booking-shaped utterance can deterministically carry a customer name
 * into entity resolution. `create_job` opens the job a booking would hang
 * off (`jobs.location_id` is NOT NULL — CLAUDE.md's own domain shape), and
 * is a `CUSTOMER_REF_INTENTS` member that runs through the IDENTICAL
 * `resolveSchedulingEntities` pipeline `create_appointment` would use if it
 * had one, so the finding transfers directly.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  devAuthBearerToken,
  phoneLaneDbReady,
  API_URL,
  type ProvisionedTenant,
} from './fixtures/twilio-phone-lane';
import { PgEntityResolver } from '../packages/api/src/ai/resolution/pg-entity-resolver';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}701`;
const B_DID = `+1512${RUN}702`;
const A_SUBACCOUNT = 'AC1015aaaa7aaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1015bbbb7bbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1015-37';
const B_TOKEN = 'tenant-b-twilio-auth-token-1015-37';
const A_OWNER_PHONE = `+1512${RUN}791`;
const B_OWNER_PHONE = `+1512${RUN}792`;
const SHARED_NAME_FIRST = 'Jamie';
const SHARED_NAME_LAST = 'Rivera';
const SHARED_NAME = `${SHARED_NAME_FIRST} ${SHARED_NAME_LAST}`;
const BOOKING_UTTERANCE = `Open a job for ${SHARED_NAME}, leaking faucet repair`;

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = phoneLaneDbReady();

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1015 row 3.7 — the AI asks instead of guessing when two customers share a name (phone surface)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real, disposable Postgres (DATABASE_URL, migrated, E2E_USE_TEST_DB=true so it gets ' +
      'truncated at end-of-run) and TENANT_ENCRYPTION_KEY so the tenant Twilio credential can be ' +
      'stored the way a provisioned tenant stores it.',
  );

  test.beforeAll(async ({ request }) => {
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
      ownerPhone: A_OWNER_PHONE,
    });
    tenantB = await provisionTenant(pool, enc, {
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
      ownerPhone: B_OWNER_PHONE,
    });

    // Two customers sharing a name on tenant A (and one same-named customer
    // on tenant B, for the T1 cross-tenant negative), through the REAL
    // customers API — never a direct SQL insert.
    const tokenA = devAuthBearerToken(tenantA.userId);
    await createCustomer(request, tokenA, { firstName: SHARED_NAME_FIRST, lastName: SHARED_NAME_LAST });
    await createCustomer(request, tokenA, { firstName: SHARED_NAME_FIRST, lastName: SHARED_NAME_LAST });

    const tokenB = devAuthBearerToken(tenantB.userId);
    await createCustomer(request, tokenB, { firstName: SHARED_NAME_FIRST, lastName: SHARED_NAME_LAST });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function createCustomer(request: APIRequestContext, token: string, opts: { firstName: string; lastName: string }) {
    const res = await request.post(`${API_URL}/api/customers`, {
      headers: { authorization: `Bearer ${token}` },
      data: { firstName: opts.firstName, lastName: opts.lastName, preferredChannel: 'phone' },
    });
    expect(res.status()).toBe(201);
    return res.json();
  }

  async function gatherTurn(
    request: APIRequestContext,
    tenant: ProvisionedTenant,
    callSid: string,
    sid: string,
    speech: string,
  ): Promise<{ sid: string; twiml: string }> {
    const res = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: tenant.subaccountSid,
        From: tenant.did === A_DID ? A_OWNER_PHONE : B_OWNER_PHONE,
        To: tenant.did,
        SpeechResult: speech,
        Confidence: '0.95',
      },
      tenant.authToken,
    );
    expect(res.status()).toBe(200);
    const twiml = await res.text();
    const nextSid = /[?&]sid=/i.test(twiml) ? sessionIdFromTwiml(twiml) : sid;
    return { sid: nextSid, twiml };
  }

  /** Drives an OWNER-LINE call (From = the tenant's owner_phone) to the booking utterance. */
  async function driveOwnerBookingCall(
    request: APIRequestContext,
    tenant: ProvisionedTenant,
    ownerPhone: string,
    callSid: string,
  ): Promise<{ identifyTwiml: string; bookingTwiml: string }> {
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: tenant.subaccountSid, From: ownerPhone, To: tenant.did },
      tenant.authToken,
    );
    expect(voice.status()).toBe(200);
    let sid = sessionIdFromTwiml(await voice.text());

    const identify = await gatherTurn(request, tenant, callSid, sid, 'This is the owner calling');
    sid = identify.sid;
    const booking = await gatherTurn(request, tenant, callSid, sid, BOOKING_UTTERANCE);

    return { identifyTwiml: identify.twiml, bookingTwiml: booking.twiml };
  }

  test('GAP (found on #1015, NOT fixed here): two same-named customers on tenant A never trigger a disambiguation question on the phone surface', async ({
    request,
  }) => {
    // Direct proof #1: Postgres itself genuinely reports this as ambiguous
    // — the gap is in the phone adapter's wiring, not the seeded fixture.
    const directResolve = await new PgEntityResolver(pool).resolve({
      tenantId: tenantA.tenantId,
      reference: SHARED_NAME,
      kind: 'customer',
    });
    expect(directResolve.kind).toBe('ambiguous');
    if (directResolve.kind === 'ambiguous') {
      expect(directResolve.candidates.length).toBe(2);
    }

    // Direct proof #2: the live call, through the real routes.
    const callSid = `CA-book37-a-${crypto.randomUUID().slice(0, 8)}`;
    const { identifyTwiml, bookingTwiml } = await driveOwnerBookingCall(request, tenantA, A_OWNER_PHONE, callSid);
    expect(identifyTwiml).toContain('How can I help you today?');

    // TODAY: the call proceeds straight to the ordinary confirm readback —
    // no disambiguation, despite two equally-scored "Jamie Rivera" rows.
    expect(bookingTwiml.toLowerCase()).toContain('create job');
    expect(bookingTwiml.toLowerCase()).toContain('is that right');
    expect(bookingTwiml.toLowerCase()).not.toMatch(/which .*(rivera|jamie)|more than one|two customers/);

    // No proposal was drafted either way — this gap doesn't accidentally
    // book the wrong customer, it just never asks (silently proceeds toward
    // the confirm gate, which the phone surface's own model-dependent seam
    // — see row 3.1's spec — then blocks from ever completing).
    const { rows } = await pool.query(`SELECT proposal_type FROM proposals WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(rows).toHaveLength(0);
  });

  test(
    'DESIRED (currently FAILS, see the GAP above): the phone surface should ask a disambiguation question instead of silently dropping the ambiguity',
    async ({ request }) => {
      test.fail();
      const callSid = `CA-book37-desired-${crypto.randomUUID().slice(0, 8)}`;
      const { bookingTwiml } = await driveOwnerBookingCall(request, tenantA, A_OWNER_PHONE, callSid);
      // The day this starts passing is the day to delete this test, promote
      // the assertion into the GAP test above, and re-grade the row.
      expect(bookingTwiml.toLowerCase()).toMatch(/which .*(rivera|jamie)|more than one match/);
    },
  );

  test("T1: a same-named customer on tenant B is never a candidate for tenant A's ambiguous call", async ({
    request,
  }) => {
    const directResolveOtherTenant = await new PgEntityResolver(pool).resolve({
      tenantId: tenantB.tenantId,
      reference: SHARED_NAME,
      kind: 'customer',
    });
    // Tenant B has its OWN "Jamie Rivera" (seeded in beforeAll) — resolving
    // under tenant A's id must never surface it as a THIRD ambiguous
    // candidate, and resolving under tenant B's own id must never return
    // tenant A's two rows either.
    if (directResolveOtherTenant.kind === 'ambiguous') {
      expect(directResolveOtherTenant.candidates.length).toBe(1);
    } else {
      expect(directResolveOtherTenant.kind).toBe('resolved');
    }

    const directResolveTenantA = await new PgEntityResolver(pool).resolve({
      tenantId: tenantA.tenantId,
      reference: SHARED_NAME,
      kind: 'customer',
    });
    expect(directResolveTenantA.kind).toBe('ambiguous');
    if (directResolveTenantA.kind === 'ambiguous') {
      expect(directResolveTenantA.candidates).toHaveLength(2);
    }

    // Tenant B's own owner-line call reaches its own confirm readback
    // independently, unaffected by tenant A's ambiguity.
    const callSid = `CA-book37-b-${crypto.randomUUID().slice(0, 8)}`;
    const { bookingTwiml } = await driveOwnerBookingCall(request, tenantB, B_OWNER_PHONE, callSid);
    expect(bookingTwiml.toLowerCase()).toContain('create job');
    expect((await pool.query(`SELECT id FROM proposals WHERE tenant_id = $1`, [tenantB.tenantId])).rows).toHaveLength(0);
  });
});
