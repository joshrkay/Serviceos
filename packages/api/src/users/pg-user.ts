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
      const params: unknown[] = [];
      let where = '';
      if (options?.role) {
        params.push(options.role);
        where = `WHERE role = $${params.length}`;
      }
      const result = await client.query(
        `SELECT id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                COALESCE(can_field_serve, false) AS can_field_serve,
                created_at, updated_at
         FROM users
         ${where}
         ORDER BY created_at ASC`,
        params,
      );
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                COALESCE(can_field_serve, false) AS can_field_serve,
                created_at, updated_at
         FROM users
         WHERE id = $1`,
        [id],
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
      const result = await client.query(
        `UPDATE users SET role = $1, updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3
           AND role = 'owner'
           AND EXISTS (
             SELECT 1 FROM users u2
             WHERE u2.tenant_id = $3
               AND u2.role = 'owner'
               AND u2.id != $2
           )
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   created_at, updated_at`,
        [newRole, id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
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
         RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
                   COALESCE(can_field_serve, false) AS can_field_serve,
                   created_at, updated_at`,
        params,
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }
}
