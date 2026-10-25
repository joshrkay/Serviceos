/**
 * U7-05+ — the one-time backfill that rewrites legacy `webhook_events`
 * payloads to the write-time allowlist (src/webhooks/webhook-payload-backfill.ts).
 *
 * The loop is tested here against an in-memory store that honours the same
 * contract as the Pg store (keyset pages by id; a rewrite lands only while the
 * row still has the digest it was read with). The SQL is pinned at real
 * Postgres in test/integration/webhook-events-pii-backfill.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  runWebhookPayloadBackfill,
  type PayloadRewrite,
  type StoredReceiptRow,
  type WebhookPayloadBackfillStore,
} from '../../src/webhooks/webhook-payload-backfill';
import { minimizeWebhookPayload } from '../../src/webhooks/webhook-payload-allowlist';
import {
  findPii,
  clerkUserEvent,
  sendGridEventBatch,
  stripeCheckoutSessionData,
  twilioInboundSmsBody,
} from '../support/webhook-pii-fixtures';

interface Row {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
}

const digestOf = (payload: unknown): string => crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');

/** Keyset-paged, digest-guarded store over an array (ids sort as strings, like uuids). */
class FakeStore implements WebhookPayloadBackfillStore {
  readonly rows: Row[];
  readonly reads: Array<{ afterId: string | null; limit: number }> = [];
  readonly writes: PayloadRewrite[][] = [];
  /** Test hook: runs inside rewrite() before the digest check (a concurrent writer). */
  beforeRewrite?: () => void;

  constructor(rows: Row[]) {
    this.rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  }

  async readPage(afterId: string | null, limit: number): Promise<StoredReceiptRow[]> {
    this.reads.push({ afterId, limit });
    return this.rows
      .filter((r) => afterId === null || r.id > afterId)
      .slice(0, limit)
      .map((r) => ({ ...r, payload: structuredClone(r.payload), digest: digestOf(r.payload) }));
  }

  async rewrite(rewrites: readonly PayloadRewrite[]): Promise<number> {
    this.beforeRewrite?.();
    this.writes.push([...rewrites]);
    let n = 0;
    for (const w of rewrites) {
      const row = this.rows.find((r) => r.id === w.id);
      if (row && digestOf(row.payload) === w.digest) {
        row.payload = w.payload;
        n++;
      }
    }
    return n;
  }

