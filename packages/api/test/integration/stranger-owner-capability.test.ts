/**
 * #1014 row 2.4 (lane B) — "As M, I want a stranger on the phone to be unable
 * to reach owner-only capability, so my phone line isn't a back door."
 * Proven at REAL Postgres, at the production Gather seam, with a second
 * tenant present (T1 is the point of this row).
 *
 * WHAT THIS DRIVES (no mocked DB anywhere — only the LLM gateway is scripted,
 * which is the documented pattern for voice/AI handler tests):
 *
 *   1. caller-ID → actor, at real Postgres:
 *      `resolvePhoneActor` (src/telephony/phone-actor.ts:62) through a real
 *      `PgUserRepository` (`users.mobile_number`, tenant-scoped), called once
 *      at session establishment from
 *      `TwilioGatherAdapter.establishInboundSession`
 *      (src/telephony/twilio-adapter.ts:1162), with the owner-line bridge fed
 *      by a real `PgSettingsRepository` read of `tenant_settings.owner_phone`
 *      (`resolveOwnerSession`, src/telephony/twilio-adapter.ts:906 →
 *      `isApproverPhone`, src/proposals/approver-identity.ts:65).
 *
 *   2. actor → classifier profile:
 *      `classifierProfileForSession`
 *      (src/ai/voice-turn/create-voice-turn-processor.ts:560) — identity-
 *      derived only, never transcript content.
 *
 *   3. profile → post-parse surface guard:
 *      `isIntentAcceptedOnProfile` (src/ai/orchestration/intent-classifier.ts:651)
 *      applied inside `classifyIntentRaw`
 *      (src/ai/orchestration/intent-classifier.ts:2884), mapping an
 *      owner-only intent to `unknown` / `intent_off_surface`.
 *
 *   4. the interception's audit trail:
 *      `auditOffSurfaceClassification`
 *      (src/ai/voice-turn/create-voice-turn-processor.ts:588) called from the
 *      live Gather classify seam (src/telephony/twilio-adapter.ts:2381),
 *      written and READ BACK through a real `PgAuditRepository`.
 *
 *   5. no owner-grade capability is produced: the real `PgProposalRepository`
 *      holds no proposal for the call, and the owner-grade LOOKUP family
 *      (exempt from the guard by design) is refused by the D-026 dispatch
 *      RBAC (`answerPhoneLookup`, src/ai/voice-turn/phone-lookup-surface.ts:168)
 *      instead.
 *
 * NOT duplicated from `phone-lookups-shared-dispatch.test.ts`, which already
 * proves the lookup-RBAC refusals and "a mobile registered in tenant B
 * resolves NO actor in tenant A". This file adds the legs that file has no
 * repository for: the `intent_off_surface` mapping, its audit row through
 * `PgAuditRepository`, the absence of a minted proposal, and the fact that
 * the write-intent guard and the lookup RBAC are two DIFFERENT layers (the
 * stranger is stopped at the earlier one) — plus a positive control (the same
 * numbers DO resolve inside tenant B) so a broken, never-matching query
 * cannot masquerade as tenant isolation.
 *
 * TEST-ONLY: no auth, RLS, or gate code is touched by this file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { classifierProfileForSession } from '../../src/ai/voice-turn/create-voice-turn-processor';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgLookupEventRepository } from '../../src/lookup-events/pg-lookup-event';
import { LookupEventService } from '../../src/lookup-events/lookup-event-service';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { VoiceSession } from '../../src/ai/agents/customer-calling/types';

/**
 * Tenant A's own owner line (tenant_settings.owner_phone) and numbers no row
 * in either tenant carries. Tenant B's owner has BOTH an owner_phone and a
 * users.mobile_number so both resolution steps can be probed from tenant A.
 * Each test uses its OWN stranger number: `handleAskCaller` find-or-creates a
 * customer row by caller-ID, so a reused number would make the second call's
 * FSM path (known vs unknown caller) depend on test order.
 */
