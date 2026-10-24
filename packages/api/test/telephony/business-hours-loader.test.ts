/**
 * loadTenantBusinessHours — the tenant_settings read behind the inbound
 * /voice after-hours fork and /api/analytics/voice-roi runs under the tenant's
 * own context (raw-pg audit 2026-10-23 §4 P1.3): the request client when one is
 * ambient for the tenant, otherwise one short tenant transaction. Real columns
 * and the RLS role are pinned in test/integration/telephony-tenant-context.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  businessHoursFromSettings,
  isAfterHours,
  isTenantAfterHours,
  loadTenantBusinessHours,
} from '../../src/telephony/business-hours-loader';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '00000000-0000-4000-8000-0000000b0005';
const ROW = { business_hours: { mon: { open: '08:00', close: '17:00' } }, timezone: 'America/Chicago' };

function settingsPool(rows: unknown[]) {
  return fakeTenantPool((sql) => (sql.includes('FROM tenant_settings') ? { rows } : undefined));
}

describe('loadTenantBusinessHours', () => {
  it('reads in a tenant transaction on one checkout: BEGIN, the tenant GUC, the SELECT, COMMIT', async () => {
    const fake = settingsPool([ROW]);

    expect(await loadTenantBusinessHours(fake.pool, TENANT)).toEqual({
      timezone: 'America/Chicago',
      schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }],
    });

    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    expect(fake.statements.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
    expect(fake.statements[1]).toMatchObject({
      sql: expect.stringContaining("set_config('app.current_tenant_id'"),
      values: [TENANT],
    });
    expect(fake.work()).toEqual([
      expect.objectContaining({ sql: expect.stringContaining('WHERE tenant_id = $1'), values: [TENANT] }),
    ]);
  });

  it("inside a request scoped to the same tenant, reads on the request's client and takes no checkout", async () => {
    const fake = settingsPool([]);
    const requestQuery = vi.fn(async () => ({ rows: [ROW] }));
    const client = { query: requestQuery } as unknown as PoolClient;

    const hours = await tenantContextStore.run({ client, tenantId: TENANT }, () =>
      loadTenantBusinessHours(fake.pool, TENANT),
    );

    expect(hours?.timezone).toBe('America/Chicago');
    expect(fake.checkouts()).toBe(0);
    expect(requestQuery).toHaveBeenCalledOnce();
  });

  it('no settings row → null; a row without a timezone falls back to America/New_York', async () => {
    expect(await loadTenantBusinessHours(settingsPool([]).pool, TENANT)).toBeNull();
    expect(await loadTenantBusinessHours(settingsPool([{ ...ROW, timezone: null }]).pool, TENANT)).toMatchObject({
      timezone: 'America/New_York',
    });
  });

  it('isTenantAfterHours: closed outside the schedule, never after hours without one', async () => {
    const sunday = new Date('2026-10-25T18:00:00Z');
    expect(await isTenantAfterHours(settingsPool([ROW]).pool, TENANT, sunday)).toBe(true);
    expect(await isTenantAfterHours(settingsPool([]).pool, TENANT, sunday)).toBe(false);
  });
});

describe('businessHoursFromSettings / isAfterHours (the gate reads the row itself)', () => {
  it('maps one tenant_settings row the same way the loader does', () => {
    expect(businessHoursFromSettings(ROW)).toEqual({
      timezone: 'America/Chicago',
      schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }],
    });
    expect(businessHoursFromSettings({ business_hours: {}, timezone: 'UTC' })).toBeNull();
    expect(businessHoursFromSettings({ ...ROW, timezone: null })?.timezone).toBe('America/New_York');
  });

  it('isAfterHours: outside the schedule is after hours; no schedule never is', () => {
    const config = businessHoursFromSettings(ROW);
    expect(isAfterHours(config, new Date('2026-10-25T18:00:00Z'))).toBe(true); // a Sunday
    expect(isAfterHours(config, new Date('2026-10-26T15:00:00Z'))).toBe(false); // Monday 10:00 Chicago
    expect(isAfterHours(null, new Date())).toBe(false);
  });
});
