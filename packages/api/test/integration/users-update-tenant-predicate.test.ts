/**
 * #1092 — SECURITY: `PgUserRepository.update` must be scoped to the tenant.
 *
 * The defect: `update()` (src/users/pg-user.ts) ran
 *   `UPDATE users SET … WHERE id = $N AND deleted_at IS NULL`
 * with NO `tenant_id` predicate, while every sibling method in the same file
 * (`findById`, `findByMobileNumber`, `setMobileNumber`, `softDeleteSelf`,
 * `restoreAccount`, `demoteOwnerIfAnotherExists`) carries `AND tenant_id = $N`.
 * It backs `PATCH /api/users/:id`, gated only by
 * `requirePermission('users:edit_role')` — a permission every owner holds in
 * their OWN tenant — so any owner could change any user's role in ANY tenant.
 *
 * WHAT THIS DRIVES (no mocked DB anywhere):
 *   (a) THE HOLE, at the real API: a real `createApp()` boot against real
 *       Postgres, tenant A's owner session PATCHing tenant B's owner id.
 *   (b) the same at the repository seam: `PgUserRepository.update(A, userOfB)`.
 *   (c) control: A's owner PATCHing A's OWN dispatcher still works and audits
 *       (read back through the real `PgAuditRepository`).
 *   (d) the tenant-scoped last-owner guard still refuses within the tenant.
 *
 * WHY THE LEGS PIN `RLS_RUNTIME_ROLE` EXPLICITLY.
 * `users` carries an RLS policy (`tenant_isolation_users`, migration
 * `002_create_users` in src/db/schema.ts, ENABLE + FORCE via migration 130),
 * but RLS only ENFORCES when the connection drops into the least-privilege
 * `rls_app_runtime` role — which the app does only when `RLS_RUNTIME_ROLE=true`
 * (src/db/rls-runtime-role.ts). So the hole legs below run with the runtime
 * role OFF: that is the configuration in which the application-layer predicate
 * is the ONLY defense, which is precisely the defense-in-depth contract this
 * repository file states for itself, and the configuration every hermetic
 * e2e/api path runs under. Each hole leg is then REPEATED with the runtime
 * role ON, so the fix is proven not to depend on RLS and RLS is proven not to
 * be the only thing holding the line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AppWithLifecycle } from '../../src/app';

/** Unsigned JWT accepted by the DEV_AUTH_BYPASS middleware (dev-only path). */
function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