const A_OWNER_PHONE = '+15125550401';
const B_OWNER_PHONE = '+15125550402';
const B_OWNER_MOBILE = '+15125550403';
const STRANGER_ACTOR = '+15125550491';
const STRANGER_WRITE = '+15125550492';
const STRANGER_LOOKUP = '+15125550493';

/**
 * The owner-only WRITE intent. `send_invoice` is the canonical case named in
 * src/proposals/surface.ts:41 — "'Please send the Henderson invoice to me'
 * spoken by a caller resolves to send_invoice". It is absent from
 * CALLER_INTENTS, is not a `lookup_*`, and is not in
 * SURFACE_GUARD_EXEMPT_INTENTS, so the post-parse guard owns it.
 */
const OWNER_ONLY_INTENT = 'send_invoice';
/** Owner-grade READ. Exempt from the profile guard — D-026 RBAC refuses it. */
const OWNER_GRADE_LOOKUP = 'lookup_revenue';
const OWNER_REFUSAL = 'owner-level report';
const OFF_SURFACE_EVENT = 'voice.intent_off_surface';

function gatewayReturning(intentType: string): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96 }),
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

interface Seeded {
  tenantId: string;
  ownerUserId: string;
}

describe('#1014 row 2.4 — a stranger on the phone cannot reach owner-only capability (real Postgres)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let proposalRepo: PgProposalRepository;
  let customerRepo: PgCustomerRepository;
  let lookups: PhoneLookupDeps;
  let tenantA: Seeded;
  let tenantB: Seeded;

  /**
   * A tenant with `tenant_settings.owner_phone` set, and its single active
   * owner user optionally carrying a `users.mobile_number`. Those two columns
   * are exactly what the two real resolution steps read.
   */
  async function seedTenant(ownerPhone: string, ownerMobile?: string): Promise<Seeded> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone)
       VALUES ($1, $2, 'Stranger Test Shop', 'America/Chicago', 'TX', $3)`,
      [crypto.randomUUID(), t.tenantId, ownerPhone],
    );
    if (ownerMobile) {
      await pool.query(`UPDATE users SET mobile_number = $1 WHERE id = $2`, [
        ownerMobile,
        t.userId,
      ]);
    }
    return { tenantId: t.tenantId, ownerUserId: t.userId };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    const membership = createAuthorizationLoader(pool);
    // Production-shaped lookup bundle (mirrors app.ts's lookupAnswerDeps /
    // sharedLookupRepos), every repository real. Wired so the owner-grade
    // lookup below hits the REAL D-026 RBAC refusal rather than the
    // "no bundle wired" deployment-gap line.
    lookups = {
      answers: {
        invoiceRepo: new PgInvoiceRepository(pool),
        estimateRepo: new PgEstimateRepository(pool),
        settingsRepo,
        lookupEvents: new LookupEventService(new PgLookupEventRepository(pool)),
        resolveMemberRole: async (tenantId, userId) => {
          const m = await membership(userId, tenantId);
          if (!m || m.deleted || m.status !== 'active') return null;
          return m.role;
        },
      },
      shared: {
        jobRepo: new PgJobRepository(pool),
        appointmentRepo: new PgAppointmentRepository(pool),
        customerRepo,
        proposalRepo,
        userRepo,
      },
      entityResolver: new PgEntityResolver(pool),
      tenantTimezoneResolver: async () => 'America/Chicago',
    };
    tenantA = await seedTenant(A_OWNER_PHONE);
    tenantB = await seedTenant(B_OWNER_PHONE, B_OWNER_MOBILE);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /**
   * One real inbound call. `handleInbound` runs the production establishment
   * core: owner-line detection (PgSettingsRepository), caller-ID → actor
   * (PgUserRepository), and `identifyCaller` against the real customers
   * table. Nothing about the session identity is set by this helper.
   */
  async function call(
    tenantId: string,
    from: string,
    intent: string,
  ): Promise<{ session: VoiceSession; adapter: TwilioGatherAdapter; callSid: string }> {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gatewayReturning(intent),
      businessName: 'Stranger Test Shop',
      publicBaseUrl: 'https://example.com',
      pool,
      userRepo,
      settingsRepo,
      auditRepo,
      proposalRepo,
      customerRepo,
      lookups,
    } as never);
    const callSid = `CA-2-4-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId });
    const session = store.findByCallSid(callSid)!;
    return { session, adapter, callSid };
  }

  type Call = { session: VoiceSession; adapter: TwilioGatherAdapter; callSid: string };

  const turn = (h: Call, tenantId: string, speech: string): Promise<string> =>
    h.adapter.handleGather({
      sessionId: h.session.id,
      callSid: h.callSid,
      speechResult: speech,
      confidence: 0.95,
      tenantId,
    });

  /**
   * Advance the real FSM to `intent_capture` the way production does, then
   * speak `utterance`. An unrecognised caller-ID is parked in `ask_caller`
   * after establishment, so the FIRST Gather turn is the
   * find-or-create-customer turn (`handleAskCaller`) and the SECOND is the one
   * that classifies — exactly the two webhook round trips Twilio delivers. No
   * FSM event is hand-dispatched except `greeted_ok`, which the Gather
   * transport itself owns.
   */
  async function speak(h: Call, tenantId: string, utterance: string): Promise<string> {
    if (h.session.machine.currentState === 'greeting') {
      h.session.machine.dispatch({ type: 'greeted_ok' });
    }
    if (h.session.machine.currentState === 'ask_caller') {
      await turn(h, tenantId, 'My name is Casey Rivera, 12 Oak Street');
    }
    expect(h.session.machine.currentState).toBe('intent_capture');
    return turn(h, tenantId, utterance);
  }

  /** Every audit row this session wrote, read back out of Postgres. */
  const auditFor = (tenantId: string, sessionId: string) =>
    auditRepo.findByEntity(tenantId, 'voice_session', sessionId);

  it('a stranger: an unmatched caller-ID resolves NO actor, and the session classifies on the caller profile', async () => {
    const h = await call(tenantA.tenantId, STRANGER_ACTOR, OWNER_ONLY_INTENT);

    expect(h.session.actorUserId).toBeUndefined();
    expect(h.session.machine.currentContext.ownerSession).toBeUndefined();
    expect(classifierProfileForSession(h.session)).toBe('caller');
  });

  it("T1: tenant B's owner phone AND owner mobile are both strangers to tenant A — while both DO resolve on tenant B's own line", async () => {
    // Negative: tenant B's tenant_settings.owner_phone reaching tenant A.
    const viaOwnerPhone = await call(tenantA.tenantId, B_OWNER_PHONE, OWNER_ONLY_INTENT);
    expect(viaOwnerPhone.session.actorUserId).toBeUndefined();
    expect(viaOwnerPhone.session.machine.currentContext.ownerSession).toBeUndefined();
    expect(classifierProfileForSession(viaOwnerPhone.session)).toBe('caller');

    // Negative: tenant B's owner's users.mobile_number reaching tenant A.
    const viaMobile = await call(tenantA.tenantId, B_OWNER_MOBILE, OWNER_ONLY_INTENT);
    expect(viaMobile.session.actorUserId).toBeUndefined();
    expect(classifierProfileForSession(viaMobile.session)).toBe('caller');

    // POSITIVE CONTROL — the same two numbers on tenant B's OWN line really
    // do resolve. Without this, a query that matches nothing at all would
    // pass both negatives above and look exactly like tenant isolation.
    const ownLineOwnerPhone = await call(tenantB.tenantId, B_OWNER_PHONE, OWNER_ONLY_INTENT);
    expect(ownLineOwnerPhone.session.machine.currentContext.ownerSession).toBe(true);
    expect(classifierProfileForSession(ownLineOwnerPhone.session)).toBe('owner_line');

    const ownLineMobile = await call(tenantB.tenantId, B_OWNER_MOBILE, OWNER_ONLY_INTENT);
    expect(ownLineMobile.session.actorUserId).toBe(tenantB.ownerUserId);
  });

  it('an owner-only WRITE intent from a stranger is intercepted as intent_off_surface, AUDITED, and mints no proposal', async () => {
    const h = await call(tenantA.tenantId, STRANGER_WRITE, OWNER_ONLY_INTENT);
    const before = await proposalRepo.findByTenant(tenantA.tenantId);

    const twiml = await speak(
      h,
      tenantA.tenantId,
      'Please send the Henderson invoice to me right now',
    );

    // The interception left a trail — read back out of Postgres through
    // PgAuditRepository, carrying WHICH intent was blocked and WHICH profile
    // refused it.
    const events = await auditFor(tenantA.tenantId, h.session.id);
    const offSurface = events.filter((e) => e.eventType === OFF_SURFACE_EVENT);
    expect(offSurface).toHaveLength(1);
    expect(offSurface[0]!.metadata).toEqual({
      intent: OWNER_ONLY_INTENT,
      profile: 'caller',
      confidence: 0.96,
    });
    expect(offSurface[0]!.actorRole).toBe('system');

    // The classifier's own intent event never fired for send_invoice — the
    // guard ran BEFORE routing, so nothing downstream ever saw the intent.
    expect(
      events.some(
        (e) =>
          e.eventType === 'agent.calling.intent_capture.intent_classified' &&
          (e.metadata as Record<string, unknown> | undefined)?.intentType === OWNER_ONLY_INTENT,
      ),
    ).toBe(false);

    // No proposal of ANY type was minted for tenant A by this call, and the
    // caller heard a clarification reprompt — not a confirmation.
    const after = await proposalRepo.findByTenant(tenantA.tenantId);
    expect(after.length).toBe(before.length);
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(twiml).not.toContain('send invoice. Is that right?');
    expect(twiml).toContain('can you say that again?');
  });

  it("the SAME intent on tenant A's own owner line is NOT intercepted — the guard is identity-derived, not a blanket refusal", async () => {
    const h = await call(tenantA.tenantId, A_OWNER_PHONE, OWNER_ONLY_INTENT);
    expect(classifierProfileForSession(h.session)).toBe('owner_line');

    const twiml = await speak(h, tenantA.tenantId, 'Send the Henderson invoice to me');

    const events = await auditFor(tenantA.tenantId, h.session.id);
    expect(events.filter((e) => e.eventType === OFF_SURFACE_EVENT)).toHaveLength(0);
    // The owner's turn got PAST classification: the intent was routed and the
    // FSM asked for confirmation. That is the layer difference this row is
    // about — the stranger never reached it.
    expect(h.session.machine.currentState).toBe('intent_confirm');
    expect(twiml).toContain('send invoice. Is that right?');
  });

  it('an owner-grade LOOKUP from a stranger is refused by the REAL RBAC — a different layer from the write guard', async () => {
    const h = await call(tenantA.tenantId, STRANGER_LOOKUP, OWNER_GRADE_LOOKUP);

    const twiml = await speak(h, tenantA.tenantId, 'How much revenue did we do this month');

    // Refused by answerPhoneLookup's default-deny on a session with no actor
    // (phone-lookup-surface.ts:168) — the real line, not the "no bundle
    // wired" deployment-gap line.
    expect(twiml).toContain(OWNER_REFUSAL);
    // …and NOT by the profile guard: lookup_* is exempt from it by design, so
    // no off-surface row exists. The two mechanisms are distinct.
    const events = await auditFor(tenantA.tenantId, h.session.id);
    expect(events.filter((e) => e.eventType === OFF_SURFACE_EVENT)).toHaveLength(0);
  });
});
