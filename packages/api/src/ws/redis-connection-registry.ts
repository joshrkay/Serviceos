/**
 * Redis-backed per-tenant WS connection cap (scale-to-1000 U3b).
 *
 * A cluster-wide cap shared across replicas. Each (surface, tenant) is a Redis
 * sorted set whose members are per-connection lease ids scored by expiry time.
 * The cap check is a single atomic Lua (purge-expired → ZCARD → compare → ZADD),
 * so two replicas can't both read "7" and write "8" (the lost-update race that a
 * bare INCR/DECR or GET-then-SET would hit). Each lease carries a TTL refreshed
 * by the owner; a crashed replica's leases simply expire instead of leaking the
 * cap forever.
 *
 * Failure stance: FAIL-OPEN-TO-LOCAL. On any Redis error we degrade to a
 * per-replica InMemory limiter — never silently unlimited (the cache's stance,
 * wrong for a cap), never fully closed (a Redis blip must not become a total WS
 * outage). Clock comes from Redis `TIME` inside Lua so expiry is consistent
 * across replicas regardless of host clock skew.
 */
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { createRedisClient, registerRedisClientForShutdown } from '../redis/redis-client';
import { wsConnections } from '../monitoring/metrics';
import {
  InMemoryConnectionRegistry,
  DEFAULT_REGISTRY_CONFIG,
  DEFAULT_LEASE_TTL_MS,
  type ConnectionRegistry,
  type ConnectionLease,
  type ConnectionRegistryConfig,
} from './connection-registry';

// Redis wall-clock in ms (TIME returns [seconds, microseconds]).
const NOW_MS_LUA = `local t = redis.call('TIME'); local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)`;

// KEYS[1]=zset; ARGV[1]=leaseTtlMs, ARGV[2]=perTenantMax, ARGV[3]=member. Returns 1 on accept, 0 at cap.
const ACQUIRE_LUA = `
${NOW_MS_LUA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 3)
return 1`;

// KEYS[1]=zset; ARGV[1]=leaseTtlMs, ARGV[2]=member. Re-ups the lease iff it still exists (never resurrects a released member).
const REFRESH_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
${NOW_MS_LUA}
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 3)
end
return 1`;

// KEYS[1]=zset. Purge expired and return the live count.
const COUNT_LUA = `
${NOW_MS_LUA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZCARD', KEYS[1])`;

export class RedisConnectionRegistry implements ConnectionRegistry {
  /** Per-replica limiter used when Redis is unavailable (fail-open-to-local). */
  private readonly local: InMemoryConnectionRegistry;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: ConnectionRegistryConfig = DEFAULT_REGISTRY_CONFIG,
    private readonly defaultLeaseTtlMs: number = DEFAULT_LEASE_TTL_MS,
  ) {
    this.local = new InMemoryConnectionRegistry(cfg);
  }

  private zkey(surface: string, tenantId: string): string {
    return `ws:${surface}:${tenantId}`;
  }

  async acquire(
    surface: string,
    tenantId: string,
    tier: string = 'standard',
    leaseTtlMs: number = this.defaultLeaseTtlMs,
  ): Promise<ConnectionLease | null> {
    const key = this.zkey(surface, tenantId);
    const member = randomUUID();
    try {
      const accepted = await this.redis.eval(
        ACQUIRE_LUA,
        1,
        key,
        String(leaseTtlMs),
        String(this.cfg.perTenantMax),
        member,
      );
      if (Number(accepted) !== 1) return null; // at/over the cluster-wide cap
    } catch {
      // Redis down → degrade to a per-replica local cap (never unlimited).
      return this.local.acquire(surface, tenantId, tier, leaseTtlMs);
    }

    wsConnections.inc({ surface, tenant_tier: tier });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        wsConnections.dec({ surface, tenant_tier: tier });
        try {
          await this.redis.zrem(key, member);
        } catch {
          // best-effort — the lease TTL reclaims the slot if this is lost.
        }
      },
      refresh: async () => {
        try {
          await this.redis.eval(REFRESH_LUA, 1, key, String(leaseTtlMs), member);
        } catch {
          // best-effort — a missed refresh just shortens the lease; the next one re-ups it.
        }
      },
    };
  }

  async count(surface: string, tenantId: string): Promise<number> {
    try {
      const n = await this.redis.eval(COUNT_LUA, 1, this.zkey(surface, tenantId));
      return Number(n);
    } catch {
      return this.local.count(surface, tenantId);
    }
  }
}

/**
 * Build a RedisConnectionRegistry from REDIS_URL, or null when unset/unreachable
 * (caller falls back to InMemory). Registers the client for SIGTERM shutdown.
 */
export async function createRedisConnectionRegistry(
  redisUrl?: string,
  cfg: ConnectionRegistryConfig = DEFAULT_REGISTRY_CONFIG,
): Promise<RedisConnectionRegistry | null> {
  const client = await createRedisClient(redisUrl, { role: 'command' });
  if (!client) return null;
  registerRedisClientForShutdown(client);
  return new RedisConnectionRegistry(client, cfg);
}
