import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AuthenticatedRequest } from '../auth/clerk';

export interface TechnicianLocationAuthorizer {
  canSubmitForTechnician(auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string): Promise<boolean>;
}

export class InMemoryTechnicianLocationAuthorizer implements TechnicianLocationAuthorizer {
  async canSubmitForTechnician(auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string): Promise<boolean> {
    if (auth.role === 'technician') {
      return auth.canonicalUserId === technicianId;
    }
    return true;
  }
}

export class PgTechnicianLocationAuthorizer extends PgBaseRepository implements TechnicianLocationAuthorizer {
  constructor(pool: Pool) {
    super(pool);
  }

  async canSubmitForTechnician(auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string): Promise<boolean> {
    if (auth.role === 'technician') {
      return auth.canonicalUserId === technicianId;
    }

    // Owner/dispatcher may submit on behalf of any technician in the tenant.
    // Accept BOTH the canonical `users.id` (UUID — what the dispatch board and
    // appointment_assignments expose, so it's the id a dispatcher's client
    // naturally has) AND the legacy `clerk_user_id` (what technician devices
    // self-submit with). Casting `id::text` keeps a Clerk-id value from erroring
    // the comparison. This unblocks the dispatcher submit path without a schema
    // migration; normalizing the stored ping key onto users.id is deferred.
    return this.withTenant(auth.tenantId, async (client) => {
      const found = await client.query(
        `SELECT 1
         FROM users
         WHERE tenant_id = $1
           AND (id::text = $2 OR clerk_user_id = $2)
           AND role = 'technician'
         LIMIT 1`,
        [auth.tenantId, technicianId]
      );
      return (found.rowCount ?? 0) > 0;
    });
  }
}
