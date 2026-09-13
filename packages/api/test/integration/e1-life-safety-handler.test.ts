/**
 * #1014 row 2.5 (lane B) — "As J, I want a gas leak recognised before any AI
 * thinks about it, so a life-safety call never waits on a model."
 * Proven at the REAL handler against real Postgres, with a second tenant
 * present (T1).
 *
 * WHAT THIS DRIVES — the production Gather seam, nothing stubbed but the LLM
 * gateway:
 *   `TwilioGatherAdapter.handleGather`
 *     → `runDeterministicSafetyScan` (src/telephony/twilio-adapter.ts:2185 —
 *        positioned BEFORE the classify call, which is the whole point of the
 *        row)
 *     → `runEmergencyScan` (src/telephony/twilio-adapter.ts:1612) →
 *        `classifyCallerSafety` (src/ai/agents/customer-calling/emergency-tier.ts:213)
 *     → FSM `emergency_detected` / tier E1 guard
 *        (src/ai/agents/customer-calling/transitions.ts:546) → `terminated`
 *     → `handleRevokePendingBookings`
 *        (src/ai/voice-turn/create-voice-turn-processor.ts:2555) against the
 *        real `PgProposalRepository`
 *     → both audit legs read back through a real `PgAuditRepository`.
 *
 * DELIBERATELY NOT DUPLICATED: the separate Sonnet lane (#1020, invariant I8)
 * proves "E1 with no triage rules loaded" at this handler. This file owns the
 * legs that lane does not: the English/Spanish language pair, the booking
 * revocation, the never-books clause, and T1.
 *
 * TEST-ONLY. The E1 script text (decision O-2) and
 * `ai/agents/customer-calling/emergency-tier.ts` semantics are NOT touched —
 * which is why the Spanish leg below SURFACES a defect instead of fixing it.
 *
 * ─── GAP FOUND, NOT FIXED (see the last two tests) ────────────────────────
 * A Spanish gas-leak report does NOT reach the E1 life-safety path. It
 * classifies E2 (urgent dispatch): the caller hears the generic dispatcher
 * line instead of the evacuation script, the call does NOT terminate, and a
 * booking drafted earlier in the call is NOT revoked. Cause:
 * `classifyCallerSafety` derives E1 only from the English-only
 * `E1_HAZARD_PHRASES` table; the Spanish phrases ("fuga de gas",
 * "huele a gas", "escape de gas", "olor a gas") exist only in
 * `emergency-detector.ts`'s `SPANISH_EMERGENCY_KEYWORDS`, which
 * `classifyCallerSafety` folds in as the `backstop` candidate at tier E2
 * unconditionally — discarding the `language` field `detectEmergency`
 * already returns. `emergency-detector.ts:28` documents the opposite
 * intent ("a Spanish speaker on an 'English' call still says 'fuga de gas',
 * and the life-safety path must fire either way").
 * Fixing it means changing emergency-tier.ts semantics, which this lane is
 * forbidden from doing, and it is a life-safety change that needs a named
 * owner. Pinned below both ways: the current behaviour as a passing
 * characterization, and the DESIRED behaviour as an `it.fails` that will
 * start failing (and so demand a row update) the day it is fixed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import type { AuditEvent } from '../../src/audit/audit';
import type { VoiceSession } from '../../src/ai/agents/customer-calling/types';

/** English E1 gas report — matches E1_HAZARD_PHRASES ('smell gas'). */
const EN_GAS = 'I smell gas in my kitchen and it is getting stronger';
/** Spanish E1 gas report — matches SPANISH_EMERGENCY_KEYWORDS ('fuga de gas'). */
const ES_GAS = 'hay una fuga de gas en mi casa, huele muy fuerte';

const EMERGENCY_EVENT_SUFFIX = '.emergency_detected';
const BOOKING_REVOKED_EVENT = 'agent.calling.e1_booking_revoked';
const CLASSIFIED_EVENT_SUFFIX = '.intent_classified';

interface Seeded {
  tenantId: string;
  ownerUserId: string;
}

/**
 * One inbound call driven exactly as Twilio drives it, plus the handles a
 * test needs to inspect afterwards. `llm` is the spy on the gateway so the
 * "before any AI" claim can be asserted rather than asserted-about.
 */
interface Call {
  session: VoiceSession;
  adapter: TwilioGatherAdapter;
  callSid: string;
  llm: ReturnType<typeof vi.fn>;
  tenantId: string;
}

