import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import { PgTechStatusTodayRepository } from '../../src/sms/tech-status/idempotency';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { registerTechStatusKeywords } from '../../src/sms/tech-status';
import {
  dispatchInboundSms,
  __resetKeywordRegistryForTests,
  InboundSmsContext,
} from '../../src/sms/inbound-dispatch';
import { TechStatusKeywordHandler } from '../../src/sms/tech-status/keyword-router';
import { TECH_STATUS_KEYWORDS } from '@ai-service-os/shared';

/**
 * P6-028 — end-to-end Postgres integration test for the tech "I'm out today"
 * SMS keyword path. This drives the REAL inbound dispatcher
 * (`dispatchInboundSms`) — the same seam the Twilio webhook calls — through the
 * `registerTechStatusKeywords` registration, and asserts against real Postgres
 * that:
 *   • an unavailable block + reschedule proposal(s) are persisted, and
 *   • an audit event is emitted.
 * A non-technician sender is asserted to be a no-op (handled:false, no writes).
 *
 * The unit test (test/sms/tech-status/handler.test.ts) covers the handler with
 * mocked repos; this pins the wiring + the real columns (the entity-resolver
 * lesson in CLAUDE.md: a mocked Pool can hide nonexistent columns).
 */

const TZ = 'America/New_York';
// 15:00Z on 2026-06-15 is 11:00 ET, before the seeded appointments.
const NOW = new Date('2026-06-15T15:00:00Z');
const TECH_MOBILE = '+15125550101';

