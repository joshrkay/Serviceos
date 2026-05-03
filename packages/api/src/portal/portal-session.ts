/**
 * P10-001 — Customer self-service portal session entity + InMemory repo.
 *
 * A `PortalSession` is a long-lived signed-token grant that lets a single
 * customer view all of their entities (estimates, invoices, jobs,
 * agreements, appointments) without a Clerk login.
 *
 * Token storage rules:
 *   - The plaintext token is returned ONCE at create time (never persisted).
 *   - We store `tokenHash = sha256(plaintextToken)` and look up by hash.
 *   - Comparison uses `crypto.timingSafeEqual` against the stored hash.
 *
 * The Pg implementation lives in `pg-portal-session.ts` and runs the
 * lookup query via `withClient()` because the token IS the auth — at
 * lookup time we don't yet know which tenant to scope to.
 */

export interface PortalSession {
  id: string;
  tenantId: string;
  customerId: string;
  /** sha256 hex of the plaintext token. Never store the plaintext. */
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  lastAccessedAt?: Date;
  createdBy: string;
  createdAt: Date;
}

export interface PortalSessionRepository {
  create(session: PortalSession): Promise<PortalSession>;
  /**
   * System-level lookup by sha256 token hash. Implementations MUST NOT
   * apply tenant scoping here — the token is the auth and the caller
   * has not yet chosen a tenant. The returned session carries the
   * tenant id the caller should subsequently scope to.
   */
  findByTokenHash(tokenHash: string): Promise<PortalSession | null>;
  findById(tenantId: string, id: string): Promise<PortalSession | null>;
  /** Sets `last_accessed_at = now()`. Best-effort; never throws to caller. */
  touchLastAccessed(id: string, at: Date): Promise<void>;
  /** Sets `revoked_at = now()`. Tenant-scoped. */
  revoke(tenantId: string, id: string, at: Date): Promise<PortalSession | null>;
}

export class InMemoryPortalSessionRepository implements PortalSessionRepository {
  private rows = new Map<string, PortalSession>();

  async create(session: PortalSession): Promise<PortalSession> {
    this.rows.set(session.id, { ...session });
    return { ...session };
  }

  async findByTokenHash(tokenHash: string): Promise<PortalSession | null> {
    for (const r of this.rows.values()) {
      if (r.tokenHash === tokenHash) return { ...r };
    }
    return null;
  }

  async findById(tenantId: string, id: string): Promise<PortalSession | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async touchLastAccessed(id: string, at: Date): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.lastAccessedAt = at;
  }

  async revoke(tenantId: string, id: string, at: Date): Promise<PortalSession | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    r.revokedAt = at;
    return { ...r };
  }
}
