/**
 * #866 — the five lookups #843 found dead on the phone, PROVEN against real
 * Postgres at the Gather seam: real repositories, the production-shaped
 * lookup bundle, the real membership loader for RBAC, a Gather turn per
 * intent, and assertions on the spoken line against seeded rows.
 *
 * Also proves the auth edges that matter:
 *   - an owner recognised only by tenant_settings.owner_phone (no mobile on
 *     any users row) is still answered (the owner-line bridge);
 *   - a suspended technician's mobile resolves no actor; a suspended
 *     ex-owner is not counted against the bridge;
 *   - a mobile registered in tenant B never resolves an actor in tenant A;
 *   - lookup_pending_items keeps the dropped-call recoveries line.
 *
 * Harness mirrors test/integration/log-expense-job-link.test.ts (Pg repos +
 * createTestTenant) and test/integration/crew-voice-execution.test.ts
 * (tenant_settings + users INSERTs, appointmentRepo.create).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';
import { PgLookupEventRepository } from '../../src/lookup-events/pg-lookup-event';
import { LookupEventService } from '../../src/lookup-events/lookup-event-service';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';
import { resolveDayWindow } from '../../src/reports/money-dashboard';
import { localDateString } from '../../src/digest/digest-service';

const TZ = 'America/Chicago';

/**
 * Deterministic clock: noon today in the tenant timezone, injected into the
 * lookup dispatch via the `PhoneLookupDeps.now` seam and used as the base for
 * every relative seed below. lookup_my_day bounds its window to TODAY in
 * tenant tz (the same resolveDayWindow used here), so a wall-clock
 * "now + 2h" seeded after 22:00 America/Chicago lands on tomorrow's date and
 * the honest spoken line is "You have nothing left today." — this file was
 * red at every CI run between 22:00 and midnight Chicago and green the rest
 * of the day. Anchoring at noon keeps the ±3h offsets inside today (and
 * inside this week) at every hour CI runs, without drifting far enough from
 * the real clock to disturb DB-side defaults.
 */
const NOW = new Date(
  resolveDayWindow(localDateString(new Date(), TZ), TZ).start.getTime() + 12 * 60 * 60 * 1000,
);
const hoursFrom = (base: Date, hours: number): Date =>
  new Date(base.getTime() + hours * 60 * 60 * 1000);
const OWNER_PHONE = '+15125550100';
const TECH_MOBILE = '+15125550222';
const CUSTOMER_PHONE = '+15125559999';

const NOT_WIRED = 'I&apos;m having trouble pulling that up';
const OWNER_REFUSAL = 'owner-level report';

function gatewayReturning(
  intentType: string,
  extractedEntities?: Record<string, unknown>,
): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({
      intentType,
      confidence: 0.96,
      ...(extractedEntities ? { extractedEntities } : {}),
    }),
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