describe('Postgres integration — tech-status SMS (P6-028)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let unavailableBlockRepo: PgUnavailableBlockRepository;
  let techStatusTodayRepo: PgTechStatusTodayRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;

  let tenant: { tenantId: string; userId: string };
  let techId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    unavailableBlockRepo = new PgUnavailableBlockRepository(pool);
    techStatusTodayRepo = new PgTechStatusTodayRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    const appointmentRepo = new PgAppointmentRepository(pool);
    const assignmentRepo = new PgAssignmentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    tenant = await createTestTenant(pool);

    // Tenant timezone so tenant-local "today" math is deterministic.
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Test Co',
      timezone: TZ,
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A technician with a registered mobile (FK target for blocks / claims).
    techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [techId, tenant.tenantId, techId, 'tech@example.com', 'technician'],
    );
    await userRepo.setMobileNumber(tenant.tenantId, techId, TECH_MOBILE);

    // A customer + location + job so the reschedule path can resolve a
    // customer name for the brand-voice draft.
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Jamie',
      lastName: 'Rivera',
      displayName: 'Jamie Rivera',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Two remaining appointments today, both after NOW (11:00 ET).
    for (const [start, end] of [
      ['2026-06-15T18:00:00Z', '2026-06-15T19:00:00Z'],
      ['2026-06-15T20:00:00Z', '2026-06-15T21:00:00Z'],
    ] as const) {
      const apptId = crypto.randomUUID();
      await appointmentRepo.create({
        id: apptId,
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(end),
        timezone: TZ,
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await assignmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        appointmentId: apptId,
        technicianId: techId,
        isPrimary: true,
        assignedBy: tenant.userId,
        assignedAt: new Date(),
      });
    }

    // Register the handler on the real (module-global) registry, exactly as
    // createApp() does, then drive the dispatcher.
    __resetKeywordRegistryForTests();
    const mock = createMockLLMGateway();
    mock.provider.setDefaultResponse(
      'Hi Jamie — we need to reschedule today. Reply to pick a new time.',
    );
    registerTechStatusKeywords(
      {
        userRepo,
        settingsRepo,
        unavailableBlockRepo,
        techStatusTodayRepo,
        auditRepo,
        now: () => NOW,
        rescheduleDeps: {
          appointmentRepo,
          assignmentRepo,
          proposalRepo,
          jobRepo,
          customerRepo,
          brandVoiceDeps: { gateway: mock.gateway, settingsRepo },
        },
      },
      { overwrite: true },
    );
  });

  afterAll(async () => {
    __resetKeywordRegistryForTests();
    await closeSharedTestDb();
  });

  function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
    return {
      tenantId: tenant.tenantId,
      fromE164: TECH_MOBILE,
      body: 'OUT',
      messageSid: 'SM' + Math.random().toString(36).slice(2),
      ...overrides,
    };
  }

  it('claims the OUT/SICK/UNAVAILABLE keywords on registration', () => {
    const handler = new TechStatusKeywordHandler({} as never);
    expect([...handler.keywords].sort()).toEqual([...TECH_STATUS_KEYWORDS].sort());
    // The keywords the handler advertises are what the dispatcher routes.
    expect(handler.keywords).toContain('out');
    expect(handler.keywords).toContain('sick');
    expect(handler.keywords).toContain('unavailable');
  });

  it('tech "OUT" via dispatchInboundSms → block + reschedule proposals + audit (real Postgres)', async () => {
    const result = await dispatchInboundSms(ctx({ body: 'OUT' }));

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('tech-status');
    expect(result.reason).toBe('recorded');

    // 1. The same-day unavailable block landed.
    const blocks = await unavailableBlockRepo.findByTechnician(tenant.tenantId, techId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe('out');

    // 2. The idempotency claim is recorded for today's tenant-local date.
    const claim = await techStatusTodayRepo.findToday(
      tenant.tenantId,
      techId,
      '2026-06-15',
    );
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('out');

    // 3. One owner-gated reschedule proposal per remaining appointment, NEVER
    //    auto-executed — they land in 'ready_for_review' awaiting human approval.
    const proposals = await proposalRepo.findByStatus(tenant.tenantId, 'ready_for_review');
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.proposalType === 'reschedule_appointment')).toBe(true);
    // The brand-voice customer SMS draft rides in sourceContext for owner review.
    expect(proposals.every((p) => typeof p.sourceContext?.draftSms === 'string')).toBe(true);
    // None auto-approved / executed.
    expect(
      await proposalRepo.findByStatus(tenant.tenantId, 'approved'),
    ).toHaveLength(0);
    expect(
      await proposalRepo.findByStatus(tenant.tenantId, 'executed'),
    ).toHaveLength(0);

    // 4. An audit event was emitted for the recorded status.
    const audits = await auditRepo.findByEntity(tenant.tenantId, 'tech_status', techId);
    expect(audits.some((a) => a.eventType === 'tech_status.recorded')).toBe(true);
  });

  it('non-technician sender → handled:false, no writes', async () => {
    // A fresh tenant so the OUT-day claim/block from the prior test can't leak.
    const other = await createTestTenant(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: other.tenantId,
      businessName: 'Other Co',
      timezone: TZ,
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The owner from createTestTenant gets a mobile; owners are NOT technicians.
    const ownerMobile = '+15125559999';
    await userRepo.setMobileNumber(other.tenantId, other.userId, ownerMobile);

    const result = await dispatchInboundSms(
      ctx({ tenantId: other.tenantId, fromE164: ownerMobile, body: 'OUT' }),
    );

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');

    // No block, no claim, no proposal written for the owner.
    expect(
      await unavailableBlockRepo.findByTechnician(other.tenantId, other.userId),
    ).toHaveLength(0);
    expect(
      await techStatusTodayRepo.findToday(other.tenantId, other.userId, '2026-06-15'),
    ).toBeNull();
    expect(
      await proposalRepo.findByStatus(other.tenantId, 'ready_for_review'),
    ).toHaveLength(0);
    // It DID record the anti-spoofing rejection audit (a non-mutation diagnostic).
    const audits = await auditRepo.findByEntity(other.tenantId, 'tech_status', other.userId);
    expect(audits.some((a) => a.eventType === 'tech_status.unverified_mobile')).toBe(true);
  });
});
