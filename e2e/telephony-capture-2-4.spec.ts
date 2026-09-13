/**
 * #1014 §8.2 row 2.4 — "As M, I want a stranger on the phone to be unable
 * to reach owner-only capability, so my phone line isn't an admin
 * console." Acceptance: given a caller-surface session, when the
 * classifier returns an off-profile intent, then it becomes `unknown` and
 * is AUDITED, never silently dropped.
 *
 * Phone-surface reachability leg (lane C, test/8-2-capture-r5), driven
 * through the real `/api/telephony/voice` + `/gather` webhooks. The vitest
 * integration proof (`stranger-owner-capability.test.ts`, #1014-B) already
 * drives this at the handler level with T1 — this spec reaches the SAME
 * gate over real HTTP, with the LLM gateway UNMOCKED (no
 * `AI_PROVIDER_API_KEY` — the repo's built-in hermetic mock is what runs).
 *
 * MECHANISM, verified by reading the source (not assumed):
 *   - `isIntentAcceptedOnProfile` (ai/orchestration/classifier-profile.ts /
 *     intent-classifier.ts:655) is the ONE gate: an intent not in the
 *     caller's `PROFILE_INTENTS` set (and not a `lookup_*` / guard-exempt
 *     intent) is intercepted to `{intentType:'unknown', unknownReason:
 *     'intent_off_surface', offSurfaceIntent: <picked intent>}` BEFORE
 *     routing (intent-classifier.ts:2875-2889).
 *   - `CALLER_INTENTS` (classifier-profile.ts:183-202) explicitly
 *     INCLUDES `create_customer` and `draft_estimate` (a stranger CAN
 *     start those) but does NOT include `create_invoice` — an
 *     owner/operator-only money intent.
 *   - The hermetic mock (`scriptHermeticResponse`, ai/providers/mock.ts)
 *     deterministically classifies text matching
 *     `/\b(draft|create|prepare|make|issue)\b.*\binvoice\b/` as
 *     `{intentType:'create_invoice', confidence:0.9}` — with NO live
 *     model, a stranger's spoken "please issue an invoice for this job"
 *     reliably produces an off-surface intent to intercept.
 *   - The interception is audited as `voice.intent_off_surface`
 *     (create-voice-turn-processor.ts `auditOffSurfaceClassification`),
 *     entityType `voice_session`, metadata `{intent:'create_invoice',
 *     profile:'caller', confidence}` — shared by both the in-app processor
 *     and the real Twilio Gather adapter.
 *   - Positive control: the SAME utterance from the tenant's OWN
 *     `tenant_settings.owner_phone` resolves `ownerSession:true`
 *     (`resolveOwnerSession`, twilio-adapter.ts:1126) →
 *     `classifierProfileForSession` returns `'owner_line'`, whose
 *     `PROFILE_INTENTS` set includes `create_invoice` — never intercepted.
 *
 * T1: tenant B's own owner phone is a stranger to tenant A (still
 * intercepted there) while resolving as the OWNER on tenant B's own line
 * (never intercepted there) — the SAME phone number, opposite outcomes,
 * gated purely by which tenant's `owner_phone` it matches.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  auditRows,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}411`;
const B_DID = `+1512${RUN}412`;
const A_SUBACCOUNT = 'AC1014c4aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c4bbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c4-41';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c4-41';
const A_OWNER_PHONE = '+15125554411';
const B_OWNER_PHONE = '+15125554412';
const STRANGER = '+15125554499';
const INVOICE_UTTERANCE = 'Please issue an invoice for this job right now';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.4 — a stranger cannot reach owner-only capability; the interception is audited (phone surface, T1)', () => {
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
      ownerPhone: A_OWNER_PHONE,
    });
    tenantB = await provisionTenant(pool, enc, {
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
      ownerPhone: B_OWNER_PHONE,
    });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function speakInvoiceRequest(
    request: import('@playwright/test').APIRequestContext,
    caller: string,
    did: string,
    subaccountSid: string,
    authToken: string,
  ): Promise<string> {
    const callSid = `CA-2-4-${did.slice(-4)}-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: did },
      authToken,
    );
    expect(voice.status()).toBe(200);
    let sid = sessionIdFromTwiml(await voice.text());

    // An UNKNOWN caller's FSM state after /voice is 'ask_caller', not
    // 'intent_capture' — 'identifying' only auto-advances straight to
    // 'intent_capture' on 'caller_known'/'operator_session'
    // (transitions.ts:802/817); 'unknown_caller' lands on 'ask_caller'
    // instead (transitions.ts:830), one turn short of classification
    // (mirrors stranger-owner-capability.test.ts's own driver: "handleInbound
    // → ask_caller turn → classifying turn"). Speaking the SAME utterance on
    // two consecutive turns reaches intent_capture regardless of which state
    // the first turn lands in (content is irrelevant to the ask_caller→
    // intent_capture advance, same as book-3-1's IDENTIFY_UTTERANCE turn) and
    // is a no-op re-assertion if the first turn already classified (owner /
    // known-caller sessions that skip ask_caller entirely).
    for (let turn = 0; turn < 2; turn += 1) {
      const gather = await signedPost(
        request,
        `/api/telephony/gather?sid=${sid}`,
        { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: did, SpeechResult: INVOICE_UTTERANCE, Confidence: '0.95' },
        authToken,
      );
      expect(gather.status()).toBe(200);
      const twiml = await gather.text();
      if (/[?&]sid=/i.test(twiml)) sid = sessionIdFromTwiml(twiml);
    }
    return sid;
  }

  test("a stranger's off-surface money request is intercepted to unknown and AUDITED, never routed", async ({
    request,
  }) => {
    await speakInvoiceRequest(request, STRANGER, A_DID, A_SUBACCOUNT, A_TOKEN);

    const events = await pollFor(
      pool,
      `SELECT event_type, entity_type, metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'voice.intent_off_surface'`,
      [tenantA.tenantId],
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      entity_type: 'voice_session',
      metadata: { intent: 'create_invoice', profile: 'caller' },
    });

    // Never routed: no proposal of any invoicing kind exists for this call.
    const proposals = await pool.query(
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'create_invoice'`,
      [tenantA.tenantId],
    );
    expect(proposals.rows).toHaveLength(0);
  });

  test("positive control: the SAME utterance from the tenant's OWN owner_phone is NOT intercepted", async ({
    request,
  }) => {
    const before = (
      await auditRows(pool, tenantA.tenantId, 'voice.intent_off_surface')
    ).length;

    await speakInvoiceRequest(request, A_OWNER_PHONE, A_DID, A_SUBACCOUNT, A_TOKEN);

    // Give any (absent) audit write the same poll window the intercepted
    // case gets, then confirm the count did not move.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await auditRows(pool, tenantA.tenantId, 'voice.intent_off_surface');
    expect(after.length).toBe(before);
  });

  test("T1: tenant B's own owner_phone is a STRANGER to tenant A (intercepted there) but the OWNER on tenant B's own line (never intercepted there)", async ({
    request,
  }) => {
    const beforeA = (await auditRows(pool, tenantA.tenantId, 'voice.intent_off_surface')).length;

    // B's owner phone dialling tenant A: a stranger there.
    await speakInvoiceRequest(request, B_OWNER_PHONE, A_DID, A_SUBACCOUNT, A_TOKEN);
    const afterA = await pollFor(
      pool,
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'voice.intent_off_surface'`,
      [tenantA.tenantId],
    );
    expect(afterA.length).toBeGreaterThan(beforeA);

    // The SAME number dialling tenant B's own line: resolves as B's owner,
    // never intercepted.
    const beforeB = (await auditRows(pool, tenantB.tenantId, 'voice.intent_off_surface')).length;
    await speakInvoiceRequest(request, B_OWNER_PHONE, B_DID, B_SUBACCOUNT, B_TOKEN);
    await new Promise((r) => setTimeout(r, 1500));
    const afterB = await auditRows(pool, tenantB.tenantId, 'voice.intent_off_surface');
    expect(afterB.length).toBe(beforeB);
  });
});