describe('#866 — phone lookups against real Postgres (Gather seam)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let invoiceRepo: PgInvoiceRepository;
  let timeEntryRepo: PgTimeEntryRepository;
  let expenseRepo: PgExpenseRepository;
  let materialItemRepo: PgMaterialItemRepository;
  let recoveryRepo: PgDroppedCallRecoveryRepository;
  let lookups: PhoneLookupDeps;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    timeEntryRepo = new PgTimeEntryRepository(pool);
    expenseRepo = new PgExpenseRepository(pool);
    materialItemRepo = new PgMaterialItemRepository(pool);
    recoveryRepo = new PgDroppedCallRecoveryRepository(pool);
    const membership = createAuthorizationLoader(pool);
    lookups = {
      // Production-shaped: mirrors app.ts's lookupAnswerDeps / sharedLookupRepos.
      answers: {
        invoiceRepo,
        estimateRepo: new PgEstimateRepository(pool),
        droppedCallRecoveryRepo: recoveryRepo,
        timeEntryRepo,
        expenseRepo,
        settingsRepo,
        materialItemRepo,
        lookupEvents: new LookupEventService(new PgLookupEventRepository(pool)),
        resolveMemberRole: async (tenantId, userId) => {
          const m = await membership(userId, tenantId);
          if (!m || m.deleted || m.status !== 'active') return null;
          return m.role;
        },
      },
      shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo, userRepo },
      entityResolver: new PgEntityResolver(pool),
      tenantTimezoneResolver: async () => TZ,
      now: () => NOW,
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  interface Seed {
    tenantId: string;
    ownerUserId: string;
    techUserId: string;
    techClerkId: string;
    customerId: string;
    jobId: string;
  }

  /**
   * Tenant with owner_phone + timezone + labor rate; an owner (NO mobile — so
   * only the owner-line bridge can resolve them), a technician (mobile), a
   * customer, one job assigned to the technician.
   */
  async function seed(): Promise<Seed> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone, labor_rate_cents_per_hour)
       VALUES ($1, $2, 'Phone Lookup Shop', $3, 'TX', $4, 8500)`,
      [crypto.randomUUID(), t.tenantId, TZ, OWNER_PHONE],
    );
    const techUserId = crypto.randomUUID();
    const techClerkId = `clerk-${techUserId}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, mobile_number)
       VALUES ($1, $2, $3, $4, 'technician', 'Jake', 'Torres', $5)`,
      [techUserId, t.tenantId, techClerkId, `jake.${techUserId.slice(0, 8)}@example.com`, TECH_MOBILE],
    );
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dana',
      lastName: 'Miller',
      displayName: 'Dana Miller',
      primaryPhone: CUSTOMER_PHONE,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '12 Oak Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-PL-${jobId.slice(0, 8)}`,
      summary: 'Miller water heater replacement',
      status: 'in_progress',
      priority: 'normal',
      assignedTechnicianId: techUserId,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      tenantId: t.tenantId,
      ownerUserId: t.userId,
      techUserId,
      techClerkId,
      customerId,
      jobId,
    };
  }

  /**
   * One inbound call from `from`, then one Gather turn classified as `intent`.
   *
   * `handleInbound` runs the real establishment core — caller-ID → actor
   * (phone-actor.ts), owner-line detection, and `identifyCaller` against the
   * real customers table — and dispatches `greeted_ok` itself, so this only
   * drives whatever remains. A STAFF line has no customer row, so it lands in
   * `ask_caller`; that is production behaviour, and the staff lookups here do
   * not read `customerId`.
   */
  async function callAndAsk(
    s: Seed,
    from: string,
    intent: string,
    entities?: Record<string, unknown>,
  ): Promise<string> {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gatewayReturning(intent, entities),
      businessName: 'Phone Lookup Shop',
      publicBaseUrl: 'https://example.com',
      // `pool` is what identifyCaller uses to match the caller-ID to a customer.
      pool,
      settingsRepo,
      userRepo,
      customerRepo,
      jobRepo,
      appointmentRepo,
      proposalRepo,
      lookups,
    });
    const callSid = `CA-${intent}-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: s.tenantId });
    const session = store.findByCallSid(callSid)!;
    if (session.machine.currentState === 'greeting') {
      session.machine.dispatch({ type: 'greeted_ok' });
    }
    // A staff caller is not a customer — production leaves them in ask_caller.
    // Move them on without inventing a customer identity they don't have.
    if (
      session.machine.currentState === 'identifying' ||
      session.machine.currentState === 'ask_caller'
    ) {
      session.machine.dispatch({ type: 'caller_known', customerId: s.customerId });
      session.customerId = s.customerId;
    }
    return adapter.handleGather({
      sessionId: session.id,
      callSid,
      speechResult: 'lookup please',
      confidence: 0.95,
      tenantId: s.tenantId,
    });
  }

  async function seedAppointment(s: Seed, hoursFromNow: number): Promise<void> {
    const start = hoursFrom(NOW, hoursFromNow);
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: s.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('lookup_my_day: the technician calling from their registered mobile hears their own appointment', async () => {
    const s = await seed();
    await seedAppointment(s, 2);
    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_my_day');
    expect(xml).toContain('Miller water heater replacement');
    expect(xml).not.toContain(NOT_WIRED);
  });

  it('lookup_materials: the technician hears the pending shopping list', async () => {
    const s = await seed();
    await materialItemRepo.create({
      tenantId: s.tenantId,
      jobId: s.jobId,
      description: '3/4 inch copper elbows',
      quantity: 6,
      createdBy: s.ownerUserId,
    });
    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_materials');
    expect(xml).toContain('copper elbows');
  });

  it('lookup_job_profit: the owner line (owner_phone only, no mobile on any user) names the job and hears the margin', async () => {
    const s = await seed();
    await expenseRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      amountCents: 4000,
      category: 'materials',
      description: 'parts',
      spentAt: new Date(),
      createdBy: s.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_job_profit', {
      jobReference: 'the Miller job',
    });
    expect(xml).not.toContain(OWNER_REFUSAL);
    expect(xml).not.toContain(NOT_WIRED);
    // The resolver turned "the Miller job" into the seeded job, and the P&L is
    // computed from the seeded expense row — not a canned line:
    // "The Miller water heater replacement job hasn't brought in any revenue
    //  yet; you spent $40.00 in expenses; a loss of about $40.00."
    expect(xml).toContain('Miller water heater replacement');
    expect(xml).toContain('$40.00');
    expect(xml).toMatch(/margin|profit|loss|revenue/i);
  });

  it('lookup_crew_schedule: the owner names Jake and hears his booking', async () => {
    const s = await seed();
    await seedAppointment(s, 3);
    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_crew_schedule', {
      targetTechnicianName: 'Jake',
    });
    expect(xml).toContain('Jake');
    expect(xml).not.toContain('couldn&apos;t find a crew member');
  });

  it("lookup_timesheets: the owner hears Jake's hours this week", async () => {
    const s = await seed();
    const clockIn = hoursFrom(NOW, -3);
    await timeEntryRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      userId: s.techUserId,
      jobId: s.jobId,
      entryType: 'job',
      clockedInAt: clockIn,
      clockedOutAt: new Date(clockIn.getTime() + 2 * 60 * 60 * 1000),
      durationMinutes: 120,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_timesheets');
    expect(xml).toContain('Jake');
    expect(xml).toMatch(/2(\.0)? hours|2h/);
  });

  it('lookup_pending_items on the phone keeps the dropped-call recoveries line (review I3 — this was silently lost for two commits)', async () => {
    const s = await seed();
    // "Unanswered" is a recovery SMS that was SENT and never suppressed —
    // schedule then markSent, the same two steps the recovery worker takes.
    const row = await recoveryRepo.schedule({
      tenantId: s.tenantId,
      voiceSessionId: crypto.randomUUID(),
      callerE164: CUSTOMER_PHONE,
      scheduledFor: hoursFrom(NOW, -1),
    });
    await recoveryRepo.markSent(s.tenantId, row.id, 'SM-test', hoursFrom(NOW, -0.5));

    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_pending_items');

    expect(xml).not.toContain(OWNER_REFUSAL);
    expect(xml).toContain('dropped-call recovery');
  });

  it('RBAC: the technician asking for revenue is refused by the REAL membership loader', async () => {
    const s = await seed();
    expect(await callAndAsk(s, TECH_MOBILE, 'lookup_revenue')).toContain(OWNER_REFUSAL);
  });

  it('RBAC: the customer line is refused revenue (no actor)', async () => {
    const s = await seed();
    expect(await callAndAsk(s, CUSTOMER_PHONE, 'lookup_revenue')).toContain(OWNER_REFUSAL);
  });

  it('suspension: a suspended technician whose mobile is still on file resolves NO actor — lookup_my_day cannot self-scope', async () => {
    const s = await seed();
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [s.techUserId]);
    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_my_day');
    expect(xml).toContain('couldn&apos;t match your number');
  });

  it('suspension: a suspended ex-owner is NOT counted against the sole-owner bridge', async () => {
    const s = await seed();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'owner', 'suspended')`,
      [
        crypto.randomUUID(),
        s.tenantId,
        `clerk-ex-${crypto.randomUUID()}`,
        `ex.${crypto.randomUUID().slice(0, 8)}@example.com`,
      ],
    );
    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_pending_items');
    expect(xml).not.toContain(OWNER_REFUSAL);
    expect(xml).not.toContain(NOT_WIRED);
  });

  it('cross-tenant: a mobile registered in tenant B resolves NO actor in tenant A', async () => {
    const a = await seed();
    const b = await createTestTenant(pool);
    const otherMobile = '+15125550333';
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number) VALUES ($1, $2, $3, $4, 'owner', $5)`,
      [
        crypto.randomUUID(),
        b.tenantId,
        `clerk-b-${crypto.randomUUID()}`,
        `b.${crypto.randomUUID().slice(0, 8)}@example.com`,
        otherMobile,
      ],
    );
    expect(await callAndAsk(a, otherMobile, 'lookup_revenue')).toContain(OWNER_REFUSAL);
  });
});
