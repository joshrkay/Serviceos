/**
 * #1015 §8.3 row 3.1 — "As J, I want a call to produce a PROPOSED booking,
 * not a booking, so the AI never puts something on my calendar without me
 * seeing it first." Phone-surface leg of the rung-5 reachability sweep, per
 * #1004's definition (adopted verbatim on #1015): a self-signed
 * Twilio-shaped webhook driven through the real `/api/telephony/*` routes
 * at a real Postgres, no SQL beyond ordinary tenant provisioning, no
 * platform-admin route, no env-var shortcut.
 *
 * REACHABILITY (re-graded 2026-09-27 at origin/main): the whole row is now
 * reached hermetically. `matchNewBookingPhrase` classifies the opening
 * model-free; since #1119 (PR #1365) the hermetic gateway answers a clear
 * "yes" on the confirm turn, so the call drafts ONE `create_appointment`
 * proposal and books nothing. The last test drives the owner's half through
 * the real routes: approving the draft as-is is refused (no time was named),
 * the owner adds the address and the time, approves, and the production
 * executor writes exactly one appointment with its `appointment.created`
 * audit row. Since #1388 the fixture provisions no E1 script by SQL.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  devAuthBearerToken,
  pollFor,
  API_URL,
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
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1015 row 3.1 — a call produces a PROPOSED booking, not a booking (phone surface)', () => {
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

  test('the caller confirms, a create_appointment PROPOSAL is drafted for the owner, and NO appointment is booked', async ({
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
    // create_appointment and read it back for confirmation.
    expect(openingTwiml.toLowerCase()).toContain('create appointment');
    expect(openingTwiml.toLowerCase()).toContain('is that right');

    // Turn 3: since #1119 (PR #1365) the hermetic gateway answers a clear
    // affirmative "yes", so the confirm succeeds — and the caller is told a
    // person will confirm, never that it is booked.
    expect(confirmAttemptTwiml.toLowerCase()).toContain('someone from our team will confirm');

    // The row's claim, proven at the rows: exactly one PROPOSED booking,
    // not executed, and nothing on the calendar.
    const proposals = (await proposalsFor(tenantA.tenantId)).rows;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposal_type).toBe('create_appointment');
    expect(['draft', 'ready_for_review']).toContain(proposals[0].status);
    expect((await appointmentsFor(tenantA.tenantId)).rows).toHaveLength(0);
  });

  test("T2: tenant B's identical call drafts ITS OWN proposal, and tenant A's proposal set is unchanged by it", async ({
    request,
  }) => {
    const beforeA = await proposalsFor(tenantA.tenantId);

    const callSid = `CA-book31-b-${crypto.randomUUID().slice(0, 8)}`;
    const { openingTwiml, confirmAttemptTwiml } = await driveToConfirmAttempt(request, tenantB, callSid);

    expect(openingTwiml.toLowerCase()).toContain('create appointment');
    expect(confirmAttemptTwiml.toLowerCase()).toContain('someone from our team will confirm');

    const proposalsB = (await proposalsFor(tenantB.tenantId)).rows;
    expect(proposalsB).toHaveLength(1);
    expect(proposalsB[0].proposal_type).toBe('create_appointment');
    expect((await appointmentsFor(tenantB.tenantId)).rows).toHaveLength(0);

    // Tenant A's state (from the previous test in this serial file) is
    // unaffected by tenant B's independent call.
    expect(await proposalsFor(tenantA.tenantId)).toEqual(beforeA);
  });

  test('the owner fills the time and approves: the production executor books exactly one appointment, audited — and not before', async ({
    request,
  }) => {
    // The proposal tenant A's call drafted in the first test. The caller named
    // no time, so it carries the scheduledStart/scheduledEnd gate: approving it
    // as drafted is refused — the AI never books a time nobody chose.
    const [proposal] = (
      await pool.query<{ id: string; payload: { customerId: string } }>(
        `SELECT id, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'create_appointment'`,
        [tenantA.tenantId],
      )
    ).rows;
    expect(proposal).toBeDefined();
    const auth = { authorization: `Bearer ${devAuthBearerToken(tenantA.userId)}` };

    const early = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(early.status()).toBe(400);
    expect((await appointmentsFor(tenantA.tenantId)).rows).toHaveLength(0);

    // What the owner does on the card, through the real routes: the caller's
    // service address (the auto-opened job needs one — jobs.location_id is
    // NOT NULL) and a time.
    const loc = await request.post(`${API_URL}/api/locations`, {
      headers: auth,
      data: {
        customerId: proposal.payload.customerId,
        street1: '12 Oak Street',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
    });
    expect(loc.status()).toBe(201);
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    start.setUTCHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const edit = await request.put(`${API_URL}/api/proposals/${proposal.id}`, {
      headers: auth,
      data: { edits: { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() } },
    });
    expect(edit.status()).toBe(200);

    const approve = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(approve.status()).toBe(200);

    // Execution runs on the in-process executor after approval — poll for it.
    const appts = await pollFor<{ id: string; scheduled_start: Date }>(
      pool,
      `SELECT id, scheduled_start FROM appointments WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(appts).toHaveLength(1);
    expect(new Date(appts[0].scheduled_start).toISOString()).toBe(start.toISOString());
    const audit = await pollFor<{ event_type: string }>(
      pool,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'appointment.created'`,
      [tenantA.tenantId, appts[0].id],
    );
    expect(audit).toHaveLength(1);
    // Tenant B's drafted proposal is still only a proposal.
    expect((await appointmentsFor(tenantB.tenantId)).rows).toHaveLength(0);
  });
});
