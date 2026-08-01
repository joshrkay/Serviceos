/**
 * Foundation gate (spec/RIVET_FOUNDATION_SPEC.md) — DB-level pins that mocks
 * cannot provide:
 *
 *  F3  — the `no_double_booking` EXCLUDE constraint actually exists in the
 *        migrated database (the schema bootstrap deliberately skips it with a
 *        RAISE WARNING on legacy-overlap databases, so presence must be
 *        verified, not assumed), and `findMissingCriticalConstraints` — the
 *        loud post-migration check — agrees.
 *  V17 — Critical scheduling settings propagate: values written through the
 *        real PgSettingsRepository are observed by slot generation via the
 *        same `schedulingConfigFromSettings` seam the routes use. Read-after-
 *        write proves storage; these tests prove the downstream operation
 *        changes behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { findMissingCriticalConstraints } from '../../src/db/migrate';
import {
  findBookableSlots,
  schedulingConfigFromSettings,
} from '../../src/scheduling/booking-availability';

const DAY = '2099-06-15';
const ALL_WEEK = (open: string, close: string) =>
  Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open, close }]),
  );

describe('Postgres integration — foundation gates (F3, V17)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Read settings through the real repo and derive finder inputs the way the routes do. */
  async function slotsFromStoredSettings(): Promise<string[]> {
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    const config = schedulingConfigFromSettings(settings);
    const slots = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      {
        tenantId: tenant.tenantId,
        fromDate: DAY,
        toDate: DAY,
        timezone: config.timezone ?? 'UTC',
        durationMin: 60,
        weeklyHours: config.weeklyHours,
        bufferMinutes: config.bufferMinutes,
        maxSlots: 20,
      },
    );
    return slots.map((s) => s.start.toISOString());
  }

  describe('F3 — double-booking exclusion is enforced at the database level', () => {
    it('the no_double_booking EXCLUDE constraint is present on appointment_assignments', async () => {
      const result = await pool.query(
        `SELECT con.contype, rel.relname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
          WHERE con.conname = 'no_double_booking'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].relname).toBe('appointment_assignments');
      // contype 'x' = exclusion constraint — the structural guarantee, not a
      // trigger or application check.
      expect(result.rows[0].contype).toBe('x');
    });

    it('findMissingCriticalConstraints reports nothing missing on a migrated database', async () => {
      const client = await pool.connect();
      try {
        expect(await findMissingCriticalConstraints(client)).toEqual([]);
      } finally {
        client.release();
      }
    });
  });

  describe('V17 — Critical settings propagate to slot generation', () => {
    it('business-hours change moves the offered windows (change-then-observe)', async () => {
      await settingsRepo.update(tenant.tenantId, {
        timezone: 'UTC',
        businessHours: ALL_WEEK('08:00', '17:00'),
      });
      const before = await slotsFromStoredSettings();
      expect(before).toContain(`${DAY}T08:00:00.000Z`);

      await settingsRepo.update(tenant.tenantId, {
        businessHours: ALL_WEEK('13:00', '17:00'),
      });
      const after = await slotsFromStoredSettings();
      expect(after).not.toContain(`${DAY}T08:00:00.000Z`);
      expect(after[0]).toBe(`${DAY}T13:00:00.000Z`);
    });

    it('timezone change shifts the same wall-clock hours to different UTC instants', async () => {
      await settingsRepo.update(tenant.tenantId, {
        timezone: 'America/New_York',
        businessHours: ALL_WEEK('08:00', '17:00'),
      });
      const eastern = await slotsFromStoredSettings();
      // 08:00 EDT (June) = 12:00Z
      expect(eastern[0]).toBe(`${DAY}T12:00:00.000Z`);

      await settingsRepo.update(tenant.tenantId, { timezone: 'America/Phoenix' });
      const phoenix = await slotsFromStoredSettings();
      // 08:00 MST (no DST, year-round UTC-7) = 15:00Z
      expect(phoenix[0]).toBe(`${DAY}T15:00:00.000Z`);
    });

    it('job_buffer_minutes change alters slot adjacency around a booked visit', async () => {
      await settingsRepo.update(tenant.tenantId, {
        timezone: 'UTC',
        businessHours: ALL_WEEK('08:00', '17:00'),
        jobBufferMinutes: 0,
      });
      // Busy 12:00–13:00 UTC, seeded through the real repos (same pattern as
      // dispatch-availability.test.ts) so RLS/tenant context is respected.
      const customerId = crypto.randomUUID();
      await new PgCustomerRepository(pool).create({
        id: customerId,
        tenantId: tenant.tenantId,
        firstName: 'Buf',
        lastName: 'Customer',
        displayName: 'Buf Customer',
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const locationId = crypto.randomUUID();
      await new PgLocationRepository(pool).create({
        id: locationId,
        tenantId: tenant.tenantId,
        customerId,
        street1: '1 Main St',
        city: 'Town',
        state: 'AZ',
        postalCode: '85001',
        country: 'USA',
        isPrimary: true,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const jobId = crypto.randomUUID();
      await new PgJobRepository(pool).create({
        id: jobId,
        tenantId: tenant.tenantId,
        customerId,
        locationId,
        jobNumber: `JOB-${jobId.slice(0, 6)}`,
        summary: 'Buffer test visit',
        status: 'scheduled',
        priority: 'normal',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: new Date(`${DAY}T12:00:00.000Z`),
        scheduledEnd: new Date(`${DAY}T13:00:00.000Z`),
        timezone: 'UTC',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Parameters<typeof appointmentRepo.create>[0]);

      const noBuffer = await slotsFromStoredSettings();
      expect(noBuffer).toContain(`${DAY}T11:00:00.000Z`); // back-to-back allowed
      expect(noBuffer).toContain(`${DAY}T13:00:00.000Z`);

      await settingsRepo.update(tenant.tenantId, { jobBufferMinutes: 60 });
      const buffered = await slotsFromStoredSettings();
      expect(buffered).not.toContain(`${DAY}T11:00:00.000Z`);
      expect(buffered).not.toContain(`${DAY}T13:00:00.000Z`);
      expect(buffered).toContain(`${DAY}T14:00:00.000Z`); // one clear hour after
    });
  });
});
