import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';

describe('Postgres integration — appointments', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
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

    jobId = crypto.randomUUID();
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

  describe('CRUD', () => {
    it('creates appointment and retrieves via findById', async () => {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 3600000);

      const appointment = await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        scheduledStart: startTime,
        scheduledEnd: endTime,
        timezone: 'America/Chicago',
        status: 'scheduled',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await appointmentRepo.findById(tenant.tenantId, appointment.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('scheduled');
      expect(found!.jobId).toBe(jobId);
    });

    it('updates appointment and reflects in findById', async () => {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 3600000);

      const appointment = await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        scheduledStart: startTime,
        scheduledEnd: endTime,
        timezone: 'America/Chicago',
        status: 'scheduled',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await appointmentRepo.update(tenant.tenantId, appointment.id, {
        status: 'confirmed',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('confirmed');

      const found = await appointmentRepo.findById(tenant.tenantId, appointment.id);
      expect(found!.status).toBe('confirmed');
    });

    it('finds appointments by job', async () => {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 3600000);

      await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        scheduledStart: startTime,
        scheduledEnd: endTime,
        timezone: 'America/Chicago',
        status: 'scheduled',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const appointments = await appointmentRepo.findByJob(tenant.tenantId, jobId);
      expect(appointments.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 3600000);

      const appointment = await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        scheduledStart: startTime,
        scheduledEnd: endTime,
        timezone: 'America/Chicago',
        status: 'scheduled',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await appointmentRepo.findById(otherTenant.tenantId, appointment.id);
      expect(found).toBeNull();
    });
  });
});