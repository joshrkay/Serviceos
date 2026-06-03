import {
  verifyWebhookSignature,
  createWebhookSignature,
  handleWebhookEvent,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';
import { createWebhookRouter } from '../../src/webhooks/routes';
import type { AppConfig } from '../../src/shared/config';

describe('P0-014 — Webhook security and idempotency foundation', () => {
  const secret = 'whsec_test_secret_key';

  it('happy path — verifies valid signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createWebhookSignature(payload, secret, timestamp);

    const valid = verifyWebhookSignature(payload, signature, secret);
    expect(valid).toBe(true);
  });

  it('validation — rejects invalid signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const valid = verifyWebhookSignature(payload, 't=123,v1=invalid', secret);
    expect(valid).toBe(false);
  });

  it('validation — rejects expired timestamp', () => {
    const payload = JSON.stringify({ event: 'test' });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const signature = createWebhookSignature(payload, secret, oldTimestamp);

    const valid = verifyWebhookSignature(payload, signature, secret, 300);
    expect(valid).toBe(false);
  });

  it('validation — rejects empty inputs', () => {
    expect(verifyWebhookSignature('', 'sig', secret)).toBe(false);
    expect(verifyWebhookSignature('payload', '', secret)).toBe(false);
    expect(verifyWebhookSignature('payload', 'sig', '')).toBe(false);
  });

  it('happy path — handleWebhookEvent creates new event', async () => {
    const repo = new InMemoryWebhookRepository();
    const { event, duplicate } = await handleWebhookEvent(
      'stripe',
      'payment.completed',
      { amount: 100 },
      'evt_123',
      repo
    );

    expect(duplicate).toBe(false);
    expect(event.source).toBe('stripe');
    expect(event.eventType).toBe('payment.completed');
    expect(event.status).toBe('received');
  });

  it('happy path — handleWebhookEvent detects duplicate of PROCESSED event', async () => {
    const repo = new InMemoryWebhookRepository();
    const first = await handleWebhookEvent(
      'stripe',
      'payment.completed',
      { amount: 100 },
      'evt_123',
      repo,
    );
    // Simulate a successful processing pass.
    await repo.updateStatus(first.event.id, 'processed');

    const { duplicate } = await handleWebhookEvent(
      'stripe',
      'payment.completed',
      { amount: 100 },
      'evt_123',
      repo,
    );

    expect(duplicate).toBe(true);
  });

  it('Codex P1 (PR #384) — handleWebhookEvent allows retry of FAILED event', async () => {
    // If the first attempt at processing threw, the event is marked
    // 'failed'. Stripe (or any upstream) retries the delivery. The
    // handler MUST be allowed to re-run — otherwise transient errors
    // and out-of-order webhooks (e.g. charge.refunded arriving before
    // checkout.session.completed) are silently lost.
    const repo = new InMemoryWebhookRepository();
    const first = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_1' },
      'evt_failed_retry',
      repo,
    );
    expect(first.duplicate).toBe(false);
    await repo.updateStatus(first.event.id, 'failed', 'Payment not found');

    const second = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_1' },
      'evt_failed_retry',
      repo,
    );

    // Same event row (stable id) but NOT short-circuited as duplicate.
    expect(second.event.id).toBe(first.event.id);
    expect(second.duplicate).toBe(false);
  });

  it('Codex P1 (PR #384) — handleWebhookEvent BLOCKS recent in-flight RECEIVED (concurrent delivery)', async () => {
    // If a second delivery of the same event arrives while the first
    // handler is still running (row at 'received', recent createdAt),
    // we must return duplicate=true to prevent double side effects
    // (e.g. deposit crediting, payment-link mints).
    const repo = new InMemoryWebhookRepository();
    const first = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_2' },
      'evt_inflight',
      repo,
    );
    expect(first.duplicate).toBe(false);
    // status stays at 'received' AND createdAt is now (within staleness window)

    const second = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_2' },
      'evt_inflight',
      repo,
    );

    expect(second.event.id).toBe(first.event.id);
    // Concurrent delivery: blocked.
    expect(second.duplicate).toBe(true);
  });

  it('Codex P1 (PR #384) — handleWebhookEvent ALLOWS retry of STALE RECEIVED (handler crashed > 30s ago)', async () => {
    // If the handler crashed and the row is stuck at 'received' for
    // longer than the in-flight staleness threshold, retries should
    // re-execute to recover.
    const repo = new InMemoryWebhookRepository();
    const first = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_3' },
      'evt_stale_crashed',
      repo,
    );
    expect(first.duplicate).toBe(false);

    // Backdate createdAt to 60s ago (past INFLIGHT_STALENESS_MS=30s).
    const row = (repo as any).events.get(first.event.id);
    row.createdAt = new Date(Date.now() - 60_000);

    const second = await handleWebhookEvent(
      'stripe',
      'charge.refunded',
      { id: 're_3' },
      'evt_stale_crashed',
      repo,
    );

    expect(second.event.id).toBe(first.event.id);
    // Stale: allow retry.
    expect(second.duplicate).toBe(false);
  });

  it('Blocker 1 — create-conflict (durable repo) dedups by the winning row status (PROCESSED → duplicate)', async () => {
    // Simulate the read-then-create race a Postgres repo resolves via
    // INSERT ... ON CONFLICT DO NOTHING: findByIdempotencyKey misses
    // (the concurrent insert isn't visible yet), then create returns the
    // PRE-EXISTING row, which has a DIFFERENT id. handleWebhookEvent must
    // detect the id mismatch and dedup by that row's status.
    const winner = {
      id: 'winner-processed',
      source: 'stripe',
      eventType: 'charge.refunded',
      idempotencyKey: 'evt_race',
      payload: {} as Record<string, unknown>,
      status: 'processed' as const,
      createdAt: new Date(),
    };
    const repo = {
      findByIdempotencyKey: async () => null,
      create: async () => ({ ...winner }),
      updateStatus: async () => {},
    };

    const result = await handleWebhookEvent('stripe', 'charge.refunded', {}, 'evt_race', repo);
    expect(result.event.id).toBe('winner-processed');
    expect(result.duplicate).toBe(true);
  });

  it('Blocker 1 — create-conflict whose winning row FAILED still allows retry', async () => {
    const winner = {
      id: 'winner-failed',
      source: 'stripe',
      eventType: 'charge.refunded',
      idempotencyKey: 'evt_race2',
      payload: {} as Record<string, unknown>,
      status: 'failed' as const,
      createdAt: new Date(),
    };
    const repo = {
      findByIdempotencyKey: async () => null,
      create: async () => ({ ...winner }),
      updateStatus: async () => {},
    };

    const result = await handleWebhookEvent('stripe', 'charge.refunded', {}, 'evt_race2', repo);
    expect(result.event.id).toBe('winner-failed');
    expect(result.duplicate).toBe(false);
  });

  it('validation — malformed signature format rejected', () => {
    const valid = verifyWebhookSignature('payload', 'no-format', secret);
    expect(valid).toBe(false);
  });

  it('validation — rejects invalid hex in signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = verifyWebhookSignature(payload, `t=${timestamp},v1=not-valid-hex!@#$`, secret);
    expect(valid).toBe(false);
  });

  it('validation — rejects NaN timestamp', () => {
    const payload = JSON.stringify({ event: 'test' });
    const valid = verifyWebhookSignature(payload, 't=notanumber,v1=abcdef', secret);
    expect(valid).toBe(false);
  });
});

describe('Blocker 1 — createWebhookRouter durable-idempotency guard', () => {
  it('throws in production when no durable webhookRepo is supplied', () => {
    // Guard reads the raw process.env.NODE_ENV (defense-in-depth against an
    // unnormalized 'production'), so drive it via the env, not config.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const config = { NODE_ENV: 'prod' } as AppConfig;
      expect(() => createWebhookRouter(config, {})).toThrow(
        /durable webhookRepo is required in production/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
