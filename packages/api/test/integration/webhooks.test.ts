/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Covers PgWebhookRepository against real Postgres: the (source,
 * idempotency_key) unique index that makes webhook delivery idempotent, the
 * status transition with processed_at stamping, and null-on-miss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { WebhookEvent } from '../../src/webhooks/webhook-handler';

function makeEvent(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: randomUUID(),
    source: 'stripe',
    eventType: 'checkout.session.completed',
    idempotencyKey: `evt_${randomUUID()}`,
    payload: { hello: 'world' },
    status: 'received',
    createdAt: new Date(),
    ...over,
  };
}

describe('Postgres integration — webhooks', () => {
  let pool: Pool;
  let repo: PgWebhookRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgWebhookRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates and finds a webhook event by (source, idempotencyKey)', async () => {
    const event = makeEvent();
    await repo.create(event);
    const found = await repo.findByIdempotencyKey(event.source, event.idempotencyKey);
    expect(found?.id).toBe(event.id);
    expect(found?.payload).toEqual({ hello: 'world' });
    expect(found?.status).toBe('received');
  });

  it('returns null for an unknown idempotency key', async () => {
    expect(await repo.findByIdempotencyKey('stripe', `missing_${randomUUID()}`)).toBeNull();
  });

  it('is idempotent on a duplicate (source, idempotencyKey) — returns the existing row, no throw', async () => {
    const event = makeEvent();
    await repo.create(event);

    // Same source + idempotency key, different id. create() uses
    // INSERT ... ON CONFLICT (source, idempotency_key) DO NOTHING, so it must
    // NOT throw on the duplicate — it returns the PRE-EXISTING row (the
    // original id, not the new one) and creates no second row. handleWebhookEvent
    // relies on this to dedup concurrent redeliveries safely.
    const dup = makeEvent({ idempotencyKey: event.idempotencyKey });
    const result = await repo.create(dup);
    expect(result.id).toBe(event.id);
    expect(result.id).not.toBe(dup.id);

    const found = await repo.findByIdempotencyKey(event.source, event.idempotencyKey);
    expect(found?.id).toBe(event.id);
  });

  it('updateStatus to processed stamps processed_at; failed leaves it null', async () => {
    const event = makeEvent();
    await repo.create(event);

    await repo.updateStatus(event.id, 'processed');
    const processed = await repo.findByIdempotencyKey(event.source, event.idempotencyKey);
    expect(processed?.status).toBe('processed');
    expect(processed?.processedAt).toBeInstanceOf(Date);

    const failedEvent = makeEvent();
    await repo.create(failedEvent);
    await repo.updateStatus(failedEvent.id, 'failed', 'boom');
    const failed = await repo.findByIdempotencyKey(failedEvent.source, failedEvent.idempotencyKey);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toBe('boom');
    expect(failed?.processedAt).toBeUndefined();
  });

  it('updateStatus on a missing id is a no-op (retry-safe, no throw)', async () => {
    await expect(repo.updateStatus(randomUUID(), 'processed')).resolves.toBeUndefined();
  });
});

describe('Postgres integration — P0-8 retry claim CAS', () => {
  let pool: Pool;
  let repo: PgWebhookRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgWebhookRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('exactly one of N concurrent retries of a FAILED row wins the claim', async () => {
    const event = await repo.create(makeEvent({ status: 'failed' }));

    const claims = await Promise.all([
      repo.claimForRetry(event.id, 30_000),
      repo.claimForRetry(event.id, 30_000),
      repo.claimForRetry(event.id, 30_000),
    ]);

    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe('processing');
  });

  it('a stale in-flight row is claimable once; a fresh one is not claimable at all', async () => {
    const stale = await repo.create(
      makeEvent({ status: 'processing', createdAt: new Date(Date.now() - 60_000) }),
    );
    const fresh = await repo.create(makeEvent({ status: 'processing' }));

    // Stale: first claim wins and refreshes created_at, so a follow-up claim
    // sees a FRESH in-flight row and loses — the third-retry window is closed.
    expect(await repo.claimForRetry(stale.id, 30_000)).not.toBeNull();
    expect(await repo.claimForRetry(stale.id, 30_000)).toBeNull();

    expect(await repo.claimForRetry(fresh.id, 30_000)).toBeNull();
  });

  it('a processed row is never claimable', async () => {
    const event = await repo.create(makeEvent({ status: 'processed' }));
    expect(await repo.claimForRetry(event.id, 30_000)).toBeNull();
  });
});
