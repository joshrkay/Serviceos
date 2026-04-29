/**
 * P0-034 — Platform-admin authority.
 *
 * `platform_admins` is a cross-tenant authority table: a row here grants
 * the user the right to mutate global resources (e.g. the feature-flag
 * registry). It is intentionally NOT tenant-scoped and has no RLS — the
 * source of truth is the database row, not a JWT claim, so the gate
 * cannot be forged by minting a token.
 *
 * - `requirePlatformAdmin(checker)` is Express-style middleware.
 * - 401 = not authenticated; 403 = authenticated but not a platform-admin.
 * - Results are cached in-memory for 60s keyed by user_id (small set,
 *   simple TTL-on-read eviction).
 *
 * Grants/revokes go through `grantPlatformAdmin` / `revokePlatformAdmin`
 * helpers which write through `pg_base.withClient()` (cross-tenant) and
 * emit an audit event with `actor_type='platform'` in metadata.
 */
import type { Pool } from 'pg';
import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthenticatedRequest } from './clerk';
import {
  AuditRepository,
  createAuditEvent,
} from '../audit/audit';

export interface PlatformAdminChecker {
  isPlatformAdmin(userId: string): Promise<boolean>;
  /** Drop a single user from the cache (used after grant/revoke). */
  invalidate?(userId: string): void;
}

/**
 * In-memory checker — useful for tests and for the dev/in-memory build
 * path where there is no Postgres pool.
 */
export class InMemoryPlatformAdminChecker implements PlatformAdminChecker {
  private admins: Set<string>;

  constructor(initial: string[] = []) {
    this.admins = new Set(initial);
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    return this.admins.has(userId);
  }

  invalidate(_userId: string): void {
    // no-op for in-memory; kept for interface symmetry
  }

  grant(userId: string): void {
    this.admins.add(userId);
  }

  revoke(userId: string): void {
    this.admins.delete(userId);
  }
}

/**
 * Postgres-backed checker. Uses `withClient()` (no tenant GUC) because
 * `platform_admins` is intentionally cross-tenant. Cached for `ttlMs`
 * (default 60s) to avoid hitting the DB on every admin request.
 *
 * The cache is bounded (`maxEntries`, default 10_000) to prevent
 * unbounded growth from a flood of unique (likely-unauthorized) user
 * ids. Eviction is FIFO via Map insertion order — when the cap is
 * reached, the oldest entry is dropped before the new one is inserted.
 */
const PLATFORM_ADMIN_CACHE_MAX_ENTRIES = 10_000;

export class PgPlatformAdminChecker implements PlatformAdminChecker {
  private cache: Map<string, { value: boolean; expiresAt: number }> = new Map();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = 60_000,
    private readonly maxEntries: number = PLATFORM_ADMIN_CACHE_MAX_ENTRIES
  ) {}

  async isPlatformAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;

    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached) {
      // Stale — drop so re-insertion below counts as a fresh entry for
      // FIFO eviction order.
      this.cache.delete(userId);
    }

    // platform_admins is intentionally cross-tenant — must NOT set the
    // RLS tenant GUC for this query.
    const client = await this.pool.connect();
    let value = false;
    try {
      const result = await client.query<{ user_id: string }>(
        'SELECT user_id FROM platform_admins WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      value = result.rows.length > 0;
    } finally {
      client.release();
    }

    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(userId, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}

/**
 * Express middleware factory: returns a handler that gates on the
 * `platform_admins` table. 401 if no auth, 403 if not present.
 *
 * The check intentionally does NOT depend on req.auth.role or any JWT
 * claim — the DB row is the only source of truth. This means a token
 * cannot be forged into platform-admin access.
 */
export function requirePlatformAdmin(checker: PlatformAdminChecker): RequestHandler {
  return async (req, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth || !authReq.auth.userId) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    try {
      const ok = await checker.isPlatformAdmin(authReq.auth.userId);
      if (!ok) {
        res.status(403).json({
          error: 'platform_admin_required',
          message: 'Platform-admin authority required',
        });
        return;
      }
      next();
    } catch (err) {
      // Fail closed on DB errors. We do not want a transient DB outage to
      // accidentally grant access; we want it to deny. The internal
      // exception is intentionally NOT echoed in the response body —
      // err.message can leak connection strings or schema names. Log
      // server-side for ops, return a generic body to the client.
      console.error('[platform-admin] check failed:', err);
      res.status(503).json({
        error: 'platform_admin_check_failed',
        message: 'platform-admin check failed',
      });
    }
  };
}

