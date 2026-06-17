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
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { registerTechStatusKeywords } from '../../src/sms/tech-status';
import { PgTechStatusTodayRepository } from '../../src/sms/tech-status/idempotency';
import {
  dispatchInboundSms,
  __resetKeywordRegistryForTests,
  type InboundSmsContext,
} from '../../src/sms/inbound-dispatch';

/**
 * U1 (P6-028) — drives a verified technician's "OUT" SMS end-to-end through the
 * REGISTERED keyword handler against real Postgres. This is the proof the
 * mocked handler unit test can't give: that tech_status_today + tech_unavailable
 * _blocks columns round-trip and that a real reschedule_appointment proposal
 * persists. The handler is registered exactly as app.ts wires it.
 */
describe('Postgres integration — tech-status "I\'m out" SMS (U1 / P6-028)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  const techId = '44444444-4444-4444-4444-444444444444';
  const techMobile = '+15551239001';
  const unknownMobile = '+15559990000';
  // Fixed clock: 2026-06-15T17:00:00Z == 13:00 America/New_York (EDT). The
  // tenant-local day is 2026-06-15, so the window is [17:00Z, 2026-06-16T04:00Z].
  const now = new Date('2026-06-15T17:00:00Z');

  let proposalRepo: PgProposalRepository;
  let unavailableRepo: PgUnavailableBlockRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);

    const settingsRepo = new PgSettingsRepository(pool);
    const userRepo = new PgUserRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const appointmentRepo = new PgAppointmentRepository(pool);
    const assignmentRepo = new PgAssignmentRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    unavailableRepo = new PgUnavailableBlockRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const techStatusTodayRepo = new PgTechStatusTodayRepository(pool);

    // Technician user with a registered mobile (Clerk-driven in prod, so we
    // insert directly — PgUserRepository has no create()). role='technician'
    // is the anti-spoof gate the handler enforces.
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, 'technician', $5)`,
      [techId, tenant.tenantId, techId, 'tech@example.com', techMobile],
    );

    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Acme Plumbing',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Jamie',
      lastName: 'Rivera',
      displayName: 'Jamie Rivera',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
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
      addressType: 'service',
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-1',
      summary: 'Leaky faucet',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    });

    // Appointment later the same tenant-local day (15:00 ET), assigned to the
    // technician, so the OUT triggers one reschedule proposal.
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: new Date('2026-06-15T19:00:00Z'),
      scheduledEnd: new Date('2026-06-15T20:00:00Z'),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    });
    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      appointmentId,
      technicianId: techId,
      isPrimary: true,
      assignedBy: tenant.userId,
      assignedAt: now,
    });

    // Register exactly as app.ts wires it. Reset first so this file owns the
    // module-level registry deterministically.
    __resetKeywordRegistryForTests();
    registerTechStatusKeywords(
      {
        userRepo,
        settingsRepo,
        unavailableBlockRepo: unavailableRepo,
        techStatusTodayRepo,
        rescheduleDeps: {
          appointmentRepo,
          assignmentRepo,
          proposalRepo,
          jobRepo,
          customerRepo,
          brandVoiceDeps: {
            gateway: createMockLLMGateway('Hi Jamie, we need to reschedule.').gateway,
            settingsRepo,
          },
        },
        auditRepo,
        now: () => now,
      },
      { overwrite: true },
    );
  });

  afterAll(async () => {
    __resetKeywordRegistryForTests();
    await closeSharedTestDb();
  });

  function inbound(overrides: Partial<InboundSmsContext>): InboundSmsContext {
    return {
      tenantId: tenant.tenantId,
      fromE164: techMobile,
      body: 'OUT',
      messageSid: `SM-${crypto.randomUUID()}`,
      ...overrides,
    };
  }

  it('routes a verified tech OUT → unavailable block + reschedule proposal + audit', async () => {
    const result = await dispatchInboundSms(inbound({ body: 'OUT' }));

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('tech-status');
    expect(result.reason).toBe('recorded');

    // tech_unavailable_blocks column round-trip (real Postgres).
    const blocks = await unavailableRepo.findByTechnician(tenant.tenantId, techId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].technicianId).toBe(techId);
    expect(blocks[0].startTime).toBeInstanceOf(Date);
    expect(blocks[0].endTime.getTime()).toBeGreaterThan(blocks[0].startTime.getTime());

    // A real reschedule_appointment proposal persisted, owner-gated. from-tech-out
    // advances it draft → ready_for_review so it surfaces as actionable in the
    // owner's review queue; it is NEVER auto-approved/executed (no sourceTrustTier),
    // so the human-approval gate (D-004) holds.
    const proposals = await proposalRepo.findByTenant(tenant.tenantId);
    const reschedules = proposals.filter(
      (p) => p.proposalType === 'reschedule_appointment',
    );
    expect(reschedules).toHaveLength(1);
    expect(reschedules[0].status).toBe('ready_for_review');

    // Audit emitted on the mutation.
    const audits = await auditRepo.findByEntity(tenant.tenantId, 'tech_status', techId);
    expect(audits.some((a) => a.eventType === 'tech_status.recorded')).toBe(true);
  });

  it('is idempotent — a second OUT the same tenant-local day is a no-op', async () => {
    const result = await dispatchInboundSms(inbound({ body: 'SICK' }));

    expect(result.handled).toBe(true);
    expect(result.reason).toBe('already_recorded');

    // Still exactly one block + one proposal (no duplicates).
    const blocks = await unavailableRepo.findByTechnician(tenant.tenantId, techId);
    expect(blocks).toHaveLength(1);
    const proposals = await proposalRepo.findByTenant(tenant.tenantId);
    expect(
      proposals.filter((p) => p.proposalType === 'reschedule_appointment'),
    ).toHaveLength(1);
  });

  it('anti-spoof — an OUT from an unregistered number is not actioned', async () => {
    const result = await dispatchInboundSms(
      inbound({ body: 'OUT', fromE164: unknownMobile }),
    );

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');
  });
});
