/**
 * #1033 — per-tenant `notifyTechniciansBySms`, pinned against REAL Postgres.
 *
 * The unit tests (test/appointments/assignment-notifications.test.ts) drive
 * the toggle and churn window through a stubbed settings reader; this file
 * proves the column (migration 289) exists with the right default, round-
 * trips through PgSettingsRepository, and that the notifier reading it via
 * the real repo suppresses the SMS while the in-app push still fires.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { TechnicianAssignmentNotifier } from '../../src/appointments/assignment-notifications';

describe('Postgres integration — notifyTechniciansBySms tenant setting (#1033)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  it('defaults ON for a new tenant and round-trips an OFF write', async () => {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);

    expect((await settingsRepo.findByTenant(tenant.tenantId))?.notifyTechniciansBySms).toBe(true);

    await settingsRepo.update(tenant.tenantId, { notifyTechniciansBySms: false });
    expect((await settingsRepo.findByTenant(tenant.tenantId))?.notifyTechniciansBySms).toBe(false);

    const { rows } = await pool.query(
      'SELECT notify_technicians_by_sms FROM tenant_settings WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    expect(rows).toEqual([{ notify_technicians_by_sms: false }]);
  });

  it('the notifier reads the real setting: OFF suppresses the SMS, push still fires', async () => {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await settingsRepo.update(tenant.tenantId, { notifyTechniciansBySms: false });

    const pushes: string[] = [];
    const texts: string[] = [];
    const notifier = new TechnicianAssignmentNotifier({
      appointmentRepo: {
        findById: async () =>
          ({
            id: 'appt',
            jobId: 'job',
            scheduledStart: new Date('2026-10-14T10:00:00Z'),
            timezone: 'UTC',
          }) as never,
      },
      jobRepo: { findById: async () => null },
      customerRepo: { findById: async () => null },
      userRepo: {
        findById: async () => ({ id: 'tech', clerkUserId: 'clerk-tech', mobileNumber: '+15555550100' }) as never,
      },
      notifier: {
        notifyUser: async (_t, userId) => {
          pushes.push(userId);
        },
      },
      smsSender: async ({ to }) => {
        texts.push(to);
      },
      settingsRepo,
    });

    await notifier.notifyChange({
      tenantId: tenant.tenantId,
      appointmentId: 'appt',
      technicianId: 'tech',
      kind: 'assigned',
    });
    expect(pushes).toEqual(['clerk-tech']);
    expect(texts).toEqual([]);

    await settingsRepo.update(tenant.tenantId, { notifyTechniciansBySms: true });
    await notifier.notifyChange({
      tenantId: tenant.tenantId,
      appointmentId: 'appt',
      technicianId: 'tech',
      kind: 'assigned',
    });
    expect(texts).toEqual(['+15555550100']);
  });
});
