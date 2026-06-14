import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { EmergencyDispatchExecutionHandler } from '../../src/proposals/execution/emergency-dispatch-handler';
import type { Proposal } from '../../src/proposals/proposal';
import type { SettingsRepository } from '../../src/settings/settings';

/**
 * RV-141 hold — proves the emergency_dispatch handler persists a real held
 * appointment row through Postgres (real findBookableSlots + real
 * hold_pending_approval / hold_expiry_at columns), not just against mocks.
 */
describe('Postgres integration — emergency_dispatch appointment hold (RV-141)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Emergency',
      lastName: 'Caller',
      displayName: 'Emergency Caller',
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function settingsStub(): SettingsRepository {
    return {
      findByTenant: async () => ({
        ownerPhone: '+15125550999',
        businessName: 'Acme Plumbing',
        timezone: 'America/Chicago',
      }),
    } as unknown as SettingsRepository;
  }

  it('places a real held appointment row on the soonest feasible slot', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const sent: Array<{ to: string; body: string }> = [];
    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      {
        sendSms: async (m) => {
          sent.push({ to: m.to, body: m.body });
          return {};
        },
      },
      auditRepo,
      appointmentRepo,
      undefined,
    );

    const proposal: Proposal = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      proposalType: 'emergency_dispatch',
      status: 'approved',
      payload: {
        intent: 'emergency_dispatch',
        entities: {
          emergencyDescription: 'gas leak in the basement',
          detectedKeywords: ['gas leak'],
          customerId,
        },
      },
      summary: 'Emergency dispatch',
      createdBy: 'calling-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await handler.execute(proposal, {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();

    const jobId = result.resultEntityId!;
    const job = await jobRepo.findById(tenant.tenantId, jobId);
    expect(job?.priority).toBe('urgent');

    // Pin the real hold columns round-trip through Postgres.
    const appts = await appointmentRepo.findByJob(tenant.tenantId, jobId);
    expect(appts).toHaveLength(1);
    expect(appts[0].holdPendingApproval).toBe(true);
    expect(appts[0].holdExpiryAt).toBeInstanceOf(Date);
    expect(appts[0].holdExpiryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(appts[0].status).toBe('scheduled');
    expect(appts[0].jobId).toBe(jobId);

    // Owner page named the held slot.
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('Held');
  });
});