function bearerFor(clerkSub: string): string {
  return `Bearer ${unsignedJwt({
    sub: clerkSub,
    sid: `sess-${clerkSub}`,
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

/**
 * Run `fn` with `RLS_RUNTIME_ROLE` pinned. `isRlsRuntimeRoleEnabled()` reads
 * `process.env` at query time (a deliberate raw read — see its doc comment), so
 * toggling around a request is honored by the already-booted app.
 */
async function withRlsRuntimeRole(value: 'true' | 'false', fn: () => Promise<void>): Promise<void> {
  const prev = process.env.RLS_RUNTIME_ROLE;
  process.env.RLS_RUNTIME_ROLE = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.RLS_RUNTIME_ROLE;
    else process.env.RLS_RUNTIME_ROLE = prev;
  }
}

describe('#1092 — PgUserRepository.update is scoped to the tenant', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let userRepo: PgUserRepository;
  let auditRepo: PgAuditRepository;
  let tenantA: { tenantId: string; userId: string };
  /**
   * One FRESH victim tenant per hole leg. Sharing a single victim across the
   * legs would make every leg after the first depend on the previous one
   * having left the row intact — so on the unfixed code the later legs fail on
   * their own pre-condition instead of on the hole, and the RED output stops
   * saying anything about them. Each leg gets its own untouched tenant B.
   */
  const victims: Record<string, { tenantId: string; userId: string }> = {};
  let dispatcherOfA: string;
  let prevEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    // Two live tenants, each with exactly one owner. `createTestTenant` sets
    // `tenants.owner_id` AND `users.clerk_user_id` to the same UUID, which is
    // what the dev-auth-bypass tenant lookup (findByOwner) keys on — so the
    // bearer token's `sub` below resolves to the seeded tenant rather than
    // bootstrapping a fresh one.
    tenantA = await createTestTenant(pool);
    for (const key of ['route-rls-off', 'route-rls-on', 'repo-rls-off', 'repo-rls-on']) {
      victims[key] = await createTestTenant(pool);
    }

    // A second, non-owner member of tenant A — the positive control's target.
    dispatcherOfA = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [dispatcherOfA, tenantA.tenantId, dispatcherOfA, `dispatcher-${dispatcherOfA}@example.com`, 'dispatcher'],
    );

    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      DATABASE_URL: process.env.DATABASE_URL,
      DB_SSL: process.env.DB_SSL,
      RLS_RUNTIME_ROLE: process.env.RLS_RUNTIME_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.DATABASE_URL = process.env.TEST_DB_URL;
    process.env.DB_SSL = 'false';

    // Imported dynamically so the module graph is loaded AFTER the env above
    // is in place (createApp + config read it at construction time).
    const { resetConfig } = await import('../../src/shared/config');
    const { createApp } = await import('../../src/app');
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    // Evidence hook (opt-in): write the fixture ids out so a run against a
    // KEPT container can be dumped afterwards (`SELECT tenant_id, id, role
    // FROM users …`). No-op in CI, where the container is ephemeral.
    if (process.env.FIXTURE_DUMP_PATH) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        process.env.FIXTURE_DUMP_PATH,
        JSON.stringify({ tenantA, dispatcherOfA, victims }, null, 2),
      );
    }
    await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  // ───────────────────────────── (a) THE HOLE ─────────────────────────────

  for (const rlsRole of ['false', 'true'] as const) {
    it(`(a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=${rlsRole}]`, async () => {
      await withRlsRuntimeRole(rlsRole, async () => {
        const tenantB = victims[`route-rls-${rlsRole === 'true' ? 'on' : 'off'}`];
        const before = await pool.query(`SELECT role, updated_at FROM users WHERE id = $1`, [
          tenantB.userId,
        ]);
        expect(before.rows[0].role).toBe('owner');
        const auditBefore = await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1`,
          [tenantB.tenantId],
        );

        const res = await request(app)
          .patch(`/api/users/${tenantB.userId}`)
          .set('Authorization', bearerFor(tenantA.userId))
          .send({ role: 'dispatcher' });

        // A foreign user id is indistinguishable from an unknown one: 404,
        // exactly as for an unknown id inside the caller's own tenant.
        expect(res.status).toBe(404);

        // Raw read-back: tenant B's row is untouched (role AND updated_at —
        // a write that landed and was rolled back would still bump the stamp
        // only if it committed, so both are asserted).
        const after = await pool.query(`SELECT role, updated_at FROM users WHERE id = $1`, [
          tenantB.userId,
        ]);
        expect(after.rows[0].role).toBe('owner');
        expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);

        // No audit row lands under tenant B.
        const auditAfter = await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1`,
          [tenantB.tenantId],
        );
        expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
      });
    });

    // ────────────────────── (b) the repository seam ──────────────────────

    it(`(b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=${rlsRole}]`, async () => {
      await withRlsRuntimeRole(rlsRole, async () => {
        const tenantB = victims[`repo-rls-${rlsRole === 'true' ? 'on' : 'off'}`];
        const before = await pool.query(
          `SELECT role, first_name, updated_at FROM users WHERE id = $1`,
          [tenantB.userId],
        );
        expect(before.rows[0].role).toBe('owner');

        const updated = await userRepo.update(tenantA.tenantId, tenantB.userId, {
          role: 'dispatcher',
          firstName: 'Pwned',
        });
        expect(updated).toBeNull();

        const after = await pool.query(
          `SELECT role, first_name, updated_at FROM users WHERE id = $1`,
          [tenantB.userId],
        );
        expect(after.rows[0].role).toBe('owner');
        expect(after.rows[0].first_name).toBe(before.rows[0].first_name);
        expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
      });
    });
  }

  // ─────────────────────────── (c) the control ───────────────────────────

  it("(c) control — A's owner PATCHing A's own dispatcher still succeeds and audits", async () => {
    await withRlsRuntimeRole('false', async () => {
      const res = await request(app)
        .patch(`/api/users/${dispatcherOfA}`)
        .set('Authorization', bearerFor(tenantA.userId))
        .send({ role: 'technician', firstName: 'Dana' });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('technician');
      expect(res.body.tenantId).toBe(tenantA.tenantId);

      const row = await pool.query(`SELECT role, first_name, tenant_id FROM users WHERE id = $1`, [
        dispatcherOfA,
      ]);
      expect(row.rows[0].role).toBe('technician');
      expect(row.rows[0].first_name).toBe('Dana');
      expect(row.rows[0].tenant_id).toBe(tenantA.tenantId);

      // The audit row is read back through the REAL repository, under tenant A.
      const events = await auditRepo.findByEntity(tenantA.tenantId, 'user', dispatcherOfA);
      expect(events.some((e) => e.eventType === 'user.updated')).toBe(true);
    });
  });

  // ──────────────────── (d) the last-owner guard holds ────────────────────

  it('(d) the tenant-scoped last-owner guard still refuses a demotion within the tenant', async () => {
    await withRlsRuntimeRole('false', async () => {
      // tenantA's owner is its ONLY owner (the seeded dispatcher was demoted
      // to technician above, and was never an owner).
      const res = await request(app)
        .patch(`/api/users/${tenantA.userId}`)
        .set('Authorization', bearerFor(tenantA.userId))
        .send({ role: 'dispatcher' });

      expect(res.status).toBe(400);

      const row = await pool.query(`SELECT role FROM users WHERE id = $1`, [tenantA.userId]);
      expect(row.rows[0].role).toBe('owner');
    });
  });
});
