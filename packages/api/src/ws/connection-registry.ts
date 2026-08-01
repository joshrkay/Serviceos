/**
 * Per-tenant WS connection registry (scale-to-1000 U3b).
 *
 * Counts open connections per (surface, tenant) so the upgrade path can reject
 * when a tenant exceeds its cap. Two implementations behind one async interface:
 *
 * - `InMemoryConnectionRegistry` — process-local Map, byte-identical to the
 *   pre-U3b behavior. The default when `REDIS_URL` is unset; correct for a single
 *   replica.
 * - `RedisConnectionRegistry` (redis-connection-registry.ts) — a cluster-wide cap
 *   shared across replicas, using a per-connection lease with a TTL so a crashed
 *   replica's slots self-expire instead of leaking the cap forever.
 *
 * `acquire()` returns a `ConnectionLease` (or null when at the cap). The caller
 * holds the lease, `refresh()`es it while the connection is alive (the client
 * gateway does this on its heartbeat), and `release()`s it on teardown. The lease
 * is the per-connection handle that makes crashed-replica reclaim possible.
 */
import { wsConnections } from '../monitoring/metrics';

export interface ConnectionRegistryConfig {
  /** Max concurrent connections per tenant, per surface. */
  perTenantMax: number;
}

export const DEFAULT_REGISTRY_CONFIG: ConnectionRegistryConfig = {
  perTenantMax: 50,
};

/** Default lease TTL — long enough that the client-gateway heartbeat refreshes
 *  it comfortably; surfaces without a refresh (telephony) pass a longer TTL. */
export const DEFAULT_LEASE_TTL_MS = 90_000;

/** Per-connection handle returned by acquire(). */
export interface ConnectionLease {
  /** Release the slot. Idempotent; best-effort under a Redis outage (TTL backstop). */
  release(): Promise<void>;
  /** Re-up the lease TTL so a long-lived connection isn't reclaimed. No-op for
   *  the in-memory registry (which never expires) and for surfaces that don't
   *  refresh. */
  refresh(): Promise<void>;
}

export interface ConnectionRegistry {
  /**
   * Acquire a connection slot for (surface, tenant). Returns a lease, or null if
   * the tenant is at or over the cap. `tier` labels the wsConnections metric;
   * `leaseTtlMs` overrides the default (telephony uses a long TTL since it has no
   * refresh loop).
   */
  acquire(
    surface: string,
    tenantId: string,
    tier?: string,
    leaseTtlMs?: number,
  ): Promise<ConnectionLease | null>;
  /** Current connection count for (surface, tenant). */
  count(surface: string, tenantId: string): Promise<number>;
}

/** Process-local registry — the REDIS_URL-unset default (single-replica correct). */
export class InMemoryConnectionRegistry implements ConnectionRegistry {
  private counts: Map<string, number> = new Map();

  constructor(private readonly cfg: ConnectionRegistryConfig = DEFAULT_REGISTRY_CONFIG) {}

  private key(surface: string, tenantId: string): string {
    return `${surface}|${tenantId}`;
  }

  async acquire(
    surface: string,
    tenantId: string,
    tier: string = 'standard',
    _leaseTtlMs?: number,
  ): Promise<ConnectionLease | null> {
    const k = this.key(surface, tenantId);
    const cur = this.counts.get(k) ?? 0;
    if (cur >= this.cfg.perTenantMax) return null;
    this.counts.set(k, cur + 1);
    wsConnections.inc({ surface, tenant_tier: tier });

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const c = this.counts.get(k) ?? 0;
        if (c <= 1) this.counts.delete(k);
        else this.counts.set(k, c - 1);
        wsConnections.dec({ surface, tenant_tier: tier });
      },
      // In-memory connections never expire — the slot is held until release().
      refresh: async () => {},
    };
  }

  async count(surface: string, tenantId: string): Promise<number> {
    return this.counts.get(this.key(surface, tenantId)) ?? 0;
  }
}

/**
 * Delegating registry that starts in-memory and swaps to Redis once the
 * connection is established — mirrors the gateway cache's sync-return +
 * async-upgrade so the (synchronous) app composition root stays unchanged.
 * Connections acquired during the brief upgrade window hold in-memory leases
 * (released in-memory via the lease closure); acquires after the swap are
 * cluster-wide. The cap is a safety limit, so a sub-second per-replica window at
 * boot is acceptable.
 */
class SwappableConnectionRegistry implements ConnectionRegistry {
  private impl: ConnectionRegistry;
  constructor(cfg: ConnectionRegistryConfig) {
    this.impl = new InMemoryConnectionRegistry(cfg);
  }
  swap(next: ConnectionRegistry): void {
    this.impl = next;
  }
  acquire(
    surface: string,
    tenantId: string,
    tier?: string,
    leaseTtlMs?: number,
  ): Promise<ConnectionLease | null> {
    return this.impl.acquire(surface, tenantId, tier, leaseTtlMs);
  }
  count(surface: string, tenantId: string): Promise<number> {
    return this.impl.count(surface, tenantId);
  }
}

/**
 * Select the registry by REDIS_URL. Returns SYNCHRONOUSLY (InMemory) and, when
 * REDIS_URL is set, upgrades to the cluster-wide Redis registry in the
 * background (falling back to InMemory if the connect fails). Byte-identical to
 * InMemory when REDIS_URL is unset — the single seam that keeps single-instance
 * and the existing test suite unaffected.
 */
export function createConnectionRegistry(
  redisUrl?: string,
  cfg: ConnectionRegistryConfig = DEFAULT_REGISTRY_CONFIG,
): ConnectionRegistry {
  if (!redisUrl) return new InMemoryConnectionRegistry(cfg);
  const registry = new SwappableConnectionRegistry(cfg);
  void import('./redis-connection-registry')
    .then(({ createRedisConnectionRegistry }) => createRedisConnectionRegistry(redisUrl, cfg))
    .then((redisReg) => {
      if (redisReg) registry.swap(redisReg);
    })
    .catch(() => {
      // Redis unavailable — stay in-memory (per-replica cap).
    });
  return registry;
}

/** Process-wide default for call sites without injected DI. Tests construct their own. */
export const globalConnectionRegistry: ConnectionRegistry = new InMemoryConnectionRegistry();