  payload(id: string): unknown {
    return this.rows.find((r) => r.id === id)?.payload;
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111';

function legacyRows(): Row[] {
  return [
    {
      id: 'a1',
      source: 'stripe',
      eventType: 'checkout.session.completed',
      payload: stripeCheckoutSessionData({ tenantId: TENANT, invoiceId: TENANT, amountTotal: 500, paymentIntent: 'pi_1' }),
    },
    { id: 'a2', source: 'twilio', eventType: 'sms', payload: twilioInboundSmsBody('SM1', 'AC1') },
    { id: 'a3', source: 'one_tap_approve', eventType: 'one_tap_approve_nonce', payload: {} },
    { id: 'a4', source: 'legacy_unknown', eventType: 'x', payload: { email: 'jane.erasure@example.com' } },
    { id: 'a5', source: 'clerk', eventType: 'user.created', payload: clerkUserEvent('user.created', 'user_1') },
    {
      id: 'a6',
      source: 'sendgrid',
      eventType: 'event',
      // What the raw-mounted SendGrid route used to store.
      payload: JSON.parse(JSON.stringify({ events: Buffer.from(JSON.stringify(sendGridEventBatch('sg1'))) })),
    },
  ];
}

describe('runWebhookPayloadBackfill', () => {
  it('dry run (the default) counts what it would rewrite and writes nothing', async () => {
    const store = new FakeStore(legacyRows());
    const before = structuredClone(store.rows);
    const result = await runWebhookPayloadBackfill({ store, batchSize: 4 });
    expect(result).toEqual({
      apply: false,
      scanned: 6,
      rewritten: 4,
      alreadyMinimal: 1,
      skippedChanged: 0,
      unclassified: { legacy_unknown: 1 },
      batches: 2,
      lastId: 'a6',
      complete: true,
    });
    expect(store.writes).toEqual([]);
    expect(store.rows).toEqual(before);
  });

  it('apply rewrites every classified legacy row to exactly the write-time shape, page by page', async () => {
    const rows = legacyRows();
    const store = new FakeStore(rows);
    const result = await runWebhookPayloadBackfill({ store, apply: true, batchSize: 2 });
    expect(result).toMatchObject({ scanned: 6, rewritten: 4, alreadyMinimal: 1, batches: 3, lastId: 'a6', complete: true });
    // Three full pages, then an empty read that ends the run.
    expect(store.reads.map((r) => r.afterId)).toEqual([null, 'a2', 'a4', 'a6']);
    for (const row of rows) {
      if (row.source === 'legacy_unknown') continue;
      expect(store.payload(row.id)).toEqual(minimizeWebhookPayload(row.source, row.eventType, row.payload));
      expect(findPii(store.payload(row.id)), row.id).toEqual([]);
    }
    // A source with no policy is left exactly as found, and reported.
    expect(store.payload('a4')).toEqual({ email: 'jane.erasure@example.com' });
    expect(result.unclassified).toEqual({ legacy_unknown: 1 });
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const store = new FakeStore(legacyRows());
    await runWebhookPayloadBackfill({ store, apply: true, batchSize: 3 });
    const again = await runWebhookPayloadBackfill({ store, apply: true, batchSize: 3 });
    expect(again).toMatchObject({ scanned: 6, rewritten: 0, alreadyMinimal: 5, unclassified: { legacy_unknown: 1 } });
    expect(store.writes).toHaveLength(2); // both from the first run (pages a1-a3, a4-a6)
  });

  it('resumes from a cursor: maxBatches stops early and afterId picks up where it stopped', async () => {
    const store = new FakeStore(legacyRows());
    const first = await runWebhookPayloadBackfill({ store, apply: true, batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ scanned: 2, batches: 1, lastId: 'a2', complete: false });
    const rest = await runWebhookPayloadBackfill({ store, apply: true, batchSize: 2, afterId: first.lastId });
    expect(rest).toMatchObject({ scanned: 4, batches: 2, lastId: 'a6', complete: true });
    expect(first.rewritten + rest.rewritten).toBe(4);
  });

  it('never overwrites a row that changed after it was read (the digest guard)', async () => {
    const store = new FakeStore(legacyRows().slice(0, 2));
    store.beforeRewrite = () => {
      // e.g. an erase blanked a2 between the read and the write.
      store.rows[1].payload = {};
    };
    const result = await runWebhookPayloadBackfill({ store, apply: true, batchSize: 10 });
    expect(result).toMatchObject({ rewritten: 1, skippedChanged: 1 });
    expect(store.payload('a2')).toEqual({});
  });

  it('pauses between pages, not after the short last one, and reports each page', async () => {
    const store = new FakeStore(legacyRows().slice(0, 5));
    const sleep = vi.fn(async () => undefined);
    const pages: Array<{ batch: number; lastId: string }> = [];
    await runWebhookPayloadBackfill({
      store,
      apply: true,
      batchSize: 2,
      pauseMs: 25,
      sleep,
      onBatch: (p) => pages.push({ batch: p.batch, lastId: p.lastId }),
    });
    // Pages a1-a2, a3-a4, then the short page a5 ends the run.
    expect(sleep.mock.calls).toEqual([[25], [25]]);
    expect(pages).toEqual([
      { batch: 1, lastId: 'a2' },
      { batch: 2, lastId: 'a4' },
      { batch: 3, lastId: 'a5' },
    ]);
  });

  it('refuses a batch size outside 1..5000', async () => {
    const store = new FakeStore([]);
    await expect(runWebhookPayloadBackfill({ store, batchSize: 0 })).rejects.toThrow(/batchSize/);
    await expect(runWebhookPayloadBackfill({ store, batchSize: 5001 })).rejects.toThrow(/batchSize/);
    await expect(runWebhookPayloadBackfill({ store })).resolves.toMatchObject({ scanned: 0, complete: true });
  });
});
