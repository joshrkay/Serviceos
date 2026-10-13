import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { createLogger } from '../../src/logging/logger';
import { runReviewRequestSweep } from '../../src/workers/review-request-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Fixed clock so the 24h threshold is deterministic.
const NOW = new Date('2026-06-25T12:00:00.000Z');
const now = () => NOW;

function fakePool(rows: { id: string; tenant_id: string }[], onQuery?: (sql: string, params: unknown[]) => void): Pool {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      onQuery?.(sql, params);
      return { rows } as unknown as ReturnType<Pool['query']>;
    }),
  } as unknown as Pool;
}

async function seedCompletedJob(jobRepo: InMemoryJobRepository, tenantId: string, id: string) {
  const base = await jobRepo.create({
    id,
    tenantId,
    customerId: 'c1',
    locationId: 'l1',
    summary: 'Service',
    status: 'completed',
    createdBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: new Date('2026-06-24T00:00:00.000Z'), // >24h before NOW
  } as never);
  return base;
}

describe('runReviewRequestSweep (US-345)', () => {
  it('enqueues feedback_send and stamps review_request_sent_at for each eligible job', async () => {
    const jobRepo = new InMemoryJobRepository();
    await seedCompletedJob(jobRepo, 't1', 'job-1');
    await seedCompletedJob(jobRepo, 't1', 'job-2');
    const send = vi.fn(async () => 'msg-id');

    let capturedCutoff: Date | undefined;
    const pool = fakePool(
      [
        { id: 'job-1', tenant_id: 't1' },
        { id: 'job-2', tenant_id: 't1' },
      ],
      (_sql, params) => {
        capturedCutoff = params[0] as Date;
      },
    );

    const result = await runReviewRequestSweep({
      pool,
      jobRepo,
      queue: { send },
      logger,
      now,
    });

    expect(result).toEqual({ candidates: 2, enqueued: 2, failed: 0, deferred: 0 });
    // Reuses feedback_send with the canonical idempotency key.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      'feedback_send',
      { tenantId: 't1', jobId: 'job-1' },
      't1:job-1:feedback_send',
    );
    // Idempotency stamp written so the next sweep skips both jobs.
    expect((await jobRepo.findById('t1', 'job-1'))!.reviewRequestSentAt).toEqual(NOW);
    expect((await jobRepo.findById('t1', 'job-2'))!.reviewRequestSentAt).toEqual(NOW);
    // 24h threshold: the eligibility query is asked for jobs completed before NOW-24h.
    expect(capturedCutoff).toEqual(new Date('2026-06-24T12:00:00.000Z'));
  });

  it('honors a custom delayHours', async () => {
    const jobRepo = new InMemoryJobRepository();
    let capturedCutoff: Date | undefined;
    const pool = fakePool([], (_sql, params) => {
      capturedCutoff = params[0] as Date;
    });
    await runReviewRequestSweep({
      pool,
      jobRepo,
      queue: { send: vi.fn(async () => 'id') },
      logger,
      now,
      delayHours: 1,
    });
    expect(capturedCutoff).toEqual(new Date('2026-06-25T11:00:00.000Z'));
  });

  it('is a no-op without a pool', async () => {
    const send = vi.fn(async () => 'id');
    const result = await runReviewRequestSweep({
      pool: null,
      jobRepo: new InMemoryJobRepository(),
      queue: { send },
      logger,
      now,
    });
    expect(result).toEqual({ candidates: 0, enqueued: 0, failed: 0, deferred: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a zeroed result and never throws when the eligibility query fails', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Pool;
    const result = await runReviewRequestSweep({
      pool,
      jobRepo: new InMemoryJobRepository(),
      queue: { send: vi.fn(async () => 'id') },
      logger,
      now,
    });
    expect(result).toEqual({ candidates: 0, enqueued: 0, failed: 0, deferred: 0 });
  });

  it("leaves a closed-window tenant's jobs for a later tick — not enqueued, not stamped", async () => {
    // The sweep is the review request's retry loop: a job it skips stays
    // eligible (and re-checked against the toggle and recency floor) until
    // the tenant's window opens.
    const jobRepo = new InMemoryJobRepository();
    await seedCompletedJob(jobRepo, 't-closed', 'job-1');
    await seedCompletedJob(jobRepo, 't-open', 'job-2');
    const send = vi.fn(async () => 'msg-id');

    const result = await runReviewRequestSweep({
      pool: fakePool([
        { id: 'job-1', tenant_id: 't-closed' },
        { id: 'job-2', tenant_id: 't-open' },
      ]),
      jobRepo,
      queue: { send },
      logger,
      now,
      sendWindow: {
        sendWindowVerdict: async ({ tenantId }) => ({
          isAllowedNow: tenantId === 't-open',
          nextAllowedAt: NOW,
        }),
      },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('feedback_send', { tenantId: 't-open', jobId: 'job-2' }, 't-open:job-2:feedback_send');
    expect((await jobRepo.findById('t-closed', 'job-1'))!.reviewRequestSentAt).toBeFalsy();
    expect(result).toMatchObject({ enqueued: 1, deferred: 1, failed: 0 });
  });

  it('stamps before enqueueing, so a worker that hands the job back first is not overwritten (N2)', async () => {
    // A fast poller can run feedback_send (which clears the stamp on a closed
    // recipient window) before the sweep's own write lands. With the stamp
    // written after the enqueue, that hand-back was overwritten and the job
    // was never re-selected — the request lost for good.
    const jobRepo = new InMemoryJobRepository();
    await seedCompletedJob(jobRepo, 't1', 'job-1');
    const send = vi.fn(async () => {
      await jobRepo.update('t1', 'job-1', { reviewRequestSentAt: undefined }); // the worker's hand-back
      return 'msg-id';
    });

    await runReviewRequestSweep({ pool: fakePool([{ id: 'job-1', tenant_id: 't1' }]), jobRepo, queue: { send }, logger, now });

    expect(send).toHaveBeenCalledTimes(1);
    expect((await jobRepo.findById('t1', 'job-1'))!.reviewRequestSentAt).toBeFalsy();
  });

  it('clears its stamp again when the enqueue fails, so the next tick retries the job', async () => {
    const jobRepo = new InMemoryJobRepository();
    await seedCompletedJob(jobRepo, 't1', 'job-1');
    const send = vi.fn(async () => {
      throw new Error('queue down');
    });

    const result = await runReviewRequestSweep({
      pool: fakePool([{ id: 'job-1', tenant_id: 't1' }]),
      jobRepo,
      queue: { send },
      logger,
      now,
    });

    expect(result).toMatchObject({ enqueued: 0, failed: 1 });
    expect((await jobRepo.findById('t1', 'job-1'))!.reviewRequestSentAt).toBeFalsy();
  });
});

