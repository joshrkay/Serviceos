/**
 * #1489 — storage contract for HTTP `Idempotency-Key` handling on the create
 * routes. A key is scoped to (tenant, user, key); the first request to claim
 * it runs, and its successful response is stored for replay.
 */

export interface IdempotencyScope {
  tenantId: string;
  userId: string;
  key: string;
}

export interface StoredResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export type ClaimResult =
  /** This request owns the key — run the handler. */
  | { kind: 'claimed' }
  /** A request with the same key and body already succeeded. */
  | { kind: 'replay'; response: StoredResponse }
  /** The key was already used with a different request body. */
  | { kind: 'mismatch' }
  /** Another request holding this key has not finished yet. */
  | { kind: 'in_progress' };

export interface IdempotencyStore {
  /** Claim `scope` for a request whose body hashes to `fingerprint`. */
  claim(scope: IdempotencyScope, fingerprint: string): Promise<ClaimResult>;
  /** Record the claimed request's successful response for replay. */
  complete(scope: IdempotencyScope, response: StoredResponse): Promise<void>;
  /**
   * Give the key back after a failed (>= 400) attempt so a retry runs again.
   * (In Postgres the request rollback already discards the claim; this also
   * covers stores with no request transaction.)
   */
  release(scope: IdempotencyScope): Promise<void>;
  /** Delete the tenant's keys created before `olderThan`; returns the count. */
  pruneExpired(tenantId: string, olderThan: Date): Promise<number>;
}

/** Keys (and their stored responses) live this long. */
export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

interface MemoryEntry {
  tenantId: string;
  fingerprint: string;
  createdAt: number;
  response: StoredResponse | null;
}

/**
 * Process-local store for in-memory (no DATABASE_URL) mode. There is no
 * request transaction to wait on, so a duplicate that arrives while the
 * first request is in flight is answered `in_progress` straight away.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private id(scope: IdempotencyScope): string {
    return JSON.stringify([scope.tenantId, scope.userId, scope.key]);
  }

  async claim(scope: IdempotencyScope, fingerprint: string): Promise<ClaimResult> {
    const id = this.id(scope);
    const existing = this.entries.get(id);
    if (!existing || existing.createdAt < Date.now() - IDEMPOTENCY_KEY_TTL_MS) {
      this.entries.set(id, { tenantId: scope.tenantId, fingerprint, createdAt: Date.now(), response: null });
      return { kind: 'claimed' };
    }
    if (existing.fingerprint !== fingerprint) return { kind: 'mismatch' };
    if (!existing.response) return { kind: 'in_progress' };
    return { kind: 'replay', response: existing.response };
  }

  async complete(scope: IdempotencyScope, response: StoredResponse): Promise<void> {
    const entry = this.entries.get(this.id(scope));
    if (entry) entry.response = response;
  }

  async release(scope: IdempotencyScope): Promise<void> {
    this.entries.delete(this.id(scope));
  }

  async pruneExpired(tenantId: string, olderThan: Date): Promise<number> {
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      if (entry.tenantId === tenantId && entry.createdAt < olderThan.getTime()) {
        this.entries.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }
}
