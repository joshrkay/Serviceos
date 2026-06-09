import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Role } from '@rivet/contracts';
import type { Config } from '../config';
import type { Db } from '../core/db';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

interface UserRow {
  id: string;
  tenant_id: string;
  role: Role;
}

/**
 * Identity resolution. With CLERK_JWKS_URL set, verifies RS256 Clerk JWTs
 * and maps sub -> users.clerk_user_id. Without it (dev/test), an explicit
 * x-dev-user-id header selects a seeded user. User lookup runs on the admin
 * pool because it happens before tenant context exists (platform concern).
 */
export class AuthService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.jwks = config.clerkJwksUrl ? createRemoteJWKSet(new URL(config.clerkJwksUrl)) : null;
  }

  get devMode(): boolean {
    return this.jwks === null;
  }

  async resolve(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null> {
    if (this.jwks) {
      const authz = headers['authorization'];
      const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : null;
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, this.jwks);
        if (typeof payload.sub !== 'string') return null;
        return await this.lookup('clerk_user_id', payload.sub);
      } catch {
        return null;
      }
    }
    const devUserId = headers['x-dev-user-id'];
    if (typeof devUserId !== 'string' || devUserId.length === 0) return null;
    return this.lookup('id', devUserId);
  }

  private async lookup(column: 'id' | 'clerk_user_id', value: string): Promise<AuthContext | null> {
    const { rows } = await this.db.admin.query<UserRow>(
      `SELECT id, tenant_id, role FROM users WHERE ${column} = $1`,
      [value],
    );
    const row = rows[0];
    if (!row) return null;
    return { userId: row.id, tenantId: row.tenant_id, role: row.role };
  }
}
