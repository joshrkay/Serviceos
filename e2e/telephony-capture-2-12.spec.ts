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
 *   - #1010 wired the ONLY consumer: `create-voice-turn-processor.ts`
 *     resolves `session.b2bAccountContext` →
 *     `buildAccountContextPromptSection` → passed to `classifyIntent` as a
 *     SEPARATE, labelled SYSTEM message ahead of the transcript.
 *
 * WHY THE ROW'S OWN "OBSERVABLY DIFFERENT" CANNOT BE SHOWN ON THIS SURFACE
 * HERMETICALLY (#1119-class — pinned below, not faked): the hermetic mock
 * gateway (`scriptHermeticResponse`, ai/providers/mock.ts) scripts its
 * `classify_intent` branch from `lastUserText(request)` ONLY — it reads
 * the last message with `role: 'user'` and never inspects any `role:
 * 'system'` message. The B2B account-context section #1010 wires in is
 * ALWAYS a system message (`create-voice-turn-processor.ts`'s
 * `b2bAccountPromptSection` assembly). So, with NO live model, a
 * property-manager caller and a residential caller who speak the IDENTICAL
 * turn produce the IDENTICAL classification, `intentType` included — there
 * is no external (HTTP response / DB row) signal this lane's hermetic
 * webhook surface can observe that distinguishes them. The row's own
 * "priority" field is never read anywhere else either (confirmed: grep
 * shows zero consumers of `ctx.priority` besides the prompt section
 * builder) — so nothing routes on it that a DB read-back could catch.
 * What IS proven below: the assembly path itself is reachable and inert
 * (never crashes, never errors) for all three configurations in one run —
 * a genuine, if partial, reachability result — with the "observably
 * different" requirement pinned as unreachable without a live model.
 *
 * GENUINE PRODUCT GAP (report only, not fixed here — test-only lane): no
 * owner-facing route sets a customer's `accountType`. `createCustomerSchema`
 * (shared/contracts.ts) and `routes/customers.ts` never mention
 * `accountType`/`account_type` at all (grepped, zero hits) — it is settable
 * ONLY by direct SQL today. This spec sets it that way, same as any other
 * tenant/customer CONFIGURATION column this lane seeds directly when no
 * route exists (mirrors provisionTenant's own direct settings inserts) —
 * not a state the product's call-handling logic itself should have
 * produced.
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

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.12 — a property-manager caller reaches the B2B-context assembly path (phone surface, T3; observable-difference leg pinned #1119-class)', () => {
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
  ): Promise<{ status: number; twiml: string }> {
    const callSid = `CA-2-12-${tenant.tenantId.slice(0, 6)}-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: tenant.did },
      authToken,
    );
    const voiceTwiml = await voice.text();
    if (voice.status() !== 200) return { status: voice.status(), twiml: voiceTwiml };
    const sid = sessionIdFromTwiml(voiceTwiml);
    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: tenant.did, SpeechResult: TURN_TEXT, Confidence: '0.95' },
      authToken,
    );
    return { status: gather.status(), twiml: await gather.text() };
  }

  test('T3: a property-manager caller, a residential caller (same tenant), and a no-B2B-account caller (tenant B) all reach the assembly path without error', async ({
    request,
  }) => {
    const ownerA = devAuthBearerToken(tenantA.userId);

    const pm = await createCustomerViaApi(request, ownerA, {
      firstName: 'Portfolio',
      lastName: 'Manager',
      primaryPhone: '+15125551211',
    });
    // No owner-facing route sets accountType (see file header) — direct SQL
    // configuration, not a state the call-handling logic itself produces.
    await pool.query(`UPDATE customers SET account_type = 'property_manager' WHERE id = $1`, [pm.id]);

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

  test(
    'KNOWN GAP — the property-manager call should be OBSERVABLY DIFFERENT from the residential call (expected to fail hermetically)',
    async ({ request }) => {
      test.fail(
        true,
        'ai/providers/mock.ts scriptHermeticResponse (the hermetic no-' +
          'AI_PROVIDER_API_KEY LLM gateway every spec in this lane runs ' +
          'under) scripts classify_intent from lastUserText(request) ONLY — ' +
          "it never inspects a role:'system' message. #1010's B2B account " +
          "context (create-voice-turn-processor.ts's b2bAccountPromptSection) " +
          'is ALWAYS carried as a separate system message, never folded into ' +
          'the user turn, so a property-manager caller and a residential ' +
          'caller speaking the IDENTICAL utterance produce the IDENTICAL ' +
          'classification with no live model — there is no HTTP response or ' +
          "DB row this hermetic webhook surface can read that distinguishes " +
          "them. session.b2bAccountContext.priority also has NO OTHER " +
          'consumer anywhere in the codebase (grepped) to route on instead. ' +
          '#1119-class: the row\'s "observably different" claim needs a real ' +
          'model to reach on this surface.',
      );

      const ownerA = devAuthBearerToken(tenantA.userId);
      const pm2 = await createCustomerViaApi(request, ownerA, {
        firstName: 'Portfolio2',
        lastName: 'Manager2',
        primaryPhone: '+15125551214',
      });
      await pool.query(`UPDATE customers SET account_type = 'property_manager' WHERE id = $1`, [pm2.id]);
      const res2 = await createCustomerViaApi(request, ownerA, {
        firstName: 'Res2',
        lastName: 'Idential2',
        primaryPhone: '+15125551215',
      });

      const pmCall = await callAndCaptureTwiml(request, '+15125551214', tenantA, A_SUBACCOUNT, A_TOKEN);
      const residentialCall = await callAndCaptureTwiml(request, '+15125551215', tenantA, A_SUBACCOUNT, A_TOKEN);

      void res2;
      // Each call's TwiML embeds a fresh, random session id in the <Gather>
      // action URL (`?sid=<uuid>`) — a meaningless difference present on
      // EVERY pair of calls regardless of B2B logic. Strip it so the
      // comparison reflects actual spoken/business content, not per-call
      // plumbing — otherwise this assertion "passes" for the wrong reason
      // (any two calls' raw TwiML always differ by this UUID alone).
      const normalize = (twiml: string) => twiml.replace(/sid=[0-9a-f-]{36}/gi, 'sid=SESSION');
      expect(
        normalize(pmCall.twiml),
        'expected the PM call to differ observably from the residential call',
      ).not.toBe(normalize(residentialCall.twiml));
    },
  );
});