export interface GrantInput {
  userId: string;
  grantedBy: string;
  notes?: string;
  /**
   * tenantId for the audit row. Audit events are tenant-scoped (FK +
   * RLS), so callers must supply a tenant under which to record the
   * action. The actor_type='platform' marker goes into metadata.
   * For CLI grants where no tenant is naturally available, pass the
   * granter's home tenant.
   */
  auditTenantId: string;
  auditRepo?: AuditRepository;
  /** Optional grant timestamp; defaults to NOW() server-side. */
  grantedAt?: Date;
}

export interface GrantResult {
  userId: string;
  inserted: boolean;
  grantedAt: Date;
}

/**
 * Idempotent grant. Inserts into `platform_admins`; on conflict, the
 * existing row is left untouched. Emits an audit event with
 * metadata.actor_type='platform' so review tooling can filter.
 *
 * When `auditRepo` is provided, the INSERT and the audit write run in
 * a single transaction — if the audit fails (FK violation, transient
 * error), the grant is rolled back so we never end up with a granted
 * platform admin who is invisible to the audit log.
 */
export async function grantPlatformAdmin(
  pool: Pool,
  input: GrantInput
): Promise<GrantResult> {
  if (!input.userId) throw new Error('userId is required');
  if (!input.grantedBy) throw new Error('grantedBy is required');

  const client = await pool.connect();
  let inserted = false;
  let grantedAt = input.grantedAt ?? new Date();
  const useTransaction = Boolean(input.auditRepo);

  try {
    if (useTransaction) await client.query('BEGIN');

    const result = await client.query<{ user_id: string; granted_at: Date }>(
      `INSERT INTO platform_admins (user_id, granted_by, notes, granted_at)
       VALUES ($1, $2, $3, COALESCE($4, NOW()))
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id, granted_at`,
      [input.userId, input.grantedBy, input.notes ?? null, input.grantedAt ?? null]
    );
    if (result.rows.length > 0) {
      inserted = true;
      grantedAt = result.rows[0].granted_at;
    }

    if (input.auditRepo) {
      const event = createAuditEvent({
        tenantId: input.auditTenantId,
        actorId: input.grantedBy,
        actorRole: 'platform',
        eventType: 'platform_admin.granted',
        entityType: 'platform_admin',
        entityId: input.userId,
        metadata: {
          actor_type: 'platform',
          granted_to: input.userId,
          notes: input.notes ?? null,
          idempotent_no_op: !inserted,
        },
      });
      await input.auditRepo.create(event);
    }

    if (useTransaction) await client.query('COMMIT');
  } catch (err) {
    if (useTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // best-effort; primary error is the one we want to surface
      }
    }
    throw err;
  } finally {
    client.release();
  }

  return { userId: input.userId, inserted, grantedAt };
}

export interface RevokeInput {
  userId: string;
  revokedBy: string;
  auditTenantId: string;
  auditRepo?: AuditRepository;
}

export interface RevokeResult {
  userId: string;
  removed: boolean;
}

export async function revokePlatformAdmin(
  pool: Pool,
  input: RevokeInput
): Promise<RevokeResult> {
  if (!input.userId) throw new Error('userId is required');
  if (!input.revokedBy) throw new Error('revokedBy is required');

  const client = await pool.connect();
  let removed = false;
  const useTransaction = Boolean(input.auditRepo);

  try {
    if (useTransaction) await client.query('BEGIN');

    const result = await client.query(
      `DELETE FROM platform_admins WHERE user_id = $1 RETURNING user_id`,
      [input.userId]
    );
    removed = result.rowCount !== null && result.rowCount > 0;

    if (input.auditRepo) {
      const event = createAuditEvent({
        tenantId: input.auditTenantId,
        actorId: input.revokedBy,
        actorRole: 'platform',
        eventType: 'platform_admin.revoked',
        entityType: 'platform_admin',
        entityId: input.userId,
        metadata: {
          actor_type: 'platform',
          revoked_from: input.userId,
          was_present: removed,
        },
      });
      await input.auditRepo.create(event);
    }

    if (useTransaction) await client.query('COMMIT');
  } catch (err) {
    if (useTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // best-effort
      }
    }
    throw err;
  } finally {
    client.release();
  }

  return { userId: input.userId, removed };
}
