/**
 * P0-020 — PgWebhookEventRepository
 *
 * Verifies the idempotency contract that prevents duplicate Stripe / Clerk
 * webhooks from double-processing:
 *   * recordReceipt inserts on first sight, returns inserted=true.
 *   * recordReceipt with same (provider, event_id) returns inserted=false
 *     and the existing row — no second INSERT into the table.
 *   * markProcessed / markFailed update status correctly.
 *   * findUnprocessed returns rows in `received` order.
 *   * findById returns null for unknown ids.
 *
 * Uses the same lightweight pool-stub pattern as
 * `test/auth/platform-admin.test.ts` so the suite stays unit-style and
 * does not need a live Postgres.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface PoolStubBehavior {
  // Per-query handlers, matched in order against the first INSERT/SELECT/UPDATE.
  responses?: Array<{
    match: RegExp;
    rows?: Array<Record<string, unknown>>;
    rowCount?: number;
  }>;
}

function makePoolStub(behavior: PoolStubBehavior = {}) {
  const calls: QueryCall[] = [];
  const responses = [...(behavior.responses ?? [])];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const idx = responses.findIndex((r) => r.match.test(sql));
      if (idx === -1) {
        return { rows: [], rowCount: 0 };
      }
      const [match] = responses.splice(idx, 1);
      const rows = match.rows ?? [];
      return { rows, rowCount: match.rowCount ?? rows.length };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
  return { pool, client, calls };
}

const NOW = new Date('2026-04-28T10:00:00Z');

describe('P0-020 — PgWebhookEventRepository', () => {
  it('recordReceipt: first sight returns inserted=true and the new row', async () => {
    const { pool, client, calls } = makePoolStub({
      responses: [
        {
          match: /INSERT INTO webhook_events/i,
          rows: [
            {
              id: 'wh-1',
              source: 'stripe',
              idempotency_key: 'evt_123',
              event_type: 'payment_intent.succeeded',
              payload: JSON.stringify({ amount: 1000 }),
              created_at: NOW.toISOString(),
              processed_at: null,
              error_message: null,
            },
          ],
          rowCount: 1,
        },
      ],
    });

    const repo = new PgWebhookEventRepository(pool as never);
    const result = await repo.recordReceipt(
      'stripe',
      'evt_123',
      'payment_intent.succeeded',
      { amount: 1000 },
    );

    expect(result.inserted).toBe(true);
    expect(result.record.provider).toBe('stripe');
    expect(result.record.eventId).toBe('evt_123');
    expect(result.record.eventType).toBe('payment_intent.succeeded');
    expect(result.record.payload).toEqual({ amount: 1000 });
    expect(result.record.processedAt).toBeNull();
    expect(result.record.processingError).toBeNull();

    // Only one query — no follow-up SELECT when INSERT actually inserted.
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(source, idempotency_key\) DO NOTHING/);
    expect(calls[0].params).toEqual([
      'stripe',
      'payment_intent.succeeded',
      'evt_123',
      JSON.stringify({ amount: 1000 }),
    ]);
  });

  it('recordReceipt: duplicate (provider, event_id) returns inserted=false (idempotency)', async () => {
    const existingRow = {
      id: 'wh-1',
      source: 'stripe',
      idempotency_key: 'evt_123',
      event_type: 'payment_intent.succeeded',
      payload: JSON.stringify({ amount: 1000 }),
      created_at: NOW.toISOString(),
      processed_at: null,
      error_message: null,
    };

    const { pool, client, calls } = makePoolStub({
      responses: [
        // INSERT hits the unique constraint and DO NOTHING returns 0 rows.
        { match: /INSERT INTO webhook_events/i, rows: [], rowCount: 0 },
        // Follow-up SELECT fetches the existing row.
        { match: /SELECT \* FROM webhook_events/i, rows: [existingRow] },
      ],
    });

    const repo = new PgWebhookEventRepository(pool as never);
    const result = await repo.recordReceipt(
      'stripe',
      'evt_123',
      'payment_intent.succeeded',
      { amount: 1000 },
    );

    expect(result.inserted).toBe(false);
    expect(result.record.id).toBe('wh-1');
    expect(result.record.provider).toBe('stripe');
    expect(result.record.eventId).toBe('evt_123');

    // INSERT then a SELECT to surface the existing row to the caller.
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(calls[0].sql).toMatch(/INSERT INTO webhook_events/);
    expect(calls[1].sql).toMatch(/SELECT \* FROM webhook_events/);
  });

  it('recordReceipt: throws if conflict is reported but row missing (defensive)', async () => {
    const { pool } = makePoolStub({
      responses: [
        { match: /INSERT INTO webhook_events/i, rows: [], rowCount: 0 },
        { match: /SELECT \* FROM webhook_events/i, rows: [] },
      ],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    await expect(
      repo.recordReceipt('stripe', 'evt_x', 'evt', {}),
    ).rejects.toThrow(/conflict reported but row missing/);
  });

  it('recordReceipt: validates required arguments', async () => {
    const { pool } = makePoolStub();
    const repo = new PgWebhookEventRepository(pool as never);
    await expect(repo.recordReceipt('', 'e', 't', {})).rejects.toThrow(/provider is required/);
    await expect(repo.recordReceipt('p', '', 't', {})).rejects.toThrow(/eventId is required/);
  });

  it('markProcessed: writes status=processed and clears error_message', async () => {
    const { pool, calls } = makePoolStub({
      responses: [{ match: /UPDATE webhook_events/i, rowCount: 1 }],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    await repo.markProcessed('stripe', 'evt_123');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SET status = 'processed'/);
    expect(calls[0].sql).toMatch(/processed_at = NOW\(\)/);
    expect(calls[0].sql).toMatch(/error_message = NULL/);
    expect(calls[0].params).toEqual(['stripe', 'evt_123']);
  });

  it('markFailed: records the error string against the matching row', async () => {
    const { pool, calls } = makePoolStub({
      responses: [{ match: /UPDATE webhook_events/i, rowCount: 1 }],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    await repo.markFailed('stripe', 'evt_123', 'downstream API 500');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SET status = 'failed'/);
    expect(calls[0].sql).toMatch(/error_message = \$3/);
    expect(calls[0].params).toEqual(['stripe', 'evt_123', 'downstream API 500']);
  });

  it('findById: returns null when no row matches', async () => {
    const { pool } = makePoolStub({
      responses: [{ match: /SELECT \* FROM webhook_events/i, rows: [] }],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    const result = await repo.findById('stripe', 'evt_missing');
    expect(result).toBeNull();
  });

  it('findById: maps a stored row into the WebhookEventRecord shape', async () => {
    const processedAt = new Date('2026-04-28T11:00:00Z');
    const { pool } = makePoolStub({
      responses: [
        {
          match: /SELECT \* FROM webhook_events/i,
          rows: [
            {
              id: 'wh-9',
              source: 'clerk',
              idempotency_key: 'msg_abc',
              event_type: 'user.created',
              payload: { data: { id: 'usr_1' } }, // already-decoded JSONB
              created_at: NOW.toISOString(),
              processed_at: processedAt.toISOString(),
              error_message: null,
            },
          ],
        },
      ],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    const result = await repo.findById('clerk', 'msg_abc');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('wh-9');
    expect(result?.provider).toBe('clerk');
    expect(result?.eventId).toBe('msg_abc');
    expect(result?.eventType).toBe('user.created');
    expect(result?.payload).toEqual({ data: { id: 'usr_1' } });
    expect(result?.processedAt?.getTime()).toBe(processedAt.getTime());
  });

  it('findUnprocessed: returns received-status rows in arrival order with default limit', async () => {
    const { pool, calls } = makePoolStub({
      responses: [
        {
          match: /SELECT \* FROM webhook_events/i,
          rows: [
            {
              id: 'wh-1',
              source: 'stripe',
              idempotency_key: 'evt_a',
              event_type: 'payment_intent.succeeded',
              payload: '{}',
              created_at: NOW.toISOString(),
              processed_at: null,
              error_message: null,
            },
            {
              id: 'wh-2',
              source: 'stripe',
              idempotency_key: 'evt_b',
              event_type: 'payment_intent.succeeded',
              payload: '{}',
              created_at: NOW.toISOString(),
              processed_at: null,
              error_message: null,
            },
          ],
        },
      ],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    const result = await repo.findUnprocessed();

    expect(result).toHaveLength(2);
    expect(result[0].eventId).toBe('evt_a');
    expect(result[1].eventId).toBe('evt_b');
    expect(calls[0].sql).toMatch(/WHERE status = 'received'/);
    expect(calls[0].sql).toMatch(/ORDER BY created_at ASC/);
    expect(calls[0].params).toEqual([100]);
  });

  it('findUnprocessed: clamps invalid limit to default and floors fractional', async () => {
    const { pool, calls } = makePoolStub({
      responses: [
        { match: /SELECT \* FROM webhook_events/i, rows: [] },
        { match: /SELECT \* FROM webhook_events/i, rows: [] },
      ],
    });
    const repo = new PgWebhookEventRepository(pool as never);
    await repo.findUnprocessed(0);
    await repo.findUnprocessed(7.9);
    expect(calls[0].params).toEqual([100]);
    expect(calls[1].params).toEqual([7]);
  });
});
