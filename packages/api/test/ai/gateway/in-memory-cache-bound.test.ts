import { describe, it, expect } from 'vitest';
import { InMemoryCacheStore, type CacheEntry } from '../../../src/ai/gateway/cache';

/**
 * U3e — InMemoryCacheStore is the gateway-cache fallback when REDIS_URL is unset.
 * It must be size-bounded so a long-lived replica doesn't grow the sha256-keyed
 * Map without limit, WITHOUT changing get()/TTL semantics (the wrapper owns
 * logical expiry). These pin FIFO eviction at the bound and parity below it.
 */
const mkEntry = (tag: string, ttlMs = 60_000): CacheEntry => ({
  response: { content: tag } as unknown as CacheEntry['response'],
  cachedAt: 1,
  ttlMs,
});

describe('InMemoryCacheStore size bound', () => {
  it('evicts the oldest entry when inserting a new key at capacity', async () => {
    const store = new InMemoryCacheStore(2);
    await store.set('a', mkEntry('ra'));
    await store.set('b', mkEntry('rb'));
    await store.set('c', mkEntry('rc')); // at capacity → evicts oldest ('a')

    expect(await store.get('a')).toBeNull();
    expect((await store.get('b'))?.response.content).toBe('rb');
    expect((await store.get('c'))?.response.content).toBe('rc');
  });

  it('does not evict when re-setting an existing key at capacity', async () => {
    const store = new InMemoryCacheStore(2);
    await store.set('a', mkEntry('ra'));
    await store.set('b', mkEntry('rb'));
    await store.set('a', mkEntry('ra2')); // update in place — no eviction

    expect((await store.get('a'))?.response.content).toBe('ra2');
    expect((await store.get('b'))?.response.content).toBe('rb');
  });

  it('still no-ops on ttlMs <= 0 (parity with RedisCacheStore)', async () => {
    const store = new InMemoryCacheStore(2);
    await store.set('x', mkEntry('rx', 0));
    expect(await store.get('x')).toBeNull();
  });

  it('default bound is large — no eviction in normal use', async () => {
    const store = new InMemoryCacheStore();
    for (let i = 0; i < 200; i++) await store.set(`k${i}`, mkEntry(`r${i}`));
    expect(await store.get('k0')).not.toBeNull();
    expect(await store.get('k199')).not.toBeNull();
  });
});
