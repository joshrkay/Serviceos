import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import { resolveOwnerLineApprover } from '../../src/ai/voice-turn/shared/owner-session';
import { resolvePhoneActor } from '../../src/telephony/phone-actor';

/**
 * B4-1 — a backup supervisor's line is authorised as that backup, against real
 * Postgres.
 *
 * Call establishment (`TwilioGatherAdapter.establishInboundSession`) runs two
 * caller-ID lookups: `resolveOwnerLineApprover` recognises the owner line
 * (tenant_settings.owner_phone / backup_supervisor_user_id, the backup's
 * users.mobile_number compared with normalizePhone), then `resolvePhoneActor`
 * picks the subject every lookup is authorised by. The actor lookup matched
 * users.mobile_number exactly, so a backup whose stored mobile is in another
 * format ('(512) 555-0111', a row written before the E.164 rule) was
 * recognised as the backup, missed, and bridged to the tenant's single OWNER.
 *
 * Pins, through the real repositories, the same composition establishment
 * runs: the backup gets their own subject; a backup line naming no teammate
 * gets nobody, never the owner; the owner phone keeps its bridge.
 */
describe('Postgres integration — B4-1: a backup line is authorised as the backup, never the owner', () => {
  const OWNER_PHONE = '+15125550100';
  const CALLER_ID = '+15125550111';

  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let userRepo: PgUserRepository;

  /** A tenant whose single owner has no profile mobile, and a backup stored with `backupMobile`. */
  async function seedTenant(backupMobile: string, role: 'technician' | 'dispatcher' = 'technician') {
    const tenant = await createTestTenant(pool);
    const backupId = crypto.randomUUID();
    const backupSubject = `clerk-backup-${backupId}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [backupId, tenant.tenantId, backupSubject, `backup-${backupId}@example.com`, role, backupMobile],
    );
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone, backup_supervisor_user_id)
       VALUES ($1, $2, 'Backup Line Co', 'America/Chicago', 'TX', $3, $4)`,
      [crypto.randomUUID(), tenant.tenantId, OWNER_PHONE, backupId],
    );
    // createTestTenant's owner: clerk_user_id = the row id.
    return { tenantId: tenant.tenantId, ownerSubject: tenant.userId, backupSubject };
  }

  /** Establishment's two lookups, in its order, with the real repositories. */
  async function establish(tenantId: string, from: string) {
    const line = await resolveOwnerLineApprover({ settingsRepo, userRepo }, tenantId, from);
    const actor = await resolvePhoneActor({ userRepo }, tenantId, from, line);
    return { line, actor };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    userRepo = new PgUserRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it.each(['(512) 555-0111', '15125550111'])(
    'a backup stored as %s is recognised and authorised as themselves',
    async (stored) => {
      const t = await seedTenant(stored);

      const { line, actor } = await establish(t.tenantId, CALLER_ID);

      expect(line).toMatchObject({ role: 'technician', via: 'backup_supervisor', userId: t.backupSubject });
      expect(actor).toEqual({ userId: t.backupSubject, via: 'mobile' });
    },
  );

  it('a backup line whose number two teammates both hold resolves nobody, never the owner', async () => {
    const t = await seedTenant('(512) 555-0111');
    const otherId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, 'technician', '512.555.0111')`,
      [otherId, t.tenantId, `clerk-other-${otherId}`, `other-${otherId}@example.com`],
    );

    const { line, actor } = await establish(t.tenantId, CALLER_ID);

    expect(line).toMatchObject({ via: 'backup_supervisor', userId: t.backupSubject });
    expect(actor).toBeNull();
  });

  it('the owner phone still bridges to the single owner', async () => {
    const t = await seedTenant('(512) 555-0111');

    const { line, actor } = await establish(t.tenantId, OWNER_PHONE);

    expect(line).toMatchObject({ role: 'owner', via: 'owner_phone' });
    expect(actor).toEqual({ userId: t.ownerSubject, via: 'owner_phone' });
  });
});
