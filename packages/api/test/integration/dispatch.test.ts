import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { getDispatchBoardData } from '../../src/dispatch/board-query';
import { PgDispatchAnalyticsRepository } from '../../src/dispatch/pg-analytics';
import { captureDispatchEvent } from '../../src/dispatch/analytics';

describe('Postgres integration — dispatch', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
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
      customerId: customerId,
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
      customerId: customerId,
      locationId: locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('Dispatch board', () => {
    it('queries dispatch board data for a date', async () => {
      const today = new Date().toISOString().split('T')[0];
      const boardData = await getDispatchBoardData(
        tenant.tenantId,
        today,
        { appointmentRepo, assignmentRepo },
        'America/Chicago'
      );

      expect(boardData).not.toBeNull();
      expect(boardData.technicianLanes).toBeDefined();
      expect(boardData.unassignedAppointments).toBeDefined();
      expect(boardData.summary).toBeDefined();
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access to board data', async () => {
      const otherTenant = await createTestTenant(pool);
      const today = new Date().toISOString().split('T')[0];

      const boardData = await getDispatchBoardData(
        otherTenant.tenantId,
        today,
        { appointmentRepo, assignmentRepo },
        'America/Chicago'
      );

      expect(boardData.unassignedAppointments.length).toBe(0);
    });
  });

  describe('dispatch analytics event types', () => {
    // Regression: the crew feature emits 'crew_added'/'crew_removed', which
    // must be permitted by the dispatch_analytics.event_type CHECK constraint
    // (migration 120). A real INSERT is the only thing that exercises the
    // constraint — the in-memory repo accepts any string.
    it('records crew_added and crew_removed without violating the CHECK constraint', async () => {
      const analyticsRepo = new PgDispatchAnalyticsRepository(pool);

      const added = await captureDispatchEvent(analyticsRepo, tenant.tenantId, 'crew_added', {
        appointmentId: crypto.randomUUID(),
        technicianId: crypto.randomUUID(),
      });
      const removed = await captureDispatchEvent(analyticsRepo, tenant.tenantId, 'crew_removed', {
        appointmentId: crypto.randomUUID(),
        technicianId: crypto.randomUUID(),
      });

      expect(added.eventType).toBe('crew_added');
      expect(removed.eventType).toBe('crew_removed');

      const crewAdded = await analyticsRepo.getMetricsByType(tenant.tenantId, 'crew_added');
      const crewRemoved = await analyticsRepo.getMetricsByType(tenant.tenantId, 'crew_removed');
      expect(crewAdded.length).toBeGreaterThanOrEqual(1);
      expect(crewRemoved.length).toBeGreaterThanOrEqual(1);
    });
  });
});