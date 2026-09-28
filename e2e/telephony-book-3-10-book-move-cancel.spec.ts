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
 * UPDATE (re-grade 2026-09-27 at origin/main): #1119 (PR #1365) added
 * anchored, entity-free MOVE/CANCEL openings ("I need to reschedule my
 * appointment") and a hermetic "yes". Those now classify, confirm and draft
 * a `reschedule_appointment` / `cancel_appointment` proposal — but one that
 * names no appointment, and the follow-up ("the Garcia appointment") is not
 * understood without a model. The entity-bearing phrasings above still stop
 * at classification. So the row's claim (a move/cancel that lands) is still
 * not reached hermetically; the new tests pin exactly how far it gets.
 *
 * UPDATE (#1015, 2026-09-27): the entity-free opening now asks ONE question —
 * which appointment — and the owner's answer ("The Garcia appointment") is
 * resolved through the shared entity resolver, so the drafted proposal
 * carries the verified `appointmentId`. The MOVE and CANCEL tests below drive
 * that all the way: spoken request → draft → the owner approves on the real
 * proposals API → the production executor cancels / moves the real
 * appointment row with exactly one audit event. (A name matching two
 * appointments is asked about, never guessed — pinned at real Postgres in
 * packages/api/test/integration/phone-appointment-change-reference-3-10.test.ts.)
 *
 * Still NOT reached hermetically: an entity-bearing one-shot phrasing ("Move
 * Tuesday's Garcia appointment to Thursday at 2 PM") — that needs a model to
 * classify; the tests below pin it. T1: a neighbour tenant's identical
 * owner-line calls leave tenant A untouched.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  API_URL,
  devAuthBearerToken,
  pollFor,
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
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
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantNeighbour: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1015 row 3.10 — book, move and cancel by talking, on the owner line (phone surface)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY.',
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
      // #1223 — the owner line is trusted only with full STIR/SHAKEN
      // A-attestation, which Twilio sends on /voice as StirVerstat. Without it
      // the owner is an untrusted caller and owner intents never classify.
      {
        CallSid: callSid,
        AccountSid: tenant.subaccountSid,
        From: ownerPhone,
        To: tenant.did,
        StirVerstat: 'TN-Validation-Passed-A',
      },
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

  test('BOOK reaches the deterministic create_appointment readback; nothing is drafted before the owner confirms', async ({
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

  test('an entity-bearing MOVE ("Move Tuesday\'s Garcia appointment…") still never classifies without a model — the #1119 opening is entity-free by design', async ({
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

  test('an entity-bearing CANCEL still never classifies without a model', async ({
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

  /**
   * Seed one customer + service location + job + ONE upcoming appointment
   * under `tenant` — the record a spoken move/cancel is about. Returns the
   * appointment id and its original start.
   */
  async function seedAppointment(
    tenant: ProvisionedTenant,
    lastName: string,
    daysOut: number,
  ): Promise<{ appointmentId: string; start: Date }> {
    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers
         (id, tenant_id, first_name, last_name, display_name, preferred_channel,
          sms_consent, is_archived, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Maria', $3, $4, 'none', false, false, $5, now(), now())`,
      [customerId, tenant.tenantId, lastName, `Maria ${lastName}`, tenant.userId],
    );
    const locationId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO service_locations
         (id, tenant_id, customer_id, street1, city, state, postal_code, country, created_at, updated_at)
       VALUES ($1, $2, $3, '9 Oak Street', 'Austin', 'TX', '78701', 'US', now(), now())`,
      [locationId, tenant.tenantId, customerId],
    );
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs
         (id, tenant_id, customer_id, location_id, job_number, summary, status, priority, created_by,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', 'normal', $7, now(), now())`,
      [jobId, tenant.tenantId, customerId, locationId, `JOB-${lastName.toUpperCase()}-${RUN}`, `${lastName} furnace service`, tenant.userId],
    );
    const start = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000);
    start.setUTCHours(15, 0, 0, 0);
    const appointmentId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO appointments
         (id, tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'America/Chicago', 'scheduled', $6, now(), now())`,
      [appointmentId, tenant.tenantId, jobId, start, new Date(start.getTime() + 2 * 60 * 60 * 1000), tenant.userId],
    );
    return { appointmentId, start };
  }

  /** opening → "which appointment?" → the name → readback → "Yes". Returns the drafted proposal. */
  async function spokenChange(
    request: APIRequestContext,
    leg: { opening: string; answer: string; readback: string; type: string },
  ): Promise<{ id: string; status: string; payload: Record<string, unknown> }> {
    const callSid = `CA-book310-chg-${crypto.randomUUID().slice(0, 8)}`;
    const sid = await startOwnerCall(request, tenantA, A_OWNER_PHONE, callSid);
    const opening = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, sid, leg.opening);
    // One question — which appointment — not a readback of an unactionable request.
    expect(opening.twiml.toLowerCase()).toContain('which appointment');
    expect(opening.twiml.toLowerCase()).not.toContain('is that right');

    const answer = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, opening.sid, leg.answer);
    expect(answer.twiml.toLowerCase()).toContain(`${leg.readback}. is that right`);

    await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, answer.sid, 'Yes');
    const { rows } = await pool.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      `SELECT id, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = $2`,
      [tenantA.tenantId, leg.type],
    );
    expect(rows).toHaveLength(1);
    // Drafted, never executed on the call.
    expect(rows[0].status).toBe('draft');
    return rows[0];
  }

  const auditsFor = (tenantId: string, entityId: string, eventType: string) =>
    pollFor<{ id: string }>(
      pool,
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = $3`,
      [tenantId, entityId, eventType],
    );

  test('CANCEL by talking: "I need to cancel my appointment" → "The Garcia appointment" resolves → the owner approves → the appointment is canceled with exactly one audit event', async ({
    request,
  }) => {
    const garcia = await seedAppointment(tenantA, 'Garcia', 3);
    // T1 — the neighbour holds its OWN "Garcia" appointment, the most
    // tempting wrong answer there is.
    const neighbourGarcia = await seedAppointment(tenantNeighbour, 'Garcia', 3);
    const proposal = await spokenChange(request, {
      opening: 'I need to cancel my appointment',
      answer: 'The Garcia appointment',
      readback: 'cancel appointment',
      type: 'cancel_appointment',
    });
    // The verified id, from the entity resolver — not a guess, not absent.
    expect(proposal.payload.appointmentId).toBe(garcia.appointmentId);
    // Nothing changed on the call itself.
    const before = await pool.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [garcia.appointmentId]);
    expect(before.rows[0].status).toBe('scheduled');

    const auth = { authorization: `Bearer ${devAuthBearerToken(tenantA.userId)}` };
    const approve = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(approve.status()).toBe(200);

    const canceled = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM appointments WHERE tenant_id = $1 AND id = $2 AND status = 'canceled'`,
      [tenantA.tenantId, garcia.appointmentId],
    );
    expect(canceled).toHaveLength(1);
    expect(await auditsFor(tenantA.tenantId, garcia.appointmentId, 'appointment.canceled')).toHaveLength(1);
    // The neighbour's Garcia is untouched and was never a candidate.
    const nb = await pool.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [neighbourGarcia.appointmentId]);
    expect(nb.rows[0].status).toBe('scheduled');
    const nbAudits = await pool.query(
      `SELECT id FROM audit_events WHERE entity_id = $1`,
      [neighbourGarcia.appointmentId],
    );
    expect(nbAudits.rows).toHaveLength(0);
  });

  test('BOOK by talking on the owner line: the readback is confirmed, the draft is completed on the card and approved → exactly one new appointment with exactly one audit event', async ({
    request,
  }) => {
    const callSid = `CA-book310-bookok-${crypto.randomUUID().slice(0, 8)}`;
    const sid = await startOwnerCall(request, tenantA, A_OWNER_PHONE, callSid);
    const book = await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, sid, BOOK_UTTERANCE);
    expect(book.twiml.toLowerCase()).toContain('create appointment. is that right');
    await gatherTurn(request, tenantA, A_OWNER_PHONE, callSid, book.sid, 'Yes');

    const { rows } = await pool.query<{ id: string; status: string; payload: { customerId: string } }>(
      `SELECT id, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'create_appointment'`,
      [tenantA.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    const proposal = rows[0];
    const auth = { authorization: `Bearer ${devAuthBearerToken(tenantA.userId)}` };

    // No time was spoken: approving as drafted is refused.
    const early = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(early.status()).toBe(400);

    // What the owner does on the card (row 3.1's completion): an address and a time.
    const loc = await request.post(`${API_URL}/api/locations`, {
      headers: auth,
      data: { customerId: proposal.payload.customerId, street1: '12 Oak Street', city: 'Austin', state: 'TX', postalCode: '78701' },
    });
    expect(loc.status()).toBe(201);
    const start = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    start.setUTCHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const edit = await request.put(`${API_URL}/api/proposals/${proposal.id}`, {
      headers: auth,
      data: { edits: { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() } },
    });
    expect(edit.status()).toBe(200);
    const approve = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(approve.status()).toBe(200);

    const booked = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM appointments WHERE tenant_id = $1 AND scheduled_start = $2`,
      [tenantA.tenantId, start],
    );
    expect(booked).toHaveLength(1);
    expect(await auditsFor(tenantA.tenantId, booked[0].id, 'appointment.created')).toHaveLength(1);
  });

  test('MOVE by talking: "I need to reschedule my appointment" → "The Okafor appointment" resolves → the owner sets the new time and approves → the appointment moves with exactly one audit event', async ({
    request,
  }) => {
    const okafor = await seedAppointment(tenantA, 'Okafor', 4);
    const proposal = await spokenChange(request, {
      opening: 'I need to reschedule my appointment',
      answer: 'The Okafor appointment',
      readback: 'reschedule appointment',
      type: 'reschedule_appointment',
    });
    expect(proposal.payload.appointmentId).toBe(okafor.appointmentId);

    const auth = { authorization: `Bearer ${devAuthBearerToken(tenantA.userId)}` };
    // No new time was spoken, so the draft is gated on it: approving it as
    // drafted is refused — the AI never picks a time nobody chose.
    const early = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(early.status()).toBe(400);

    const newStart = new Date(okafor.start.getTime() + 24 * 60 * 60 * 1000);
    const newEnd = new Date(newStart.getTime() + 2 * 60 * 60 * 1000);
    const edit = await request.put(`${API_URL}/api/proposals/${proposal.id}`, {
      headers: auth,
      data: { edits: { newScheduledStart: newStart.toISOString(), newScheduledEnd: newEnd.toISOString() } },
    });
    expect(edit.status()).toBe(200);
    const approve = await request.post(`${API_URL}/api/proposals/${proposal.id}/approve`, { headers: auth, data: {} });
    expect(approve.status()).toBe(200);

    const moved = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM appointments WHERE tenant_id = $1 AND id = $2 AND scheduled_start = $3`,
      [tenantA.tenantId, okafor.appointmentId, newStart],
    );
    expect(moved).toHaveLength(1);
    expect(await auditsFor(tenantA.tenantId, okafor.appointmentId, 'appointment.rescheduled')).toHaveLength(1);
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
    // Only the neighbour's own seeded Garcia appointment exists, unchanged.
    const nbAppts = await pool.query<{ status: string }>(
      `SELECT status FROM appointments WHERE tenant_id = $1`,
      [tenantNeighbour.tenantId],
    );
    expect(nbAppts.rows.map((r) => r.status)).toEqual(['scheduled']);

    // Tenant A's own (empty) state from the earlier tests in this serial
    // file is unaffected by the neighbour's independent calls.
    expect(await proposalsFor(tenantA.tenantId)).toEqual(beforeA);
  });
});
