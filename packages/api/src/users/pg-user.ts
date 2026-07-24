import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  User,
  UpdateUserInput,
  UserListOptions,
  UserRepository,
} from './user';

function mapRow(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    clerkUserId: (row.clerk_user_id as string | null) ?? null,
    email: row.email as string,
    role: row.role as User['role'],
    firstName: (row.first_name as string | null) ?? undefined,
    lastName: (row.last_name as string | null) ?? undefined,
    // Phase 12 — column added in migration 063. Default false applies
    // at the column level.
    canFieldServe: Boolean(row.can_field_serve ?? false),
    // P1-022 — column added in migration 109. NULL when no mobile on file.
    mobileNumber: (row.mobile_number as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgUserRepository extends PgBaseRepository implements UserRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async findByTenant(tenantId: string, options?: UserListOptions): Promise<User[]> {
    return this.withTenant(tenantId, async (client) => {
      // Explicit tenant scoping: RLS is a runtime no-op unless
      // RLS_RUNTIME_ROLE is enabled (see db/rls-runtime-role.ts), so the
      // tenant_id predicate — not withTenant's GUC — is what isolates tenants.
      const params: unknown[] = [tenantId];
      // Soft-deleted accounts (16D, migration 093) are invisible to reads.
      let where = 'WHERE tenant_id = $1 AND deleted_at IS NULL';
      if (options?.role) {
        params.push(options.role);
        where += ` AND role = $${params.length}`;
      }
      // Stable ORDER BY is required before LIMIT so the bounded window is
      // deterministic across calls (matches InMemoryUserRepository's
      // `createdAt.getTime()` sort).
      let sql = `SELECT id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                COALESCE(can_field_serve, false) AS can_field_serve,
                mobile_number,
                created_at, updated_at
         FROM users
         ${where}
         ORDER BY created_at ASC`;
      if (options?.limit !== undefined) {
        params.push(Math.max(0, Math.trunc(options.limit)));
        sql += ` LIMIT $${params.length}`;
      }
      const result = await client.query(sql, params);
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                COALESCE(can_field_serve, false) AS can_field_serve,
                mobile_number,
                created_at, updated_at
         FROM users
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  /**
   * P1-022 — bind an inbound communication to a user by mobile number.
   *
   * `e164` MUST already be normalized via `normalizeMobileE164()`; the
   * stored column holds the same canonical E.164 form.
   *
   * Defense-in-depth: the WHERE clause filters on `tenant_id` explicitly in
   * addition to RLS, so a mobile registered in one tenant can never resolve
   * a user in another even if this runs in a context where RLS were ever
   * misconfigured. Returns null when no user in this tenant has that mobile.
   */
  async findByMobileNumber(tenantId: string, e164: string): Promise<User | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                COALESCE(can_field_serve, false) AS can_field_serve,
                mobile_number,
                created_at, updated_at
         FROM users
         WHERE tenant_id = $1
           AND mobile_number = $2
           AND deleted_at IS NULL`,
        [tenantId, e164],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  /**
   * P1-022 — write (or clear) the normalized E.164 mobile number for a user.
   * Callers MUST pass a value already run through `normalizeMobileE164()`,
   * or `null` to clear. Tenant-scoped in the WHERE clause. Returns the
   * updated row, or null when the user wasn't found in this tenant.
   */
  async setMobileNumber(
    tenantId: string,
    id: string,
    e164: string | null,
  ): Promise<User | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // deleted_at IS NULL: a write must never land on a soft-deleted row —
      // an explicit-UUID request racing a deletion could otherwise repopulate
      // mobile_number on the hidden row and re-block the unique slot.
      const result = await client.query(
        `UPDATE users SET mobile_number = $1, updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3
           AND deleted_at IS NULL
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   mobile_number,
                   created_at, updated_at`,
        [e164, id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  /**
   * Tier 4 (Team members — PR 2 follow-up, PR 319 review). Atomic
   * single-statement demotion guarded by "another owner exists" in
   * the same tenant. Closes the read-then-write race that two
   * concurrent demotions could exploit to leave the tenant ownerless.
   *
   * Returns the updated row when the demotion succeeded, null when
   * the guard blocked it (no other owner) OR the row didn't match.
   */
  async demoteOwnerIfAnotherExists(
    tenantId: string,
    id: string,
    newRole: 'dispatcher' | 'technician',
  ): Promise<User | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Same serialization anchor as softDeleteSelf: EVERY owner-removing
      // operation must take the tenant-row lock, or a demotion racing an
      // account deletion could each observe the other's still-live owner
      // row (their stamps are uncommitted until response-time COMMIT) and
      // both commit — leaving the tenant ownerless.
      await client.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      const result = await client.query(
        `UPDATE users SET role = $1, updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3
           AND role = 'owner'
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM users u2
             WHERE u2.tenant_id = $3
               AND u2.role = 'owner'
               AND u2.id != $2
               AND u2.deleted_at IS NULL
               AND u2.status = 'active'
           )
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   mobile_number,
                   created_at, updated_at`,
        [newRole, id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  /**
   * Guideline 5.1.1(v) — in-app account deletion (16D retention model:
   * stamp `deleted_at`, never purge). Last-owner guard: an owner's
   * self-deletion only succeeds when another non-deleted owner exists.
   *
   * Under the request-scoped `/api` transaction (app.ts withTenantTransaction
   * middleware) an EXISTS guard alone is NOT sufficient: each request's
   * stamp stays uncommitted until its response-time COMMIT, so two owners
   * deleting concurrently would each see the other still live (READ
   * COMMITTED) and both pass. The tenant-row lock below serializes account
   * deletions per tenant across requests — the second request blocks until
   * the first COMMITs, then its guard re-evaluates against committed state.
   * `tenants` is RLS-exempt and nothing else locks it FOR UPDATE, so there
   * is no lock-ordering conflict.
   */
  async softDeleteSelf(tenantId: string, id: string): Promise<User | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      await client.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      // mobile_number is cleared so the `users_mobile_unique` partial index
      // slot is released — a soft-deleted row is invisible to reads, so a
      // held number would otherwise 409 forever for the next teammate.
      const result = await client.query(
        `UPDATE users SET deleted_at = NOW(), mobile_number = NULL, updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           AND (
             role != 'owner'
             OR EXISTS (
               SELECT 1 FROM users u2
               WHERE u2.tenant_id = $2
                 AND u2.role = 'owner'
                 AND u2.id != $1
                 AND u2.deleted_at IS NULL
                 AND u2.status = 'active'
             )
           )
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   mobile_number,
                   created_at, updated_at`,
        [id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  async restoreAccount(
    tenantId: string,
    id: string,
    mobileNumber: string | null,
  ): Promise<User | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Access restoration MUST NOT depend on the mobile number: the early
      // durable commit released the users_mobile_unique slot, so a teammate
      // may have claimed the number in the meantime. A single UPDATE that
      // also set mobile_number would then 23505 and abandon the whole
      // restore, leaving the caller locked out. Restore access first; then
      // best-effort re-instate the number under a SAVEPOINT (on conflict
      // the number is simply lost — re-enterable in Settings).
      const result = await client.query(
        `UPDATE users SET deleted_at = NULL, updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NOT NULL
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   mobile_number,
                   created_at, updated_at`,
        [id, tenantId],
      );
      if (result.rows.length === 0) return null;
      let restored = mapRow(result.rows[0] as Record<string, unknown>);
      if (mobileNumber !== null) {
        await client.query('SAVEPOINT restore_mobile');
        try {
          const withNumber = await client.query(
            `UPDATE users SET mobile_number = $1, updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3
             RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                       COALESCE(can_field_serve, false) AS can_field_serve,
                       mobile_number,
                       created_at, updated_at`,
            [mobileNumber, id, tenantId],
          );
          await client.query('RELEASE SAVEPOINT restore_mobile');
          if (withNumber.rows.length > 0) {
            restored = mapRow(withNumber.rows[0] as Record<string, unknown>);
          }
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT restore_mobile');
          await client.query('RELEASE SAVEPOINT restore_mobile').catch(() => undefined);
        }
      }
      return restored;
    });
  }

  async update(tenantId: string, id: string, updates: UpdateUserInput): Promise<User | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        role: 'role',
        firstName: 'first_name',
        lastName: 'last_name',
        canFieldServe: 'can_field_serve',
      };
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;
      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (!column) continue;
        setClauses.push(`${column} = $${paramIndex}`);
        params.push(value);
        paramIndex += 1;
      }
      if (setClauses.length === 0) return this.findById(tenantId, id);

      setClauses.push(`updated_at = NOW()`);
      params.push(id);
      const result = await client.query(
        `UPDATE users SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
           AND deleted_at IS NULL
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   mobile_number,
                   created_at, updated_at`,
        params,
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }
}
