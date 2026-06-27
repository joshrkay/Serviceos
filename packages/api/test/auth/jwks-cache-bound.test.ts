/**
 * U3e-2 — the per-host JWKS cache in HttpsJwksResolver is FIFO size-bounded so a
 * process can't grow it without limit. Mirrors test/ai/gateway/in-memory-cache-bound.test.ts.
 *
 * fetchJwks is overridden (it is `protected`) to return stub keys and count
 * fetches per host, so the bound is proven without any network I/O.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { HttpsJwksResolver, type JwksKey } from '../../src/auth/clerk';

const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const STUB_KEYS: JwksKey[] = [{ kid: 'k1', publicKey, alg: 'RS256' }];

/** Resolver whose network fetch is replaced by a per-host counter. */
class CountingJwksResolver extends HttpsJwksResolver {
  readonly fetchesByHost = new Map<string, number>();
  constructor(maxEntries: number) {
    super(maxEntries);
  }
  protected async fetchJwks(host: string): Promise<JwksKey[]> {
    this.fetchesByHost.set(host, (this.fetchesByHost.get(host) ?? 0) + 1);
    return STUB_KEYS;
  }
}

describe('HttpsJwksResolver FIFO cache bound (U3e-2)', () => {
  it('evicts the oldest host once maxEntries is exceeded', async () => {
    const resolver = new CountingJwksResolver(2);

    await resolver.getKeys('a.example.com'); // cache {a}
    await resolver.getKeys('b.example.com'); // cache {a,b}
    await resolver.getKeys('c.example.com'); // inserts c → evicts a → {b,c}
    expect(resolver.fetchesByHost.get('a.example.com')).toBe(1);

    // c is the most-recent entry → served from cache (no new fetch).
    await resolver.getKeys('c.example.com');
    expect(resolver.fetchesByHost.get('c.example.com')).toBe(1);

    // a was evicted → must re-fetch.
    await resolver.getKeys('a.example.com');
    expect(resolver.fetchesByHost.get('a.example.com')).toBe(2);
  });

  it('re-setting an existing host within TTL does NOT evict (cache hit, no fetch)', async () => {
    const resolver = new CountingJwksResolver(2);
    await resolver.getKeys('a.example.com');
    await resolver.getKeys('b.example.com');
    // Repeated reads of cached hosts stay at one fetch each and don't churn the bound.
    await resolver.getKeys('a.example.com');
    await resolver.getKeys('b.example.com');
    expect(resolver.fetchesByHost.get('a.example.com')).toBe(1);
    expect(resolver.fetchesByHost.get('b.example.com')).toBe(1);
  });
});
