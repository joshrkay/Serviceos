import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AuthenticatedRequest } from '../auth/clerk';

export interface TechnicianLocationAuthorizer {
  canSubmitForTechnician(auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string): Promise<boolean>;
}

export class InMemoryTechnicianLocationAuthorizer implements TechnicianLocationAuthorizer {
  async canSubmitForTechnician(auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string): Promise<boolean> {
    if (auth.role === 'technician') {
      return auth.userId === technicianId;
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
      return auth.userId === technicianId;
    }

    return this.withTenant(auth.tenantId, async (client) => {
      const found = await client.query(
        `SELECT 1
         FROM users
         WHERE tenant_id = $1
           AND clerk_user_id = $2
           AND role = 'technician'
         LIMIT 1`,
        [auth.tenantId, technicianId]
      );
      return (found.rowCount ?? 0) > 0;
    });
  }
}
