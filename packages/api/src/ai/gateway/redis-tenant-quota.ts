/**
 * Redis-backed per-tenant LLM quota (scale-to-1000 U3c).
 *
 * A cluster-wide port of `TenantQuotaRegistry`: the concurrency semaphore and the
 * token bucket are shared across replicas so the per-tenant fairness caps hold
 * for the whole fleet, not per-process. Two pieces of state per tenant:
 *
 *   - `quota:if:{tenant}` — a sorted set of in-flight leases, members
 *     `"{leaseId}:{reservedTokens}"` scored by expiry. ZCARD = concurrency;
 *     summing the reserved suffixes = the hard-upper-bound reservation. A crashed
 *     replica's leases simply expire (ZREMRANGEBYSCORE purges them on the next
 *     acquire) instead of leaking a slot forever — the same lease-TTL reclaim as
 *     the WS cap (U3b).
 *   - `quota:tb:{tenant}` — a hash {tokens, refillMs} for the token bucket. It is
 *     refilled lazily from Redis `TIME` on every touch, so it needs NO crash
 *     reclaim: an un-released request leaves its estimate spent, and the bucket
 *     refills back over time on its own (conservative, self-healing).
 *
 * Acquire is a SINGLE atomic Lua (purge → concurrency check → refill → token
 * check → hard-bound check → reserve), so two replicas can't both read "budget
 * ok" and overspend (the lost-update race a GET-then-SET would hit). The clock is
 * Redis `TIME` inside Lua, consistent across replicas regardless of host skew.
 *
 * Failure stance: FAIL-OPEN-TO-LOCAL — identical deliberate choice as U3b. On any
 * Redis error we degrade to a per-replica in-memory `TenantQuotaRegistry` (never
 * unlimited — wrong for a cap; never fully closed — a Redis blip must not 503 the
 * whole AI pipeline).
 */
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { createRedisClient, registerRedisClientForShutdown } from '../../redis/redis-client';
import {
  tenantConcurrencyInFlight,
  tenantConcurrencyRejectTotal,
  tenantTokenBudgetExceededTotal,
} from '../../monitoring/metrics';
import {
  TenantQuotaRegistry,
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
  DEFAULT_TIER_CONFIG,
  type QuotaStore,
  type QuotaLease,
  type TenantTier,
  type TenantQuotaTierConfig,
} from './tenant-quota';

// Redis wall-clock in ms (TIME returns [seconds, microseconds]).
const NOW_MS_LUA = `local t = redis.call('TIME'); local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)`;

/**
 * KEYS[1]=inflight zset, KEYS[2]=token-bucket hash.
 * ARGV: 1=leaseTtlMs 2=maxConcurrency 3=bucketCapacity 4=refillPerSec
 *       5=hardUpperBound 6=estimatedTokens 7=leaseId 8=hashIdleMs
 * Returns {status, reason, retryAfterMs, inFlight}:
 *   status 1=accepted 0=rejected; reason 0=ok 1=concurrency 2=token-bucket 3=hard-bound.
 */
const ACQUIRE_LUA = `
${NOW_MS_LUA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local inFlight = redis.call('ZCARD', KEYS[1])
if inFlight >= tonumber(ARGV[2]) then return {0, 1, 1000, inFlight} end
local cap = tonumber(ARGV[3])
local refill = tonumber(ARGV[4])
local est = tonumber(ARGV[6])
local tokens = tonumber(redis.call('HGET', KEYS[2], 'tokens'))
local lastMs = tonumber(redis.call('HGET', KEYS[2], 'refillMs'))
if tokens == nil then tokens = cap end
if lastMs == nil then lastMs = now end
local elapsed = (now - lastMs) / 1000
if elapsed > 0 then tokens = math.min(cap, tokens + elapsed * refill) end
local idle = tonumber(ARGV[8])
if est > tokens then
  local retry = math.ceil(((est - tokens) / refill) * 1000)
  redis.call('HSET', KEYS[2], 'tokens', tokens, 'refillMs', now)
  redis.call('PEXPIRE', KEYS[2], idle)
  return {0, 2, retry, inFlight}
end
local reserved = 0
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for i = 1, #members do
  local r = tonumber(string.match(members[i], ':(%d+)$'))
  if r then reserved = reserved + r end
end
if reserved + est > tonumber(ARGV[5]) then
  redis.call('HSET', KEYS[2], 'tokens', tokens, 'refillMs', now)
  redis.call('PEXPIRE', KEYS[2], idle)
  return {0, 3, 1000, inFlight}
end
tokens = tokens - est
redis.call('HSET', KEYS[2], 'tokens', tokens, 'refillMs', now)
redis.call('PEXPIRE', KEYS[2], idle)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[7] .. ':' .. est)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 3)
return {1, 0, 0, inFlight + 1}`;

/**
 * KEYS[1]=inflight zset, KEYS[2]=token-bucket hash.
 * ARGV: 1=member("leaseId:est") 2=hasActuals(0/1) 3=bucketCapacity 4=refillPerSec
 *       5=estimatedTokens 6=actualTokens 7=hashIdleMs
 * Removes the lease (frees the concurrency slot + reservation) and reconciles the
 * bucket against actual usage. Refills to now first so the delta lands on a
 * current bucket value (the canonical token-bucket update).
 */