describe('#1014 row 2.5 — E1 life safety at the real handler (real Postgres)', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let proposalRepo: PgProposalRepository;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let customerRepo: PgCustomerRepository;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let tenantA: Seeded;
  let tenantB: Seeded;
  /** Distinct caller-ID per call: `handleAskCaller` find-or-creates by phone. */
  let phoneSeq = 0;

  async function seedTenant(ownerPhone: string): Promise<Seeded> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone)
       VALUES ($1, $2, 'E1 Test Shop', 'America/Chicago', 'TX', $3)`,
      [crypto.randomUUID(), t.tenantId, ownerPhone],
    );
    return { tenantId: t.tenantId, ownerUserId: t.userId };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    tenantA = await seedTenant('+15125550801');
    tenantB = await seedTenant('+15125550802');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /**
   * The scripted gateway routes on the skill the production code declares, so
   * one spy serves both LLM steps a booking call takes: `classify_intent` and
   * `confirm_intent`. Nothing else is stubbed.
   */
  function scriptedGateway() {
    return vi.fn().mockImplementation(async (req: Record<string, unknown>) => {
      const skill = (req.metadata as Record<string, unknown> | undefined)?.skill;
      return {
        content:
          skill === 'confirm_intent'
            ? JSON.stringify({ answer: 'yes', reasoning: 'clear affirmative' })
            : JSON.stringify({
                intentType: 'create_appointment',
                confidence: 0.95,
                extractedEntities: { dateTimeDescription: 'tomorrow at 9am' },
              }),
        model: 'stub',
        provider: 'stub',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    });
  }

  async function inboundCall(tenantId: string): Promise<Call> {
    const store = new VoiceSessionStore({ startInterval: false });
    const llm = scriptedGateway();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: { complete: llm },
      businessName: 'E1 Test Shop',
      publicBaseUrl: 'https://example.com',
      pool,
      userRepo,
      settingsRepo,
      auditRepo,
      proposalRepo,
      customerRepo,
      appointmentRepo,
      jobRepo,
    } as never);
    const callSid = `CA-2-5-${crypto.randomUUID().slice(0, 8)}`;
    phoneSeq += 1;
    const from = `+1512555${String(9000 + phoneSeq).slice(0, 4)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId });
    const session = store.findByCallSid(callSid)!;
    if (session.machine.currentState === 'greeting') {
      session.machine.dispatch({ type: 'greeted_ok' });
    }
    return { session, adapter, callSid, llm, tenantId };
  }

  const turn = (c: Call, speech: string): Promise<string> =>
    c.adapter.handleGather({
      sessionId: c.session.id,
      callSid: c.callSid,
      speechResult: speech,
      confidence: 0.95,
      tenantId: c.tenantId,
    });

  /**
   * Drive the real booking flow to a PERSISTED, still-live booking proposal:
   * the unknown caller identifies themselves, asks for an appointment, and
   * confirms the readback. Returns the real `proposals` row id.
   */
  async function bookThroughTheCall(c: Call): Promise<string> {
    if (c.session.machine.currentState === 'ask_caller') {
      await turn(c, 'Casey Rivera, 12 Oak Street');
    }
    await turn(c, 'I need an appointment tomorrow at 9am');
    expect(c.session.machine.currentState).toBe('intent_confirm');
    await turn(c, 'yes that is right');
    expect(c.session.proposalIds).toHaveLength(1);
    const id = c.session.proposalIds[0]!;
    const persisted = await proposalRepo.findById(c.tenantId, id);
    expect(persisted?.proposalType).toBe('create_appointment');
    expect(persisted?.status).toBe('draft');
    return id;
  }

  /**
   * The E1 branch runs the booking revocation and the tenant alert DETACHED
   * (twilio-adapter.ts:1732 — nothing slow may sit between the keyword hit
   * and the TwiML that speaks the 911 script), so the DB effect lands just
   * after `handleGather` resolves. Poll rather than sleep a fixed time.
   */
  async function waitFor<T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    label: string,
  ): Promise<T> {
    let last: T = await read();
    for (let i = 0; i < 50 && !ok(last); i += 1) {
      await new Promise((r) => {
        setTimeout(r, 40);
      });
      last = await read();
    }
    if (!ok(last)) throw new Error(`waitFor timed out: ${label}`);
    return last;
  }

  const sessionAudit = (tenantId: string, sessionId: string): Promise<AuditEvent[]> =>
    auditRepo.findByEntity(tenantId, 'voice_session', sessionId);

  const emergencyRow = (rows: AuditEvent[]): AuditEvent | undefined =>
    rows.find((e) => e.eventType.endsWith(EMERGENCY_EVENT_SUFFIX));

  it('ENGLISH: a gas leak is recognised with the LLM gateway DOWN — the call terminates on the life-safety path and the audit row carries tier E1', async () => {
    const c = await inboundCall(tenantA.tenantId);
    if (c.session.machine.currentState === 'ask_caller') {
      await turn(c, 'Casey Rivera, 12 Oak Street');
    }

    // "Before any AI thinks about it" needs BOTH halves, because either alone
    // is too weak (Codex review, PR #1054):
    //
    //   1. every gateway call rejects from here on — so the outcome cannot
    //      depend on a model answering; and
    //   2. the turn consults no model AT ALL for the decision. Rejection
    //      alone would not prove this: a handler that called the model,
    //      caught the rejection and fell back to the deterministic path
    //      would satisfy every other assertion in this test.
    //
    // The gateway IS called once during the turn, by the post-call summary
    // (`taskType: 'summarize_conversation'`) that `runSummary` fires after
    // the FSM has already terminated — it cannot influence the life-safety
    // decision, so it is the one call excluded below. Anything else,
    // classification above all, would be a model in the safety path.
    c.llm.mockRejectedValue(new Error('LLM gateway is down'));
    const llmCallsBefore = c.llm.mock.calls.length;
    const twiml = await turn(c, EN_GAS);

    const llmCallsDuring = c.llm.mock.calls.slice(llmCallsBefore);
    const nonSummaryCalls = llmCallsDuring.filter(
      ([req]) => (req as { taskType?: string })?.taskType !== 'summarize_conversation',
    );
    expect(nonSummaryCalls).toHaveLength(0);

    expect(c.session.machine.currentState).toBe('terminated');
    expect(c.session.machine.currentContext.escalationReason).toBe('life_safety_e1');
    // The caller is directed to 911 and the call is closed — no <Gather> for
    // another turn, no dispatcher bridge.
    expect(twiml).toContain('911');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Gather');

    // The durable record, read back out of Postgres through PgAuditRepository.
    const row = emergencyRow(await sessionAudit(tenantA.tenantId, c.session.id));
    expect(row).toBeDefined();
    expect(row?.metadata).toMatchObject({
      tier: 'E1',
      reason: 'life_safety_e1',
      keyword: 'smell gas',
    });

    // No classification ever ran on this call AT ALL: the ask_caller turn
    // does not classify, and the E1 turn was consumed by the deterministic
    // scan before the classify call could be reached.
    const classified = (await sessionAudit(tenantA.tenantId, c.session.id)).filter((e) =>
      e.eventType.endsWith(CLASSIFIED_EVENT_SUFFIX),
    );
    expect(classified).toHaveLength(0);
  });

  it('ENGLISH: it NEVER books — a booking drafted earlier in the call is revoked in real Postgres with its own audit row', async () => {
    const c = await inboundCall(tenantA.tenantId);
    const bookingId = await bookThroughTheCall(c);

    await turn(c, EN_GAS);

    // The real proposals row moved to rejected with the life-safety reason.
    const revoked = await waitFor(
      () => proposalRepo.findById(c.tenantId, bookingId),
      (p) => p?.status === 'rejected',
      'booking revoked',
    );
    expect(revoked?.status).toBe('rejected');
    expect(revoked?.rejectionReason).toBe('life_safety_emergency');

    // The revocation's own audit leg, read back through PgAuditRepository.
    const rows = await auditRepo.findByEntity(c.tenantId, 'proposal', bookingId);
    expect(rows.map((e) => e.eventType)).toContain(BOOKING_REVOKED_EVENT);
    const revokeRow = rows.find((e) => e.eventType === BOOKING_REVOKED_EVENT);
    expect(revokeRow?.metadata).toMatchObject({
      proposalType: 'create_appointment',
      fromStatus: 'draft',
      reason: 'life_safety_e1',
    });

    // …and nothing new was booked by the E1 turn itself: no second proposal,
    // and no appointment row exists for this call's job at all.
    expect(c.session.proposalIds).toHaveLength(1);
    const appts = await pool.query(
      `SELECT a.id FROM appointments a WHERE a.tenant_id = $1`,
      [c.tenantId],
    );
    expect(appts.rows).toHaveLength(0);
  });

  it("T1: tenant B's own E1 call revokes only tenant B's booking — tenant A's live booking is untouched", async () => {
    // Tenant A has a live booking from a perfectly ordinary call.
    const aCall = await inboundCall(tenantA.tenantId);
    const aBooking = await bookThroughTheCall(aCall);

    // Tenant B runs its OWN call: books, then reports a gas leak.
    const bCall = await inboundCall(tenantB.tenantId);
    const bBooking = await bookThroughTheCall(bCall);
    await turn(bCall, EN_GAS);

    await waitFor(
      () => proposalRepo.findById(tenantB.tenantId, bBooking),
      (p) => p?.status === 'rejected',
      "tenant B's booking revoked",
    );

    // Tenant A's booking is still live, and tenant A has no E1 audit row.
    const aAfter = await proposalRepo.findById(tenantA.tenantId, aBooking);
    expect(aAfter?.status).toBe('draft');
    const aEmergency = emergencyRow(await sessionAudit(tenantA.tenantId, aCall.session.id));
    expect(aEmergency).toBeUndefined();

    // Tenant B's revocation audit row exists ONLY under tenant B.
    const underB = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', bBooking);
    expect(underB.map((e) => e.eventType)).toContain(BOOKING_REVOKED_EVENT);
    const underA = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', bBooking);
    expect(underA).toHaveLength(0);
  });

  /**
   * GAP, PINNED — this test documents what the product does TODAY for a
   * Spanish gas-leak report. It is deliberately a passing characterization,
   * not an aspiration: see the file header. Read it together with the
   * `it.fails` below, which states the behaviour the row actually needs.
   */
  it('SPANISH — GAP (surfaced on #1014, NOT fixed here): "fuga de gas" classifies E2, so the E1 terminal path never runs', async () => {
    const c = await inboundCall(tenantB.tenantId);
    const bookingId = await bookThroughTheCall(c);

    const twiml = await turn(c, ES_GAS);

    // The keyword IS detected — as the E2 backstop, not E1.
    const row = emergencyRow(await sessionAudit(c.tenantId, c.session.id));
    expect(row).toBeDefined();
    expect(row?.metadata).toMatchObject({ keyword: 'fuga de gas' });
    // No tier is recorded, because the E2 branch does not stamp one.
    expect((row?.metadata as Record<string, unknown>).tier).toBeUndefined();

    // The consequences, all three of them:
    // 1. the call does NOT close on the life-safety script…
    expect(c.session.machine.currentState).not.toBe('terminated');
    expect(c.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
    // 2. …the caller hears the dispatcher-bridge copy instead of the
    //    evacuation direction ("leave the building…without using light
    //    switches"), and
    expect(twiml).not.toContain('leave the building');
    expect(twiml).toContain('on-call dispatcher');
    // 3. the booking drafted on this call is STILL LIVE.
    await new Promise((r) => {
      setTimeout(r, 600);
    });
    const booking = await proposalRepo.findById(c.tenantId, bookingId);
    expect(booking?.status).toBe('draft');
    const revokeRows = await auditRepo.findByEntity(c.tenantId, 'proposal', bookingId);
    expect(revokeRows.map((e) => e.eventType)).not.toContain(BOOKING_REVOKED_EVENT);
  });

  /**
   * DESIRED behaviour for the Spanish leg — NOT met today. Marked `.fails` so
   * the suite stays honest (no red CI for a defect this lane is forbidden to
   * fix) while still breaking loudly the day someone DOES fix it, which is
   * the signal to delete this test, promote the assertions into the English
   * test above, and re-grade row 2.5.
   *
   * Assertions are the exact English ones, in Spanish.
   */
  it.fails(
    'SPANISH — DESIRED (currently FAILS, see the GAP above): "fuga de gas" must reach the E1 terminal path and revoke the booking',
    async () => {
      const c = await inboundCall(tenantB.tenantId);
      const bookingId = await bookThroughTheCall(c);

      const twiml = await turn(c, ES_GAS);

      const row = emergencyRow(await sessionAudit(c.tenantId, c.session.id));
      expect(row?.metadata).toMatchObject({ tier: 'E1', reason: 'life_safety_e1' });
      expect(c.session.machine.currentState).toBe('terminated');
      expect(c.session.machine.currentContext.escalationReason).toBe('life_safety_e1');
      expect(twiml).toContain('<Hangup/>');

      const booking = await waitFor(
        () => proposalRepo.findById(c.tenantId, bookingId),
        (p) => p?.status === 'rejected',
        'spanish E1 booking revoked',
      );
      expect(booking?.rejectionReason).toBe('life_safety_emergency');
    },
  );
});
