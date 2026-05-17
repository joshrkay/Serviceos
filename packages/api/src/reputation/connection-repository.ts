/**
 * P7-026 — Connection repository for `google_business_connections` (migration 101).
 *
 * Follows the canonical method shape from
 * `docs/superpowers/contracts/repository-conventions.md`:
 *   - tenantId is always the first argument of every read/write method.
 *   - Single-record reads return `T | null`.
 *   - Multi-record reads return `T[]`.
 *
 * The system-level `findPollCandidates` method intentionally bypasses
 * tenant scoping — the polling worker iterates across every active
 * connection regardless of tenant. This is the documented escape hatch
 * per repository-conventions.md §"Cross-tenant or system-level methods".
 */

import type { GoogleBusinessConnection } from './types';

export interface ConnectionUpdate {
  status?: GoogleBusinessConnection['status'];
  lastPolledAt?: Date;
  backoffUntil?: Date | null;
  backoffAttempts?: number;
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  accessTokenExpiresAt?: Date;
}

export interface GoogleBusinessConnectionRepository {
  create(connection: GoogleBusinessConnection): Promise<GoogleBusinessConnection>;
  findById(
    tenantId: string,
    id: string,
  ): Promise<GoogleBusinessConnection | null>;
  findByTenant(tenantId: string): Promise<GoogleBusinessConnection[]>;
  update(
    tenantId: string,
    id: string,
    updates: ConnectionUpdate,
  ): Promise<GoogleBusinessConnection | null>;
  /**
   * System-level / cross-tenant query used by the polling worker.
   * Returns every connection whose status is 'active' and whose
   * `backoffUntil` is either null or in the past (i.e., we are allowed
   * to call the Google API for this connection right now).
   *
   * Does NOT filter by tenant — this is a privileged background sweep,
   * not an API route. See repository-conventions.md.
   */
  findPollCandidates(asOf: Date): Promise<GoogleBusinessConnection[]>;
}

export class InMemoryGoogleBusinessConnectionRepository
  implements GoogleBusinessConnectionRepository
{
  private connections: Map<string, GoogleBusinessConnection> = new Map();

  async create(
    connection: GoogleBusinessConnection,
  ): Promise<GoogleBusinessConnection> {
    this.connections.set(connection.id, { ...connection });
    return { ...connection };
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<GoogleBusinessConnection | null> {
    const c = this.connections.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async findByTenant(tenantId: string): Promise<GoogleBusinessConnection[]> {
    return Array.from(this.connections.values())
      .filter((c) => c.tenantId === tenantId)
      .map((c) => ({ ...c }));
  }

  async update(
    tenantId: string,
    id: string,
    updates: ConnectionUpdate,
  ): Promise<GoogleBusinessConnection | null> {
    const c = this.connections.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    const next: GoogleBusinessConnection = {
      ...c,
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.lastPolledAt !== undefined && {
        lastPolledAt: updates.lastPolledAt,
      }),
      // `null` is the explicit "clear backoff" signal — the property
      // check distinguishes 'unset' from 'reset to null'.
      ...(updates.backoffUntil !== undefined && {
        backoffUntil: updates.backoffUntil === null ? undefined : updates.backoffUntil,
      }),
      ...(updates.backoffAttempts !== undefined && {
        backoffAttempts: updates.backoffAttempts,
      }),
      ...(updates.accessTokenEncrypted !== undefined && {
        accessTokenEncrypted: updates.accessTokenEncrypted,
      }),
      ...(updates.refreshTokenEncrypted !== undefined && {
        refreshTokenEncrypted: updates.refreshTokenEncrypted,
      }),
      ...(updates.accessTokenExpiresAt !== undefined && {
        accessTokenExpiresAt: updates.accessTokenExpiresAt,
      }),
      updatedAt: new Date(),
    };
    this.connections.set(id, next);
    return { ...next };
  }

  async findPollCandidates(asOf: Date): Promise<GoogleBusinessConnection[]> {
    const cutoff = asOf.getTime();
    return Array.from(this.connections.values())
      .filter(
        (c) =>
          c.status === 'active' &&
          (!c.backoffUntil || c.backoffUntil.getTime() <= cutoff),
      )
      .map((c) => ({ ...c }));
  }
}
