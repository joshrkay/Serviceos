/**
 * U7-05+ — the one-time `webhook_events` payload backfill at REAL Postgres.
 *
 * Seeds receipts exactly as the pre-U7-05+ writers stored them (raw INSERTs
 * of full provider bodies, the SendGrid Buffer included), then runs the
 * backfill through `PgWebhookPayloadBackfillStore` (the store the operator
 * script uses) and pins:
 *   - every classified legacy row ends up byte-for-byte the write-time shape,
 *     with no personal value left; a row from a source with no policy is left
 *     untouched and reported;
 *   - dedup columns (status, processed_at, error_message, created_at) and the
 *     unique key are untouched, so a redelivery is still a duplicate;
 *   - the money-reconciliation L5 gate still matches and still flags on the
 *     backfilled checkout receipts;
 *   - a second run rewrites nothing, a dry run writes nothing, and a rewrite
 *     whose digest is stale (the row changed since it was read) is refused.
 *
 * The table is shared by the whole integration run, so assertions are scoped
 * to the rows seeded here; run-wide counts are only bounded.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/webhook-events-pii-backfill.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, type TestTenant } from './shared';
import { seedPaidInvoice } from './money-reconciliation-seed';
import {
  PgWebhookPayloadBackfillStore,
  runWebhookPayloadBackfill,
} from '../../src/webhooks/webhook-payload-backfill';
import { minimizeWebhookPayload } from '../../src/webhooks/webhook-payload-allowlist';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import { PgMoneyReconciliationReader, runMoneyReconciliationSweep } from '../../src/workers/money-reconciliation';
import { createLogger } from '../../src/logging/logger';
import {
  findPii,
  clerkUserEvent,
  sendGridEventBatch,
  stripeAccountUpdatedData,
  stripeChargeRefundedData,
  stripeCheckoutSessionData,
  stripeDisputeCreatedData,
  twilioInboundSmsBody,
} from '../support/webhook-pii-fixtures';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

interface Seeded {
  id: string;
  source: string;
  eventType: string;
  key: string;
  legacy: Record<string, unknown>;
}

describe('webhook_events legacy payload backfill (real Postgres)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  const seeded: Seeded[] = [];
  let checkoutMatched = '';
  let checkoutMismatched = '';
  let unknownRow: Seeded;
  let twilioRow: Seeded;

  async function seedLegacy(
    source: string,
    eventType: string,
    legacy: Record<string, unknown>,
    status: 'received' | 'processed' | 'failed' = 'processed',
  ): Promise<Seeded> {
    const id = crypto.randomUUID();
    const key = `${source}_${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO webhook_events (id, source, event_type, idempotency_key, payload, status, error_message, processed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $6 = 'processed' THEN NOW() END)`,
      [id, source, eventType, key, JSON.stringify(legacy), status, status === 'failed' ? 'handler threw' : null],
    );
    const row = { id, source, eventType, key, legacy };
    seeded.push(row);
    return row;
  }

  async function rowsById(): Promise<Map<string, Record<string, unknown>>> {
    const { rows } = await pool.query(
      `SELECT id, source, event_type, idempotency_key, payload, status, error_message, processed_at, created_at
         FROM webhook_events WHERE id = ANY($1::uuid[])`,
      [seeded.map((s) => s.id)],
    );
    return new Map(rows.map((r) => [r.id as string, r as Record<string, unknown>]));
  }

  const dedupColumns = (r: Record<string, unknown> | undefined) => ({
    source: r?.source,
    event_type: r?.event_type,
    idempotency_key: r?.idempotency_key,
    status: r?.status,
    error_message: r?.error_message,
    processed_at: r?.processed_at,
    created_at: r?.created_at,
  });

  let before: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    const matchedIntent = `pi_${crypto.randomUUID()}`;
    const mismatchIntent = `pi_${crypto.randomUUID()}`;
    const invMatch = await seedPaidInvoice(pool, tenant, { amountCents: 30000, paymentIntent: matchedIntent });
    const invMismatch = await seedPaidInvoice(pool, tenant, { amountCents: 20000, paymentIntent: mismatchIntent });

    checkoutMatched = (
      await seedLegacy(
        'stripe',
        'checkout.session.completed',
        stripeCheckoutSessionData({
          tenantId: tenant.tenantId,
          invoiceId: invMatch,
          amountTotal: 30000,
          paymentIntent: { id: matchedIntent, object: 'payment_intent', receipt_email: 'jane.erasure@example.com' } as unknown as string,
        }),
      )
    ).id;
    checkoutMismatched = (
      await seedLegacy(
        'stripe',
        'checkout.session.completed',
        stripeCheckoutSessionData({ tenantId: tenant.tenantId, invoiceId: invMismatch, amountTotal: 30000, paymentIntent: mismatchIntent }),
      )
    ).id;
    const ids = { tenantId: tenant.tenantId, invoiceId: invMatch };
    await seedLegacy('stripe', 'charge.refunded', stripeChargeRefundedData({ ...ids, paymentId: crypto.randomUUID() }), 'failed');
    await seedLegacy('stripe', 'charge.dispute.created', stripeDisputeCreatedData(ids));
    await seedLegacy('stripe', 'account.updated', stripeAccountUpdatedData());
    await seedLegacy('clerk', 'user.created', clerkUserEvent('user.created', `user_${crypto.randomUUID()}`));
    twilioRow = await seedLegacy('twilio', 'sms', twilioInboundSmsBody(`SM${crypto.randomUUID().replace(/-/g, '')}`, 'ACbf'));
    // The raw-mounted SendGrid route stored the request Buffer.
    await seedLegacy(
      'sendgrid',
      'event',
      JSON.parse(JSON.stringify({ events: Buffer.from(JSON.stringify(sendGridEventBatch('sg-bf-1'))) })),
    );
    await seedLegacy('vapi', 'call.ended', { tenantId: tenant.tenantId, fromE164: '+15125550147' }, 'received');
    await seedLegacy('one_tap_approve', 'one_tap_approve_nonce', {});
    unknownRow = await seedLegacy('legacy_unknown_source', 'x', { email: 'jane.erasure@example.com' });

    for (const s of seeded) {
      if (s.source !== 'one_tap_approve') expect(findPii(s.legacy).length, s.source).toBeGreaterThan(0);
    }
    before = await rowsById();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a dry run (the default) changes no row', async () => {
    const result = await runWebhookPayloadBackfill({ store: new PgWebhookPayloadBackfillStore(pool), batchSize: 3 });
    expect(result.apply).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.rewritten).toBeGreaterThanOrEqual(9);
    const after = await rowsById();
    for (const s of seeded) expect(after.get(s.id)?.payload, s.source).toEqual(before.get(s.id)?.payload);
  });

  it('apply rewrites every classified legacy row to the write-time shape and leaves the dedup columns alone', async () => {
    const result = await runWebhookPayloadBackfill({
      store: new PgWebhookPayloadBackfillStore(pool),
      apply: true,
      batchSize: 3,
    });
    expect(result.complete).toBe(true);
    expect(result.skippedChanged).toBe(0);
    expect(result.rewritten).toBeGreaterThanOrEqual(9);
    expect(result.unclassified.legacy_unknown_source).toBeGreaterThanOrEqual(1);

    const after = await rowsById();
    for (const s of seeded) {
      const row = after.get(s.id);
      expect(dedupColumns(row), s.source).toEqual(dedupColumns(before.get(s.id)));
      if (s === unknownRow) {
        expect(row?.payload).toEqual(s.legacy);
        continue;
      }
      expect(row?.payload, `${s.source} ${s.eventType}`).toEqual(minimizeWebhookPayload(s.source, s.eventType, s.legacy));
      expect(findPii(row?.payload), `${s.source} ${s.eventType}`).toEqual([]);
    }
  });

  it('the money-reconciliation L5 gate still matches and still flags on backfilled receipts', async () => {
    const summary = await runMoneyReconciliationSweep({
      reader: new PgMoneyReconciliationReader(pool),
      listTenantIds: async () => [tenant.tenantId],
      logger,
    });
    expect(summary.failedTenants).toBe(0);
    expect(summary.gates.l5).toEqual({ checked: 2, violations: 1, unverifiable: 0 });
    expect(summary.violatingEventIds).toEqual([checkoutMismatched]);
    expect(summary.violatingEventIds).not.toContain(checkoutMatched);
  });

  it('a redelivery of a backfilled receipt is still a processed duplicate', async () => {
    const replay = await new PgWebhookEventRepository(pool).recordReceipt(
      'twilio',
      twilioRow.key,
      'sms',
      twilioInboundSmsBody(twilioRow.key, 'ACbf'),
    );
    expect(replay.inserted).toBe(false);
    expect(replay.record.processedAt).toBeInstanceOf(Date);
    expect(replay.record.id).toBe(twilioRow.id);
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const result = await runWebhookPayloadBackfill({
      store: new PgWebhookPayloadBackfillStore(pool),
      apply: true,
      batchSize: 500,
    });
    expect(result.rewritten).toBe(0);
    expect(result.complete).toBe(true);
  });

  it('refuses a rewrite whose digest no longer matches the row', async () => {
    const store = new PgWebhookPayloadBackfillStore(pool);
    // Page through by id (the shared table holds other files' rows too).
    let cursor: string | null = null;
    let row: Awaited<ReturnType<typeof store.readPage>>[number] | undefined;
    for (;;) {
      const page = await store.readPage(cursor, 1000);
      row = page.find((r) => r.id === unknownRow.id);
      if (row || page.length < 1000) break;
      cursor = page[page.length - 1].id;
    }
    expect(row?.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.payload).toEqual(unknownRow.legacy);

    expect(await store.rewrite([{ id: unknownRow.id, digest: '0'.repeat(32), payload: {} }])).toBe(0);
    expect((await rowsById()).get(unknownRow.id)?.payload).toEqual(unknownRow.legacy);
    // With the digest it was read with, the same rewrite lands.
    expect(await store.rewrite([{ id: unknownRow.id, digest: row!.digest, payload: { blanked: true } }])).toBe(1);
    expect((await rowsById()).get(unknownRow.id)?.payload).toEqual({ blanked: true });
  });
});
