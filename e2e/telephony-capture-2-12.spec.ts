/**
 * #1014 §8.2 row 2.12 — "As M, I want a property manager's call to be
 * handled as a portfolio account, so my biggest customer isn't treated
 * like a stranger." Acceptance: given a caller resolving to
 * `property_manager`, when the call runs, then the outcome is OBSERVABLY
 * DIFFERENT from a residential call — prompt, priority, and proposal
 * context.
 *
 * Phone-surface reachability leg (lane C, test/8-2-capture-r5). Verified
 * by reading the source (not assumed):
 *
 *   - `loadB2bAccountContext` (twilio-adapter.ts:938) runs INSIDE
 *     `handleInbound`, right after caller identification, for EVERY
 *     resolved customer — `assembleB2bAccountContext`
 *     (ai/agents/customer-calling/b2b-account-context.ts) returns a
 *     non-null context whenever `isBusinessAccount(customer.accountType)`
 *     (`'b2b' | 'property_manager'`) is true, with NO sub-account/parent
 *     required — `priority: true` alone. This is genuinely reachable
 *     through the real `/api/telephony/voice` webhook: a property-manager
 *     caller's session gets `session.b2bAccountContext` assembled, a
 *     residential caller's does not, and tenant B's caller (no B2B
 *     account at all) does not either.
 *   - #1010 wired the media-streams consumer (`create-voice-turn-processor.ts`
 *     → `buildAccountContextPromptSection` → a SEPARATE, labelled SYSTEM
 *     message to `classifyIntent`); #1155 wired the same section into the
 *     Gather path (`twilio-adapter.ts` `_handleGatherLocked`) and stamps
 *     `accountContext` on the proposal both transports mint.
 *
 * #1155 (fixed) — "OBSERVABLY DIFFERENT" ON THIS SURFACE, HERMETICALLY:
 * the hermetic mock gateway (`scriptHermeticResponse`, ai/providers/mock.ts)
 * scripts `classify_intent` from the last USER message only and the hermetic
 * gateway records no ai_runs rows, so the classify-prompt difference (the
 * account-context SYSTEM message, now also sent by the Gather path) is proven
 * at the integration level instead (test/integration/
 * b2b-account-context-gather.test.ts, recorded gateway requests). What THIS
 * surface can observe is the proposal row: since #1155 a proposal minted on a
 * business caller's call carries `source_context.accountContext` (account
 * type + PRIORITY). The second test drives the deterministic emergency path
 * (a server-side keyword match, no LLM involved) for a property-manager
 * caller and a residential caller speaking the IDENTICAL words, and reads
 * both `emergency_dispatch` proposals back from Postgres.
 *
 * #1155 also closed the route gap: `accountType` is now accepted (and
 * enum-validated) by POST/PUT /api/customers, so both tests set it through
 * the real owner route instead of direct SQL.
 *
 * T3: tenant A's property-manager customer, tenant A's OWN residential
 * customer, and tenant B's (no-B2B-account) caller are all driven in the
 * SAME run — three different account configurations, all reachable.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  devAuthBearerToken,
  createCustomerViaApi,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}121`;
const B_DID = `+1512${RUN}122`;
const A_SUBACCOUNT = 'AC1014c12aaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c12bbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c12-121';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c12-121';
const TURN_TEXT = 'The unit at 4B has no hot water, can someone come out today';
// E2 (not E1 life-safety) deterministic emergency phrase — mints an
// emergency_dispatch proposal with no LLM call, identical for both callers.
const EMERGENCY_TURN_TEXT = 'There is a burst pipe in the unit at 4B, can someone come out today';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.12 — a property-manager caller reaches the B2B-context assembly path and its call is observably different (phone surface, T3)', () => {
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
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function callAndCaptureTwiml(
    request: import('@playwright/test').APIRequestContext,
    caller: string,
    tenant: ProvisionedTenant,
    subaccountSid: string,
    authToken: string,
    speech: string = TURN_TEXT,
  ): Promise<{ status: number; twiml: string; sessionId: string }> {
    const callSid = `CA-2-12-${tenant.tenantId.slice(0, 6)}-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: tenant.did },
      authToken,
    );
    const voiceTwiml = await voice.text();
    if (voice.status() !== 200) return { status: voice.status(), twiml: voiceTwiml, sessionId: '' };
    const sid = sessionIdFromTwiml(voiceTwiml);
    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: tenant.did, SpeechResult: speech, Confidence: '0.95' },
      authToken,
    );
    return { status: gather.status(), twiml: await gather.text(), sessionId: sid };
  }

  test('T3: a property-manager caller, a residential caller (same tenant), and a no-B2B-account caller (tenant B) all reach the assembly path without error', async ({
    request,
  }) => {
    const ownerA = devAuthBearerToken(tenantA.userId);

    // #1155 — accountType set through the real owner route (see file header).
    const pm = await createCustomerViaApi(request, ownerA, {
      firstName: 'Portfolio',
      lastName: 'Manager',
      primaryPhone: '+15125551211',
      accountType: 'property_manager',
    });
    const { rows: pmRows } = await pool.query(`SELECT account_type FROM customers WHERE id = $1`, [pm.id]);
    expect(pmRows[0]?.account_type, 'POST /api/customers must persist accountType').toBe('property_manager');

    const residential = await createCustomerViaApi(request, ownerA, {
      firstName: 'Res',
      lastName: 'Idential',
      primaryPhone: '+15125551212',
    });

    const pmCall = await callAndCaptureTwiml(request, '+15125551211', tenantA, A_SUBACCOUNT, A_TOKEN);
    expect(pmCall.status).toBe(200);

    const residentialCall = await callAndCaptureTwiml(request, '+15125551212', tenantA, A_SUBACCOUNT, A_TOKEN);
    expect(residentialCall.status).toBe(200);

    const tenantBCall = await callAndCaptureTwiml(request, '+15125551213', tenantB, B_SUBACCOUNT, B_TOKEN);
    expect(tenantBCall.status).toBe(200);

    void residential;
  });

  test('#1155 — the property-manager call is OBSERVABLY DIFFERENT from the residential call: its proposal carries PRIORITY account context (formerly pinned KNOWN GAP); T3', async ({
    request,
  }) => {
    const ownerA = devAuthBearerToken(tenantA.userId);
    await createCustomerViaApi(request, ownerA, {
      firstName: 'Portfolio2',
      lastName: 'Manager2',
      primaryPhone: '+15125551214',
      accountType: 'property_manager',
    });
    await createCustomerViaApi(request, ownerA, {
      firstName: 'Res2',
      lastName: 'Idential2',
      primaryPhone: '+15125551215',
    });

    const pmCall = await callAndCaptureTwiml(request, '+15125551214', tenantA, A_SUBACCOUNT, A_TOKEN, EMERGENCY_TURN_TEXT);
    const residentialCall = await callAndCaptureTwiml(request, '+15125551215', tenantA, A_SUBACCOUNT, A_TOKEN, EMERGENCY_TURN_TEXT);
    const tenantBCall = await callAndCaptureTwiml(request, '+15125551216', tenantB, B_SUBACCOUNT, B_TOKEN, EMERGENCY_TURN_TEXT);
    for (const call of [pmCall, residentialCall, tenantBCall]) {
      expect(call.status).toBe(200);
      expect(call.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    }

    // #1133-style read-after-write: poll each call's own proposal row.
    const proposalFor = async (tenantId: string, sessionId: string) =>
      pollFor<{ proposal_type: string; account_context: Record<string, unknown> | null }>(
        pool,
        `SELECT proposal_type, source_context->'accountContext' AS account_context
           FROM proposals
          WHERE tenant_id = $1 AND source_context->>'sessionId' = $2
            AND proposal_type = 'emergency_dispatch'`,
        [tenantId, sessionId],
      );
    const pmRows = await proposalFor(tenantA.tenantId, pmCall.sessionId);
    const residentialRows = await proposalFor(tenantA.tenantId, residentialCall.sessionId);
    const tenantBRows = await proposalFor(tenantB.tenantId, tenantBCall.sessionId);

    expect({
      pm: pmRows.map((r) => r.account_context),
      residential: residentialRows.map((r) => r.account_context),
      tenantB: tenantBRows.map((r) => r.account_context),
    }).toEqual({
      pm: [{ accountType: 'property_manager', priority: true, managedPropertyCount: 0 }],
      residential: [null],
      tenantB: [null],
    });
  });
});
