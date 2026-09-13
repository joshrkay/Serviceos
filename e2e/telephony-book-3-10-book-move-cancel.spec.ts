/**
 * #1015 §8.3 row 3.10 — "As M, I want to book, move and cancel by talking,
 * so I can do it between attics." Phone-surface leg, rung-5 reachability
 * per #1004's definition: a self-signed Twilio-shaped webhook driven
 * through the real `/api/telephony/*` routes at a real Postgres, on the
 * OWNER's own line (`owner_phone` — `isApproverPhone`,
 * telephony/twilio-adapter.ts's `resolveOwnerSession`).
 *
 * REACHABILITY FINDING (full detail + raw captures in
 * docs/audit/lane-reports/book-8-3-phone.md): none of the three legs can
 * complete on this hermetic (no `AI_PROVIDER_API_KEY`) phone surface, and
 * they stop at TWO DIFFERENT depths:
 *
 *   - BOOK reaches the SAME wall row 3.1's spec documents: the anchored,
 *     entity-free `matchNewBookingPhrase` short-circuit (intent-
 *     classifier.ts:1859) classifies `create_appointment` deterministically
 *     and the FSM reads it back for confirmation — but confirming it needs
 *     `confirmIntent`'s own `gateway.complete({taskType: 'classify_intent'})`
 *     call, and the hermetic mock never returns `{answer: 'yes'}` for
 *     anything, so no spoken reply can ever confirm it.
 *   - MOVE (`reschedule_appointment`) and CANCEL (`cancel_appointment`) stop
 *     EARLIER — at classification itself. Neither intent has ANY
 *     deterministic short-circuit anywhere in intent-classifier.ts (grepped
 *     for `intentType: 'reschedule_appointment'` / `'cancel_appointment'` —
 *     zero matches, owner-gated or not), so every reschedule/cancel
 *     utterance goes to the real LLM classify call. The hermetic mock's
 *     `scriptHermeticResponse` only scripts `classify_intent` for
 *     `create_customer`/`draft_estimate`/`create_invoice` (ai/providers/
 *     mock.ts) — anything else, reschedule/cancel phrasing included, comes
 *     back `{intentType: 'unknown', confidence: 0.2}`, which never clears
 *     `TAU_INT` and reprompts immediately. This is reachable and provable,
 *     just shallower than BOOK: it never even reaches entity resolution, so
 *     no appointment lookup — real or not — is ever attempted.
 *
 * What IS proven below, on the real owner-line routes at a real Postgres:
 * the deterministic BOOK readback, the immediate MOVE/CANCEL reprompt, that
 * nothing is ever drafted or booked for any of the three, and that this
 * frontier is tenant-isolated (T1, a neighbour tenant's identical owner
 * line). The row's full claim — three completed, approved, audited
 * proposals — needs a real `AI_PROVIDER_API_KEY`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  phoneLaneDbReady,
  phoneLaneNoLiveLlmKey,
  type ProvisionedTenant,
} from './fixtures/twilio-phone-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}01`;
const NEIGHBOUR_DID = `+1512${RUN}02`;
const A_SUBACCOUNT = 'AC1015aaaa10aaaaaaaaaaaaaaaaaaaaaa';
const NEIGHBOUR_SUBACCOUNT = 'AC1015bbbb10bbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1015-310';
const NEIGHBOUR_TOKEN = 'tenant-neighbour-twilio-auth-token-1015-310';
const A_OWNER_PHONE = `+1512${RUN}91`;
const NEIGHBOUR_OWNER_PHONE = `+1512${RUN}92`;

const IDENTIFY_UTTERANCE = 'This is the owner calling';
const BOOK_UTTERANCE = "I'd like to schedule a diagnostic visit";
const MOVE_UTTERANCE = "Move Tuesday's Garcia appointment to Thursday at 2 PM";
const CANCEL_UTTERANCE = "Cancel Tuesday's Garcia appointment";

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = phoneLaneDbReady();
const noLiveLlmKey = phoneLaneNoLiveLlmKey();

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantNeighbour: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1015 row 3.10 — book, move and cancel by talking, on the owner line (phone surface)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real, disposable Postgres (DATABASE_URL, migrated, E2E_USE_TEST_DB=true so it gets ' +
      'truncated at end-of-run) and TENANT_ENCRYPTION_KEY so the tenant Twilio credential can be ' +
      'stored the way a provisioned tenant stores it.',
  );
  test.skip(
    !noLiveLlmKey,
    'AI_PROVIDER_API_KEY is set — BOOK\'s premise is the hermetic no-key mock gateway (see header ' +
      'comment), and a real key could let MOVE/CANCEL actually classify. Unset it for this run.',
  );

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `DELETE FROM tenant_integrations WHERE provider = 'twilio' AND provider_data->>'phoneE164' = ANY($1)`,
      [[A_DID, NEIGHBOUR_DID]],
    );
    tenantA = await provisionTenant(pool, enc, {
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      authToken: A_TOKEN,
      ownerPhone: A_OWNER_PHONE,
    });
    tenantNeighbour = await provisionTenant(pool, enc, {
      did: NEIGHBOUR_DID,
      subaccountSid: NEIGHBOUR_SUBACCOUNT,
      authToken: NEIGHBOUR_TOKEN,
      ownerPhone: NEIGHBOUR_OWNER_PHONE,
    });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function gatherTurn(
    request: APIRequestContext,
    tenant: ProvisionedTenant,
    ownerPhone: string,
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
        From: ownerPhone,
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

  async function startOwnerCall(
    request: APIRequestContext,
    tenant: ProvisionedTenant,
    ownerPhone: string,
    callSid: string,
  ): Promise<string> {
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: tenant.subaccountSid, From: ownerPhone, To: tenant.did },
      tenant.authToken,
    );
    expect(voice.status()).toBe(200);
    let sid = sessionIdFromTwiml(await voice.text());
    const identify = await gatherTurn(request, tenant, ownerPhone, callSid, sid, IDENTIFY_UTTERANCE);
    return identify.sid;
  }

  const proposalsFor = (tenantId: string) =>
    pool.query<{ id: string }>(`SELECT id FROM proposals WHERE tenant_id = $1`, [tenantId]);
  const appointmentsFor = (tenantId: string) =>
    pool.query<{ id: string }>(`SELECT id FROM appointments WHERE tenant_id = $1`, [tenantId]);

  test('BOOK reaches the deterministic create_appointment readback; nothing is drafted (same model-dependent seam as row 3.1)', async ({
    request,
  }) => {
    const callSid = `CA-book310-book-${crypto.randomUUID().slice(0, 8)}`;
    const sid = await startOwnerCall(request, tenantA, A_OWNER_PHONE, callSid);
    const { twiml } = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, sid, BOOK_UTTERANCE);

    expect(twiml.toLowerCase()).toContain('create appointment');
    expect(twiml.toLowerCase()).toContain('is that right');
    expect((await proposalsFor(tenantA.tenantId)).rows).toHaveLength(0);
    expect((await appointmentsFor(tenantA.tenantId)).rows).toHaveLength(0);
  });

  test('MOVE never even classifies deterministically — no reschedule_appointment short-circuit exists on this surface', async ({
    request,
  }) => {
    const callSid = `CA-book310-move-${crypto.randomUUID().slice(0, 8)}`;
    const sid = await startOwnerCall(request, tenantA, A_OWNER_PHONE, callSid);
    const { twiml } = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, sid, MOVE_UTTERANCE);

    // Low-confidence reprompt — never reaches entity resolution or confirm,
    // and critically NEVER contains a readback of "reschedule" — the
    // classifier genuinely never resolved the intent at all, not merely
    // failed to confirm it (contrast with BOOK's readback above).
    expect(twiml.toLowerCase()).not.toContain('reschedule');
    expect(twiml.toLowerCase()).not.toContain('is that right');
    expect(twiml).toMatch(/<Gather/);
    expect((await proposalsFor(tenantA.tenantId)).rows).toHaveLength(0);
  });

  test('CANCEL never even classifies deterministically — no cancel_appointment short-circuit exists on this surface', async ({
    request,
  }) => {
    const callSid = `CA-book310-cancel-${crypto.randomUUID().slice(0, 8)}`;
    const sid = await startOwnerCall(request, tenantA, A_OWNER_PHONE, callSid);
    const { twiml } = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, sid, CANCEL_UTTERANCE);

    expect(twiml.toLowerCase()).not.toContain('cancel');
    expect(twiml.toLowerCase()).not.toContain('is that right');
    expect(twiml).toMatch(/<Gather/);
    expect((await proposalsFor(tenantA.tenantId)).rows).toHaveLength(0);
  });

  test('T1 with a neighbour: the neighbour tenant\'s identical owner-line calls reach the same frontier independently, and tenant A stays untouched', async ({
    request,
  }) => {
    const beforeA = await proposalsFor(tenantA.tenantId);

    const bookCallSid = `CA-book310-nb-book-${crypto.randomUUID().slice(0, 8)}`;
    const bookSid = await startOwnerCall(request, tenantNeighbour, NEIGHBOUR_OWNER_PHONE, bookCallSid);
    const book = await gatherTurn(request, tenantNeighbour, NEIGHBOUR_OWNER_PHONE, bookCallSid, bookSid, BOOK_UTTERANCE);
    expect(book.twiml.toLowerCase()).toContain('create appointment');

    const moveCallSid = `CA-book310-nb-move-${crypto.randomUUID().slice(0, 8)}`;
    const moveSid = await startOwnerCall(request, tenantNeighbour, NEIGHBOUR_OWNER_PHONE, moveCallSid);
    const move = await gatherTurn(request, tenantNeighbour, NEIGHBOUR_OWNER_PHONE, moveCallSid, moveSid, MOVE_UTTERANCE);
    expect(move.twiml.toLowerCase()).not.toContain('reschedule');

    expect((await proposalsFor(tenantNeighbour.tenantId)).rows).toHaveLength(0);
    expect((await appointmentsFor(tenantNeighbour.tenantId)).rows).toHaveLength(0);

    // Tenant A's own (empty) state from the earlier tests in this serial
    // file is unaffected by the neighbour's independent calls.
    expect(await proposalsFor(tenantA.tenantId)).toEqual(beforeA);
  });
});
