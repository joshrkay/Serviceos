/**
 * #1015 §8.3 row 3.1 — "As J, I want a call to produce a PROPOSED booking,
 * not a booking, so the AI never puts something on my calendar without me
 * seeing it first." Phone-surface leg of the rung-5 reachability sweep, per
 * #1004's definition (adopted verbatim on #1015): a self-signed
 * Twilio-shaped webhook driven through the real `/api/telephony/*` routes
 * at a real Postgres, no SQL beyond ordinary tenant provisioning, no
 * platform-admin route, no env-var shortcut.
 *
 * REACHABILITY FINDING (see docs/audit/lane-reports/book-8-3-phone.md for
 * the full RED trail): the phone IVR's `create_appointment` flow is
 * reachable deterministically up to and including the intent readback —
 * `matchNewBookingPhrase` (intent-classifier.ts:1859) is a pre-LLM regex
 * short-circuit that needs no AI key — but the VERY NEXT turn always
 * requires a real model. `confirmIntent` (ai/skills/confirm-intent.ts)
 * classifies the caller's yes/no answer via `gateway.complete({taskType:
 * 'classify_intent', ...})`, and the hermetic no-key gateway
 * (`scriptHermeticResponse`, ai/providers/mock.ts) never produces the
 * `{"answer": "yes"|"no"}` shape `parseYesNo` needs for ANY input — it only
 * ever returns `{intentType, confidence}` for that task type. An
 * unparseable classification is `confirmed: false` by design ("safer to
 * re-ask than queue the wrong proposal"), so no spoken answer — literal
 * "yes" included — can ever confirm the booking without a live model. This
 * was verified empirically (RED capture in the report), not assumed from
 * reading the source: an earlier version of this spec asserted a drafted
 * `create_appointment` proposal past this point and failed with an empty
 * `proposals` table every time.
 *
 * What IS proven below: the call never silently books (no `appointments`
 * row, no `proposals` row, ever — no gate needed since nothing is drafted
 * until the confirm succeeds), the correct intent is read back to the
 * caller by a model-free path, and this reachable frontier is tenant-
 * isolated (T2). The row's remaining claim — the confirmed proposal, its
 * approval through the inbox, and the resulting appointment — needs a real
 * `AI_PROVIDER_API_KEY`, which is out of scope for this hermetic lane.
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
const A_DID = `+1512${RUN}301`;
const B_DID = `+1512${RUN}302`;
const A_SUBACCOUNT = 'AC1015aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1015bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1015-31';
const B_TOKEN = 'tenant-b-twilio-auth-token-1015-31';
const CALLER = '+15125557301';

// Turn 1 is consumed by the FSM's 'identifying' state (caller
// identification), NOT intent classification — empirically confirmed (see
// the lane report): the first /gather turn after /voice always answers
// with the greeting-to-intent-capture prompt ("How can I help you today?")
// regardless of what was said, because /voice's own greeting->identifying
// transition already ran before Twilio ever collects speech. Content is
// irrelevant; anything unblocks it.
const IDENTIFY_UTTERANCE = 'This is a customer calling';
// Anchored, entity-free — matches NEW_BOOKING_PHRASES's second pattern
// ("(I'd like to) book|schedule|set up a <qualifier> visit/appointment/…").
const OPENING_UTTERANCE = "I'd like to schedule a diagnostic visit";
// A clear, unambiguous affirmative — chosen to make the seam finding
// unambiguous: even this literal "yes" cannot confirm the booking, because
// the classification of it (not the word itself) is what needs a model.
const CONFIRM_UTTERANCE = 'Yes, that is right';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = phoneLaneDbReady();
const noLiveLlmKey = phoneLaneNoLiveLlmKey();

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1015 row 3.1 — a call produces a PROPOSED booking, not a booking (phone surface)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real, disposable Postgres (DATABASE_URL, migrated, E2E_USE_TEST_DB=true so it gets ' +
      'truncated at end-of-run) and TENANT_ENCRYPTION_KEY so the tenant Twilio credential can be ' +
      'stored the way a provisioned tenant stores it.',
  );
  test.skip(
    !noLiveLlmKey,
    'AI_PROVIDER_API_KEY is set — this spec\'s whole premise is the hermetic no-key mock gateway ' +
      '(see header comment); running with a real key would issue a live, paid classification call ' +
      'instead of hitting the documented stop point. Unset it for this run.',
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
        From: CALLER,
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

  /** Drives identify -> booking-open -> confirm-attempt. Returns each TwiML. */
  async function driveToConfirmAttempt(
    request: APIRequestContext,
    tenant: ProvisionedTenant,
    callSid: string,
  ): Promise<{ identifyTwiml: string; openingTwiml: string; confirmAttemptTwiml: string }> {
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: tenant.subaccountSid, From: CALLER, To: tenant.did },
      tenant.authToken,
    );
    expect(voice.status()).toBe(200);
    let sid = sessionIdFromTwiml(await voice.text());

    const identify = await gatherTurn(request, tenant, callSid, sid, IDENTIFY_UTTERANCE);
    sid = identify.sid;

    // Deterministic, pre-LLM short-circuit (matchNewBookingPhrase) — no
    // gateway call, classifies create_appointment @ 0.95 with no entities.
    const opening = await gatherTurn(request, tenant, callSid, sid, OPENING_UTTERANCE);
    sid = opening.sid;

    // The seam: this turn's answer is classified via confirmIntent's
    // gateway.complete({taskType: 'classify_intent'}) call, which the
    // hermetic mock cannot answer with {answer: 'yes'}.
    const confirmAttempt = await gatherTurn(request, tenant, callSid, sid, CONFIRM_UTTERANCE);

    return { identifyTwiml: identify.twiml, openingTwiml: opening.twiml, confirmAttemptTwiml: confirmAttempt.twiml };
  }

  const proposalsFor = (tenantId: string) =>
    pool.query<{ id: string; proposal_type: string; status: string }>(
      `SELECT id, proposal_type, status FROM proposals WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
  const appointmentsFor = (tenantId: string) =>
    pool.query<{ id: string }>(`SELECT id FROM appointments WHERE tenant_id = $1`, [tenantId]);

  test('reaches the create_appointment intent readback deterministically, drafts NO proposal and books NO appointment — the confirm turn is the model-dependent seam', async ({
    request,
  }) => {
    const callSid = `CA-book31-a-${crypto.randomUUID().slice(0, 8)}`;
    const { identifyTwiml, openingTwiml, confirmAttemptTwiml } = await driveToConfirmAttempt(
      request,
      tenantA,
      callSid,
    );

    // Turn 1: caller identification, generic prompt — not yet intent capture.
    expect(identifyTwiml).toContain('How can I help you today?');

    // Turn 2: the deterministic, model-free classification landed on
    // create_appointment and read it back for confirmation — proving the
    // ENTITY-FREE opener reaches the right intent with zero gateway calls.
    expect(openingTwiml.toLowerCase()).toContain('create appointment');
    expect(openingTwiml.toLowerCase()).toContain('is that right');

    // Turn 3 (the seam): even a clear "Yes, that is right" cannot confirm —
    // confirmIntent's own gateway call classifies THAT answer, and the
    // hermetic mock can never return {answer: 'yes'} for it. The FSM falls
    // back to its safe default (unparseable → correction) and re-prompts.
    expect(confirmAttemptTwiml).not.toContain('create appointment');
    expect(confirmAttemptTwiml.toLowerCase()).toMatch(/try again|what would you like to do/);

    // The gate this row cares about, PROVEN the strong way: nothing is ever
    // drafted or booked while the model-dependent confirm can't succeed.
    expect((await proposalsFor(tenantA.tenantId)).rows).toHaveLength(0);
    expect((await appointmentsFor(tenantA.tenantId)).rows).toHaveLength(0);
  });

  test("T2: tenant B's identical call reaches its OWN confirm readback independently, and neither tenant's empty proposal/appointment state is perturbed by the other", async ({
    request,
  }) => {
    const beforeA = await proposalsFor(tenantA.tenantId);

    const callSid = `CA-book31-b-${crypto.randomUUID().slice(0, 8)}`;
    const { openingTwiml } = await driveToConfirmAttempt(request, tenantB, callSid);

    expect(openingTwiml.toLowerCase()).toContain('create appointment');
    expect(openingTwiml.toLowerCase()).toContain('is that right');

    expect((await proposalsFor(tenantB.tenantId)).rows).toHaveLength(0);
    expect((await appointmentsFor(tenantB.tenantId)).rows).toHaveLength(0);

    // Tenant A's state (from the previous test in this serial file) is
    // unaffected by tenant B's independent call.
    expect(await proposalsFor(tenantA.tenantId)).toEqual(beforeA);
  });
});
