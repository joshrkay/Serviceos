import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import { ValidationError } from '../shared/errors';
import {
  CreateInvitationInput,
  PendingInvitation,
  PendingInvitationListOptions,
  PendingInvitationRepository,
  validateInvitationInput,
} from './pending-invitation';
import { UserRole } from './user';

function mapRow(row: Record<string, unknown>): PendingInvitation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    email: row.email as string,
    role: row.role as UserRole,
    clerkInvitationId: (row.clerk_invitation_id as string | null) ?? null,
    invitedBy: row.invited_by as string,
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at as string) : null,
  };
}

const DEFAULT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export class PgPendingInvitationRepository
  extends PgBaseRepository
  implements PendingInvitationRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateInvitationInput): Promise<PendingInvitation> {
    const errors = validateInvitationInput(input);
    if (errors.length > 0) {
      throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
    }
    return this.withTenant(input.tenantId, async (client) => {
      const id = uuidv4();
      const now = new Date();
      const expiresAt = input.expiresAt ?? new Date(now.getTime() + DEFAULT_EXPIRY_MS);
      try {
        const result = await client.query(
          `INSERT INTO pending_invitations
             (id, tenant_id, email, role, clerk_invitation_id, invited_by, created_at, expires_at)
           VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            id,
            input.tenantId,
            input.email,
            input.role,
            input.clerkInvitationId ?? null,
            input.invitedBy,
            now,
            expiresAt,
          ],
        );
        return mapRow(result.rows[0]);
      } catch (err: unknown) {
        // 23505 = unique_violation. Surface as ValidationError so the
        // route returns 400 (rather than the generic 500).
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          throw new ValidationError('A pending invitation already exists for this email');
        }
        throw err;
      }
    });
  }

  async findByTenant(
    tenantId: string,
    options?: PendingInvitationListOptions,
  ): Promise<PendingInvitation[]> {
    return this.withTenant(tenantId, async (client) => {
      // Explicit tenant scoping: RLS is a runtime no-op unless
      // RLS_RUNTIME_ROLE is enabled (see db/rls-runtime-role.ts), so this
      // predicate is what isolates tenants — not withTenant's GUC.
      const where = options?.includeAccepted
        ? 'WHERE tenant_id = $1'
        : 'WHERE tenant_id = $1 AND accepted_at IS NULL';
      const result = await client.query(
        `SELECT * FROM pending_invitations
         ${where}
         ORDER BY created_at ASC`,
        [tenantId],
      );
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  /**
   * Webhook lookup. Crosses tenant boundaries on purpose — the Clerk
   * webhook arrives without a tenant context (the invitee hasn't picked
   * one yet), so we use a direct pool query rather than withTenant.
   * The email index is partial-on-pending so this is O(1) in practice.
   */
  async findPendingByEmail(email: string): Promise<PendingInvitation | null> {
    const result = await this.pool.query(
      `SELECT * FROM pending_invitations
       WHERE LOWER(email) = LOWER($1)
         AND accepted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [email],
    );
    return result.rows.length > 0
      ? mapRow(result.rows[0] as Record<string, unknown>)
      : null;
  }

  /**
   * Cross-tenant lookup by id. Used by the Clerk webhook when
   * public_metadata.invitation_id is present (preferred over the
   * email-only lookup, which is ambiguous when two tenants invite
   * the same address simultaneously — PR 319 review P1).
   */
  async findById(id: string): Promise<PendingInvitation | null> {
    const result = await this.pool.query(
      `SELECT * FROM pending_invitations WHERE id = $1`,
      [id],
    );
    return result.rows.length > 0
      ? mapRow(result.rows[0] as Record<string, unknown>)
      : null;
  }

  async markAccepted(id: string): Promise<PendingInvitation | null> {
    // Same cross-tenant case as findPendingByEmail — the webhook
    // identifies the row by id, doesn't have a tenant context.
    const result = await this.pool.query(
      `UPDATE pending_invitations
       SET accepted_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows.length > 0
      ? mapRow(result.rows[0] as Record<string, unknown>)
      : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'DELETE FROM pending_invitations WHERE id = $1 AND tenant_id = $2',
        [id, tenantId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
