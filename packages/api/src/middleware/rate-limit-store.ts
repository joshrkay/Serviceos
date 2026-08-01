/**
 * Redis-backed store for express-rate-limit (scale-to-1000 P3 / U-P3c).
 *
 * The default MemoryStore counts hits PER PROCESS, so under N replicas a tenant
 * effectively gets N× its configured limit. This store moves the counters into
 * the shared Redis so a limit is enforced cluster-wide, mirroring the other
 * shared stores in this codebase (one `createRedisClient()` idiom).
 *
 * Each window is a single Redis key `rl:<prefix><client>`; a hit is an atomic
 * INCR + first-hit PEXPIRE (so two replicas can't both read "9" and write "10"),
 * and the TTL is read back as the reset time so it's consistent across replicas.
 *
 * Failure stance: FAIL-OPEN-TO-LOCAL — identical to the WS cap / quota. On any
 * Redis error (or before the async connection is ready) we count in a per-replica
 * MemoryStore. Never unlimited (that would defeat the limiter), never a hard 500
 * (a Redis blip must not take the API down). When REDIS_URL is unset,
 * createRateLimitStore returns undefined and express-rate-limit uses its own
 * MemoryStore — byte-identical to today.
 */
import type { Redis } from 'ioredis';
import { MemoryStore, type Store, type Options, type ClientRateLimitInfo } from 'express-rate-limit';
import { createRedisClient, registerRedisClientForShutdown } from '../redis/redis-client';

// Atomic window hit: INCR, set the TTL on the first hit only, return [hits, pttl].
const HIT_LUA = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {hits, redis.call('PTTL', KEYS[1])}`;

/**
 * One shared command connection for ALL rate-limit stores (the /api, /webhooks,
 * /public and per-tenant limiters), so we don't open a Redis connection per
 * limiter. Lazily created from the first store's REDIS_URL.
 */
let sharedClientPromise: Promise<Redis | null> | null = null;
function getSharedClient(redisUrl: string): Promise<Redis | null> {
  if (!sharedClientPromise) {
    sharedClientPromise = createRedisClient(redisUrl, { role: 'command' })
      .then((client) => {
        if (client) registerRedisClientForShutdown(client);
        return client;
      })
      .catch(() => null);
  }
  return sharedClientPromise;
}

/** Test seam: reset the shared-client memo (so unit tests don't leak a client). */
export function __resetRateLimitSharedClient(): void {
  sharedClientPromise = null;
}

export class RedisRateLimitStore implements Store {
  private redis: Redis | null = null;
  private windowMs = 60_000;
  /** Per-replica fallback used until connected and on any Redis error. */
  private readonly local = new MemoryStore();

  constructor(
    redisUrl: string,
    private readonly keyPrefix = 'rl:',
  ) {
    void getSharedClient(redisUrl).then((client) => {
      this.redis = client;
    });
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.local.init(options);
  }

  private key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (!this.redis) return this.local.increment(key);
    try {
      const res = (await this.redis.eval(
        HIT_LUA,
        1,
        this.key(key),
        String(this.windowMs),
      )) as [number, number];
      const ttlMs = Number(res[1]);
      return {
        totalHits: Number(res[0]),
        // PTTL is -1 (no expiry, shouldn't happen) / -2 (missing) on edge races;
        // fall back to a full window so the reset time is never in the past.
        resetTime: new Date(Date.now() + (ttlMs > 0 ? ttlMs : this.windowMs)),
      };
    } catch {
      return this.local.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    if (!this.redis) return this.local.decrement(key);
    try {
      await this.redis.decr(this.key(key));
    } catch {
      // best-effort — an over-count self-heals when the window's TTL expires.
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!this.redis) return this.local.resetKey(key);
    try {
      await this.redis.del(this.key(key));
    } catch {
      // best-effort.
    }
  }
}

/**
 * Build a Redis-backed rate-limit store, or undefined when REDIS_URL is unset
 * (express-rate-limit then uses its own per-process MemoryStore — identical to
 * pre-P3 behavior). `prefix` namespaces each limiter's counters so they don't
 * collide on one Redis.
 */
export function createRateLimitStore(redisUrl: string | undefined, prefix: string): Store | undefined {
  if (!redisUrl) return undefined;
  return new RedisRateLimitStore(redisUrl, prefix);
}
