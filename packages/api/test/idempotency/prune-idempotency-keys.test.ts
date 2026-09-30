/**
 * #1489 — the 24h TTL sweep that rides the hold-reaper tick.
 */
import { describe, it, expect } from 'vitest';
import { pruneExpiredIdempotencyKeys } from '../../src/idempotency/prune-idempotency-keys';
import { InMemoryIdempotencyStore } from '../../src/idempotency/idempotency-store';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const HOUR = 60 * 60 * 1000;

describe('pruneExpiredIdempotencyKeys (#1489)', () => {
  it('frees keys older than 24h in every tenant and keeps younger ones', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim({ tenantId: TENANT_A, userId: 'u', key: 'old-a' }, 'fp-1');
    await store.claim({ tenantId: TENANT_B, userId: 'u', key: 'old-b' }, 'fp-1');

    // 23h later nothing has expired yet.
    const early = await pruneExpiredIdempotencyKeys({
      store,
      tenantIds: [TENANT_A, TENANT_B],
      now: new Date(Date.now() + 23 * HOUR),
    });
    expect(early).toBe(0);
    expect((await store.claim({ tenantId: TENANT_A, userId: 'u', key: 'old-a' }, 'fp-2')).kind).toBe('mismatch');

    // 25h later both tenants' keys are gone: the key is claimable afresh.
    const late = await pruneExpiredIdempotencyKeys({
      store,
      tenantIds: [TENANT_A, TENANT_B],
      now: new Date(Date.now() + 25 * HOUR),
    });
    expect(late).toBe(2);
    expect((await store.claim({ tenantId: TENANT_A, userId: 'u', key: 'old-a' }, 'fp-2')).kind).toBe('claimed');
    expect((await store.claim({ tenantId: TENANT_B, userId: 'u', key: 'old-b' }, 'fp-2')).kind).toBe('claimed');
  });

  it('one tenant failing does not stop the sweep for the others', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim({ tenantId: TENANT_B, userId: 'u', key: 'k' }, 'fp');
    const failing = {
      ...store,
      claim: store.claim.bind(store),
      complete: store.complete.bind(store),
      release: store.release.bind(store),
      pruneExpired: async (tenantId: string, olderThan: Date) => {
        if (tenantId === TENANT_A) throw new Error('db down');
        return store.pruneExpired(tenantId, olderThan);
      },
    };
    const warnings: string[] = [];
    const pruned = await pruneExpiredIdempotencyKeys({
      store: failing,
      tenantIds: [TENANT_A, TENANT_B],
      now: new Date(Date.now() + 25 * HOUR),
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(pruned).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
