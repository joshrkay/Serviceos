/**
 * Codex P2 on #1810 — PUT /api/settings must not restore a backup another
 * save has replaced, against real Postgres through the request transaction.
 *
 * B3-3 accepts a backupSupervisorUserId sent back unchanged without the
 * active-member and role checks (a deactivated or legacy technician backup
 * must not block saving other fields). "Unchanged" is decided by reading the
 * stored row, and the save is a later statement. The save still wrote the
 * value it was sent, so a request that re-sent backup A with a routing change
 * and was overtaken by a save making B the backup committed A over B,
 * unchecked: a suspended member was the backup again.
 *
 * The race is made deterministic by pausing the first request's write (after
 * its read and check) until the second request has committed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createSettingsRouter } from '../../src/routes/settings';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

/** Holds the next write until the test releases it. */
class PausedWriteSettingsRepository extends PgSettingsRepository {
  private pause: { reached: () => void; released: Promise<void> } | null = null;

  /** Resolves `atWrite` when the next update() starts; it runs once `release` is called. */
  pauseNextWrite(): { atWrite: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    this.pause = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
    return { atWrite, release };
  }

  override async update(...args: Parameters<PgSettingsRepository['update']>) {
    const pause = this.pause;
    this.pause = null;
    if (pause) {
      pause.reached();
      await pause.released;
    }
    return super.update(...args);
  }
}

describe('Postgres integration — an unchanged backup cannot restore a replaced one (Codex P2, #1810)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let settingsRepo: PausedWriteSettingsRepository;
  let app: express.Express;

  async function makeDispatcher(): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, status)
       VALUES ($1, $2, $3, $4, 'dispatcher', 'Lane', 'Backup', 'active')`,
      [id, tenant.tenantId, `clerk_${id}`, `backup_${id}@example.com`],
    );
    return id;
  }

  async function stored(): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT backup_supervisor_user_id, unsupervised_proposal_routing FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    settingsRepo = new PausedWriteSettingsRepository(pool);
    app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        canonicalUserId: tenant.userId,
        sessionId: 'sess-unchanged-backup-race',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/settings',
      createSettingsRouter(settingsRepo, undefined, new PgAuditRepository(pool), undefined, undefined, {
        userRepo: new PgUserRepository(pool),
      }),
    );
  });

  it('a save that re-sent suspended backup A keeps B, made backup while it was in flight, and saves its routing', async () => {
    const backupA = await makeDispatcher();
    const backupB = await makeDispatcher();
    const set = await request(app).put('/api/settings').send({ backupSupervisorUserId: backupA });
    expect(set.status).toBe(200);
    await pool.query(`UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND id = $2`, [
      tenant.tenantId,
      backupA,
    ]);

    // Tab 1 loaded the section while A was the backup and sends A back with a
    // routing change. It reads A as stored (so it skips the checks) and is
    // held at its write.
    const { atWrite, release } = settingsRepo.pauseNextWrite();
    const tabOne = request(app)
      .put('/api/settings')
      .send({ backupSupervisorUserId: backupA, unsupervisedProposalRouting: 'queue_only' })
      .then((res) => res);
    await atWrite;

    // Tab 2 makes B the backup and commits.
    const tabTwo = await request(app).put('/api/settings').send({ backupSupervisorUserId: backupB });
    expect(tabTwo.status).toBe(200);
    expect(await stored()).toMatchObject({ backup_supervisor_user_id: backupB });

    release();
    const res = await tabOne;
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({
      backup_supervisor_user_id: backupB,
      unsupervised_proposal_routing: 'queue_only',
    });

    const { rows: audits } = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'settings.tenant.updated'
        ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(audits.map((r) => r.metadata)).toEqual([
      { changedKeys: ['backupSupervisorUserId'] },
      { changedKeys: ['backupSupervisorUserId'] },
      { changedKeys: ['unsupervisedProposalRouting'] },
    ]);
  });
});
