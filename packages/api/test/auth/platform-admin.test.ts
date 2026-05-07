/**
 * P0-034 — requirePlatformAdmin middleware + grant/revoke audit.
 *
 * - 401 when not authenticated.
 * - 403 with { error: 'platform_admin_required' } when authenticated but
 *   not in the platform_admins set.
 * - Pass-through when present.
 * - grantPlatformAdmin and revokePlatformAdmin emit audit rows tagged
 *   metadata.actor_type='platform' and actorRole='platform'.
 * - PgPlatformAdminChecker caches lookups for ttlMs and re-queries after
 *   expiry.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import {
  InMemoryPlatformAdminChecker,
  PgPlatformAdminChecker,
  requirePlatformAdmin,
  grantPlatformAdmin,
  revokePlatformAdmin,
} from '../../src/auth/platform-admin';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function buildApp(opts: {
  authUserId?: string;
  authed: boolean;
  admins?: string[];
}): express.Express {
  const checker = new InMemoryPlatformAdminChecker(opts.admins ?? []);
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.authed) {
      (req as AuthenticatedRequest).auth = {
        userId: opts.authUserId ?? 'user-1',
        sessionId: 's',
        tenantId: 'tenant-1',
        role: 'owner',
      };
    }
    next();
  });
  app.get('/protected', requirePlatformAdmin(checker), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('P0-034 — requirePlatformAdmin middleware', () => {
  it('401 when no req.auth is present', async () => {
    const app = buildApp({ authed: false });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('403 with platform_admin_required when authenticated but missing', async () => {
    const app = buildApp({ authed: true, authUserId: 'user-1', admins: [] });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('platform_admin_required');
  });

  it('200 when present in platform_admins', async () => {
    const app = buildApp({ authed: true, authUserId: 'user-1', admins: ['user-1'] });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('503 fail-closed if the checker throws', async () => {
    const checker = {
      isPlatformAdmin: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 's',
        tenantId: 'tenant-1',
        role: 'owner',
      };
      next();
    });
    app.get('/protected', requirePlatformAdmin(checker), (_req, res) =>
      res.json({ ok: true })
    );
    const res = await request(app).get('/protected');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('platform_admin_check_failed');
  });

  it('503 message is generic — never echoes the underlying error string', async () => {
    // Suppress the expected console.error so the test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sensitive =
      'connection refused to postgres://admin:supersecret@10.0.0.5:5432/serviceos';
    const checker = {
      isPlatformAdmin: vi.fn(async () => {
        throw new Error(sensitive);
      }),
    };
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 's',
        tenantId: 'tenant-1',
        role: 'owner',
      };
      next();
    });
    app.get('/protected', requirePlatformAdmin(checker), (_req, res) =>
      res.json({ ok: true })
    );
    const res = await request(app).get('/protected');
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('platform-admin check failed');
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
    errSpy.mockRestore();
  });
});

// Lightweight Pool stub with just enough surface for our usage.
function makePoolStub(behavior: {
  selectRows?: Array<Array<Record<string, unknown>>>;
  insertRows?: Array<Array<Record<string, unknown>>>;
  deleteRowCounts?: number[];
}) {
  const selects = [...(behavior.selectRows ?? [])];
  const inserts = [...(behavior.insertRows ?? [])];
  const deletes = [...(behavior.deleteRowCounts ?? [])];
  let releases = 0;

  const client = {
    query: vi.fn(async (sql: string) => {
      const upper = sql.toUpperCase();
      if (upper.includes('INSERT INTO PLATFORM_ADMINS')) {
        const rows = inserts.shift() ?? [];
        return { rows, rowCount: rows.length };
      }
      if (upper.startsWith('DELETE FROM PLATFORM_ADMINS')) {
        const rowCount = deletes.shift() ?? 0;
        return { rows: [], rowCount };
      }
      if (upper.includes('FROM PLATFORM_ADMINS')) {
        const rows = selects.shift() ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: () => {
      releases++;
    },
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
  return { pool, client, getReleases: () => releases };
}

describe('P0-034 — PgPlatformAdminChecker (caching)', () => {
  it('caches positive results for ttlMs and skips re-query', async () => {
    const { pool, client } = makePoolStub({
      selectRows: [[{ user_id: 'u1' }]],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checker = new PgPlatformAdminChecker(pool as any, 60_000);

    expect(await checker.isPlatformAdmin('u1')).toBe(true);
    expect(await checker.isPlatformAdmin('u1')).toBe(true);
    // Only one query — second call hit the cache.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('caches negative results too', async () => {
    const { pool, client } = makePoolStub({
      selectRows: [[]],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checker = new PgPlatformAdminChecker(pool as any, 60_000);
    expect(await checker.isPlatformAdmin('u1')).toBe(false);
    expect(await checker.isPlatformAdmin('u1')).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a re-query', async () => {
    const { pool, client } = makePoolStub({
      selectRows: [[{ user_id: 'u1' }], [{ user_id: 'u1' }]],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checker = new PgPlatformAdminChecker(pool as any, 60_000);
    expect(await checker.isPlatformAdmin('u1')).toBe(true);
    checker.invalidate('u1');
    expect(await checker.isPlatformAdmin('u1')).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('returns false for an empty userId without querying', async () => {
    const { pool, client } = makePoolStub({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checker = new PgPlatformAdminChecker(pool as any);
    expect(await checker.isPlatformAdmin('')).toBe(false);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('cache is bounded — oldest entry evicted when maxEntries reached', async () => {
    // Cap = 2. Insert 3 distinct users → 3 misses, cache now holds the
    // last 2 ({u2, u3}). Re-querying u1 (the evicted one) must miss the
    // cache and trigger a 4th DB call. Re-querying u3 (still cached)
    // must NOT trigger another DB call.
    const { pool, client } = makePoolStub({
      selectRows: [[], [], [], []],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checker = new PgPlatformAdminChecker(pool as any, 60_000, 2);

    await checker.isPlatformAdmin('u1');
    await checker.isPlatformAdmin('u2');
    await checker.isPlatformAdmin('u3');
    expect(client.query).toHaveBeenCalledTimes(3);

    // u3 still cached — no new query.
    await checker.isPlatformAdmin('u3');
    expect(client.query).toHaveBeenCalledTimes(3);

    // u1 was evicted when u3 arrived — must re-query.
    await checker.isPlatformAdmin('u1');
    expect(client.query).toHaveBeenCalledTimes(4);
  });
});

describe('P0-034 — grantPlatformAdmin / revokePlatformAdmin (idempotent + audited)', () => {
  it('grant inserts + emits audit row with actor_type=platform', async () => {
    const insertedAt = new Date('2026-04-28T12:00:00Z');
    const { pool } = makePoolStub({
      insertRows: [[{ user_id: 'new-admin', granted_at: insertedAt }]],
    });
    const audit = new InMemoryAuditRepository();
    const result = await grantPlatformAdmin(pool as never, {
      userId: 'new-admin',
      grantedBy: 'granter-1',
      notes: 'bootstrap',
      auditTenantId: '00000000-0000-0000-0000-000000000001',
      auditRepo: audit,
    });
    expect(result.inserted).toBe(true);
    expect(result.userId).toBe('new-admin');

    const events = audit.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('platform_admin.granted');
    expect(events[0].actorRole).toBe('platform');
    expect(events[0].entityId).toBe('new-admin');
    expect(events[0].metadata?.actor_type).toBe('platform');
    expect(events[0].metadata?.idempotent_no_op).toBe(false);
  });

  it('grant is idempotent — second call yields inserted=false but still audits', async () => {
    const { pool } = makePoolStub({
      insertRows: [[]], // ON CONFLICT DO NOTHING -> 0 rows returned
    });
    const audit = new InMemoryAuditRepository();
    const result = await grantPlatformAdmin(pool as never, {
      userId: 'existing',
      grantedBy: 'granter-1',
      auditTenantId: '00000000-0000-0000-0000-000000000001',
      auditRepo: audit,
    });
    expect(result.inserted).toBe(false);
    expect(audit.getAll()).toHaveLength(1);
    expect(audit.getAll()[0].metadata?.idempotent_no_op).toBe(true);
  });

  it('revoke deletes + emits audit row with actor_type=platform', async () => {
    const { pool } = makePoolStub({ deleteRowCounts: [1] });
    const audit = new InMemoryAuditRepository();
    const result = await revokePlatformAdmin(pool as never, {
      userId: 'old-admin',
      revokedBy: 'granter-1',
      auditTenantId: '00000000-0000-0000-0000-000000000001',
      auditRepo: audit,
    });
    expect(result.removed).toBe(true);

    const events = audit.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('platform_admin.revoked');
    expect(events[0].actorRole).toBe('platform');
    expect(events[0].metadata?.actor_type).toBe('platform');
    expect(events[0].metadata?.was_present).toBe(true);
  });

  it('revoke on non-existent user audits with was_present=false', async () => {
    const { pool } = makePoolStub({ deleteRowCounts: [0] });
    const audit = new InMemoryAuditRepository();
    const result = await revokePlatformAdmin(pool as never, {
      userId: 'never-was',
      revokedBy: 'granter-1',
      auditTenantId: '00000000-0000-0000-0000-000000000001',
      auditRepo: audit,
    });
    expect(result.removed).toBe(false);
    expect(audit.getAll()[0].metadata?.was_present).toBe(false);
  });

  it('grant requires userId and grantedBy', async () => {
    const { pool } = makePoolStub({});
    await expect(
      grantPlatformAdmin(pool as never, {
        userId: '',
        grantedBy: 'g',
        auditTenantId: 't',
      })
    ).rejects.toThrow(/userId is required/);
    await expect(
      grantPlatformAdmin(pool as never, {
        userId: 'u',
        grantedBy: '',
        auditTenantId: 't',
      })
    ).rejects.toThrow(/grantedBy is required/);
  });

  it('grant rolls back the INSERT when the audit write fails', async () => {
    // Inspect all SQL the helper issues against the client. We expect
    // BEGIN -> INSERT -> ROLLBACK once the auditRepo throws, with no
    // COMMIT in between. The original audit error must propagate.
    const insertedAt = new Date('2026-04-28T12:00:00Z');
    const { pool, client } = makePoolStub({
      insertRows: [[{ user_id: 'new-admin', granted_at: insertedAt }]],
    });
    const failingAudit = {
      create: vi.fn(async () => {
        throw new Error('audit repo down');
      }),
      // Other AuditRepository methods aren't called by the helper.
    };

    await expect(
      grantPlatformAdmin(pool as never, {
        userId: 'new-admin',
        grantedBy: 'granter-1',
        auditTenantId: '00000000-0000-0000-0000-000000000001',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        auditRepo: failingAudit as any,
      })
    ).rejects.toThrow(/audit repo down/);

    const sql = client.query.mock.calls.map((c) => String(c[0]).trim().toUpperCase());
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('revoke rolls back the DELETE when the audit write fails', async () => {
    const { pool, client } = makePoolStub({ deleteRowCounts: [1] });
    const failingAudit = {
      create: vi.fn(async () => {
        throw new Error('audit repo down');
      }),
    };

    await expect(
      revokePlatformAdmin(pool as never, {
        userId: 'old-admin',
        revokedBy: 'granter-1',
        auditTenantId: '00000000-0000-0000-0000-000000000001',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        auditRepo: failingAudit as any,
      })
    ).rejects.toThrow(/audit repo down/);

    const sql = client.query.mock.calls.map((c) => String(c[0]).trim().toUpperCase());
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });
});