const RELEASE_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) == 1 then
${NOW_MS_LUA}
  local cap = tonumber(ARGV[3])
  local refill = tonumber(ARGV[4])
  local tokens = tonumber(redis.call('HGET', KEYS[2], 'tokens'))
  local lastMs = tonumber(redis.call('HGET', KEYS[2], 'refillMs'))
  if tokens == nil then tokens = cap end
  if lastMs == nil then lastMs = now end
  local elapsed = (now - lastMs) / 1000
  if elapsed > 0 then tokens = math.min(cap, tokens + elapsed * refill) end
  local delta = tonumber(ARGV[6]) - tonumber(ARGV[5])
  if delta > 0 then tokens = math.max(0, tokens - delta)
  elseif delta < 0 then tokens = math.min(cap, tokens - delta) end
  redis.call('HSET', KEYS[2], 'tokens', tokens, 'refillMs', now)
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[7]))
end
return 1`;

/** Hash idle TTL — an idle tenant's bucket is evicted; a fresh key starts full
 *  (lenient, matches the in-memory state-pruning behavior). */
const HASH_IDLE_MS = 30 * 60 * 1000;
/** Lease TTL — a request that never releases (crash) frees its slot after this. */
const DEFAULT_QUOTA_LEASE_TTL_MS = 5 * 60 * 1000;

export class RedisTenantQuotaStore implements QuotaStore {
  /** Per-replica fallback used when Redis is unavailable (fail-open-to-local). */
  private readonly local: TenantQuotaRegistry;

  constructor(
    private readonly redis: Redis,
    private readonly tiers: Record<string, TenantQuotaTierConfig> = DEFAULT_TIER_CONFIG,
    private readonly leaseTtlMs: number = DEFAULT_QUOTA_LEASE_TTL_MS,
  ) {
    this.local = new TenantQuotaRegistry(tiers);
  }

  private cfgFor(tier: TenantTier | undefined): TenantQuotaTierConfig {
    return this.tiers[tier ?? 'standard'] ?? this.tiers.standard;
  }

  async acquire(opts: {
    tenantId: string;
    tenantTier?: TenantTier;
    estimatedTokens: number;
  }): Promise<QuotaLease> {
    const { tenantId, tenantTier, estimatedTokens } = opts;
    const tierLabel = tenantTier ?? 'standard';
    const cfg = this.cfgFor(tenantTier);
    const ifKey = `quota:if:${tenantId}`;
    const tbKey = `quota:tb:${tenantId}`;
    const leaseId = randomUUID();

    let res: unknown;
    try {
      res = await this.redis.eval(
        ACQUIRE_LUA,
        2,
        ifKey,
        tbKey,
        String(this.leaseTtlMs),
        String(cfg.maxConcurrency),
        String(cfg.bucketCapacity),
        String(cfg.refillTokensPerSec),
        String(cfg.hardUpperBoundTokens),
        String(estimatedTokens),
        leaseId,
        String(HASH_IDLE_MS),
      );
    } catch {
      // Redis down → degrade to a per-replica quota (never unlimited, never closed).
      return this.local.acquire(opts);
    }

    const [status, reason, retryAfterMs, inFlight] = (res as number[]).map(Number);
    if (status !== 1) {
      if (reason === 1) {
        tenantConcurrencyRejectTotal.inc({ tenant_tier: tierLabel });
        throw new TenantConcurrencyExceededError(tenantId);
      }
      tenantTokenBudgetExceededTotal.inc({ tenant_tier: tierLabel });
      throw new TenantTokenBudgetExceededError(tenantId, retryAfterMs);
    }

    tenantConcurrencyInFlight.set({ tenant_tier: tierLabel }, inFlight);
    const member = `${leaseId}:${estimatedTokens}`;
    let released = false;
    return {
      release: async (actualInput?: number, actualOutput?: number) => {
        if (released) return;
        released = true;
        tenantConcurrencyInFlight.dec({ tenant_tier: tierLabel });
        const hasActuals =
          typeof actualInput === 'number' && typeof actualOutput === 'number';
        try {
          await this.redis.eval(
            RELEASE_LUA,
            2,
            ifKey,
            tbKey,
            member,
            hasActuals ? '1' : '0',
            String(cfg.bucketCapacity),
            String(cfg.refillTokensPerSec),
            String(estimatedTokens),
            String(hasActuals ? (actualInput as number) + (actualOutput as number) : 0),
            String(HASH_IDLE_MS),
          );
        } catch {
          // best-effort — the lease TTL reclaims the slot; the bucket self-refills.
        }
      },
    };
  }
}

/**
 * Build a RedisTenantQuotaStore from REDIS_URL, or null when unset/unreachable
 * (caller falls back to the in-memory registry). Registers the client for
 * SIGTERM shutdown.
 */
export async function createRedisTenantQuotaStore(
  redisUrl?: string,
  tiers: Record<string, TenantQuotaTierConfig> = DEFAULT_TIER_CONFIG,
): Promise<RedisTenantQuotaStore | null> {
  const client = await createRedisClient(redisUrl, { role: 'command' });
  if (!client) return null;
  registerRedisClientForShutdown(client);
  return new RedisTenantQuotaStore(client, tiers);
}
