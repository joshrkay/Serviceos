/**
 * Shared Redis client factory + shutdown registry (scale-to-1000 U3a).
 *
 * Single seam every horizontal-scale shared-state store reuses — the gateway
 * response cache, the WS per-tenant connection cap (U3b), the voice event
 * fan-out (U3d), and the LLM per-tenant quota (U3c). Centralising connection
 * construction + SIGTERM teardown means no subsystem opens or leaks its own
 * ioredis connection.
 *
 * `createRedisClient` returns `null` when `redisUrl` is falsy OR the connect
 * fails. That null is the structural guarantee of "zero behavior change when
 * REDIS_URL is unset": every caller falls back to its InMemory implementation,
 * so single-instance / dev / the entire existing test suite are unaffected.
 *
 * Construction mirrors the options already proven in `redis-cache-store.ts`
 * (fail-fast, bounded retries, lazy connect) so boot is never stalled by an
 * unreachable Redis.
 */
import type { Redis } from 'ioredis';

/** Connection options proven by the gateway cache (redis-cache-store.ts). */
const PROVEN_OPTIONS = {
  // Don't retry a single request forever when Redis is flaky/unavailable.
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  // Fail fast on connect — Redis unavailability must never stall boot.
  connectTimeout: 3000,
  lazyConnect: true,
} as const;

export interface CreateRedisClientOptions {
  /**
   * `'subscriber'` is for pub/sub SUBSCRIBE-only connections (U3d). An ioredis
   * connection in subscriber mode cannot issue normal commands, so a consumer
   * that also reads a directory must open a separate `'command'` connection.
   * Construction is identical today; the role documents intent and reserves the
   * seam for per-role tuning later.
   */
  role?: 'command' | 'subscriber';
}

/**
 * Construct + connect a shared Redis client, or return null when `redisUrl` is
 * unset or the connect fails. Lazy-imports ioredis so it stays off the
 * cold-start path when REDIS_URL is not configured.
 */
export async function createRedisClient(
  redisUrl?: string,
  _opts: CreateRedisClientOptions = {},
): Promise<Redis | null> {
  if (!redisUrl) return null;
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisUrl, PROVEN_OPTIONS);
    // ioredis extends EventEmitter: an 'error' event with NO listener throws
    // an uncaught exception and crashes the process. Background/transient Redis
    // errors after boot (reconnects, command timeouts) must degrade gracefully —
    // every store fails open to its InMemory path — not take down the API.
    // Attach BEFORE connect() so a handshake error is caught here too.
    client.on('error', (err: Error) => {
      process.stderr.write(`Redis client error: ${err.message}\n`);
    });
    await client.connect();
    return client;
  } catch {
    // Unreachable/misconfigured Redis must not stall boot — caller falls back
    // to its InMemory implementation.
    return null;
  }
}

/** Anything with an async `quit()` — the ioredis Redis client satisfies this. */
export interface QuittableClient {
  quit(): Promise<unknown>;
}

const clientsToShutdown: QuittableClient[] = [];

/**
 * Register a Redis client so it is closed on SIGTERM. Stores created via the
 * shared factory call this so `shutdownRedisClients()` (wired into the app
 * shutdown handler, after the cache flush and before `pool.end()`) drains every
 * connection cleanly and Railway's stop signal doesn't strand sockets.
 */
export function registerRedisClientForShutdown(client: QuittableClient): void {
  clientsToShutdown.push(client);
}

/** Quit every registered Redis client. Best-effort — a failing quit can't block
 * the rest of shutdown (Promise.allSettled). Idempotent: drains the registry. */
export async function shutdownRedisClients(): Promise<void> {
  const clients = clientsToShutdown.splice(0, clientsToShutdown.length);
  await Promise.allSettled(clients.map((c) => c.quit()));
}
