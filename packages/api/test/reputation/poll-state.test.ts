import { describe, it, expect } from 'vitest';
import {
  computeBackoffMs,
  InMemoryReviewPollStateRepository,
  isThrottled,
  REVIEW_BACKOFF_BASE_MS,
  REVIEW_BACKOFF_MAX_MS,
} from '../../src/reputation/poll-state';

describe('P7-026 computeBackoffMs', () => {
  it('returns 0 for non-positive counts', () => {
    expect(computeBackoffMs(0)).toBe(0);
    expect(computeBackoffMs(-1)).toBe(0);
  });

  it('returns base * 2^(n-1) for small n', () => {
    expect(computeBackoffMs(1)).toBe(REVIEW_BACKOFF_BASE_MS); // 30s
    expect(computeBackoffMs(2)).toBe(REVIEW_BACKOFF_BASE_MS * 2); // 60s
    expect(computeBackoffMs(3)).toBe(REVIEW_BACKOFF_BASE_MS * 4); // 120s
    expect(computeBackoffMs(4)).toBe(REVIEW_BACKOFF_BASE_MS * 8); // 240s
  });

  it('caps at REVIEW_BACKOFF_MAX_MS for large counts', () => {
    expect(computeBackoffMs(20)).toBe(REVIEW_BACKOFF_MAX_MS);
    expect(computeBackoffMs(100)).toBe(REVIEW_BACKOFF_MAX_MS);
  });

  it('reaches the cap precisely when 2^(n-1) * base >= max', () => {
    // 2^(n-1) * 30s >= 3600s → 2^(n-1) >= 120 → n-1 >= 7 → n >= 8
    expect(computeBackoffMs(7)).toBe(REVIEW_BACKOFF_BASE_MS * 64); // 32 min
    expect(computeBackoffMs(8)).toBe(REVIEW_BACKOFF_MAX_MS); // hits cap
  });
});

describe('P7-026 isThrottled', () => {
  const now = new Date('2026-05-17T12:00:00Z');

  it('returns false when state is null', () => {
    expect(isThrottled(null, now)).toBe(false);
  });

  it('returns false when backoffUntil is null', () => {
    expect(
      isThrottled(
        {
          tenantId: 't1',
          cursor: null,
          lastSuccessfulPollAt: null,
          backoffUntil: null,
          consecutive429Count: 0,
          updatedAt: now,
        },
        now,
      ),
    ).toBe(false);
  });

  it('returns true when backoffUntil is in the future', () => {
    expect(
      isThrottled(
        {
          tenantId: 't1',
          cursor: null,
          lastSuccessfulPollAt: null,
          backoffUntil: new Date(now.getTime() + 60_000),
          consecutive429Count: 2,
          updatedAt: now,
        },
        now,
      ),
    ).toBe(true);
  });

  it('returns false when backoffUntil is in the past', () => {
    expect(
      isThrottled(
        {
          tenantId: 't1',
          cursor: null,
          lastSuccessfulPollAt: null,
          backoffUntil: new Date(now.getTime() - 60_000),
          consecutive429Count: 2,
          updatedAt: now,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('P7-026 InMemoryReviewPollStateRepository', () => {
  const NOW = new Date('2026-05-17T12:00:00Z');

  it('returns null when no row exists', async () => {
    const repo = new InMemoryReviewPollStateRepository(() => NOW);
    expect(await repo.getPollState('t1')).toBeNull();
  });

  it('recordSuccess writes cursor + resets backoff state', async () => {
    const repo = new InMemoryReviewPollStateRepository(() => NOW);
    // Pre-seed with a throttled state.
    await repo.recordQuotaError('t1');
    await repo.recordQuotaError('t1');
    const before = await repo.getPollState('t1');
    expect(before?.consecutive429Count).toBe(2);
    expect(before?.backoffUntil).not.toBeNull();

    await repo.recordSuccess('t1', '2026-05-17T11:55:00.000Z');

    const after = await repo.getPollState('t1');
    expect(after?.cursor).toBe('2026-05-17T11:55:00.000Z');
    expect(after?.consecutive429Count).toBe(0);
    expect(after?.backoffUntil).toBeNull();
    expect(after?.lastSuccessfulPollAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('recordQuotaError increments count and grows backoff exponentially', async () => {
    const repo = new InMemoryReviewPollStateRepository(() => NOW);

    await repo.recordQuotaError('t1');
    const first = await repo.getPollState('t1');
    expect(first?.consecutive429Count).toBe(1);
    expect(first?.backoffUntil?.getTime()).toBe(
      NOW.getTime() + REVIEW_BACKOFF_BASE_MS,
    );

    await repo.recordQuotaError('t1');
    const second = await repo.getPollState('t1');
    expect(second?.consecutive429Count).toBe(2);
    expect(second?.backoffUntil?.getTime()).toBe(
      NOW.getTime() + REVIEW_BACKOFF_BASE_MS * 2,
    );

    await repo.recordQuotaError('t1');
    const third = await repo.getPollState('t1');
    expect(third?.consecutive429Count).toBe(3);
    expect(third?.backoffUntil?.getTime()).toBe(
      NOW.getTime() + REVIEW_BACKOFF_BASE_MS * 4,
    );
  });

  it('recordQuotaError preserves existing cursor (we retry from same watermark)', async () => {
    const repo = new InMemoryReviewPollStateRepository(() => NOW);
    await repo.recordSuccess('t1', '2026-05-17T11:00:00.000Z');
    await repo.recordQuotaError('t1');
    const state = await repo.getPollState('t1');
    expect(state?.cursor).toBe('2026-05-17T11:00:00.000Z');
    expect(state?.consecutive429Count).toBe(1);
  });
});
