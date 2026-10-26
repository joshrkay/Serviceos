/**
 * U7-05+ — one-time backfill: rewrite legacy `webhook_events.payload` rows to
 * the write-time allowlist (webhook-payload-allowlist.ts).
 *
 * Rows written before U7-05+ hold whole provider bodies. The table is never
 * pruned and can be large (every Twilio callback, Stripe, Clerk and SendGrid
 * event since launch), so this is not a migration: a boot-corpus UPDATE over
 * the whole table would hold row locks on every row inside the deploy
 * transaction and can exceed its 25 s statement timeout. Instead an operator
 * runs scripts/backfill-webhook-events-minimize.ts once after the deploy that
 * minimizes new writes:
 *
 *   - Keyset pages over the primary key (`id > $cursor ORDER BY id LIMIT n`),
 *     each an index range scan; no OFFSET, no sequential rescans.
 *   - Each page is rewritten by ONE short autocommit UPDATE, keyed by id, that
 *     locks only that page's changed rows (row locks, never a table lock) and
 *     only the payload column changes, so status/processed_at/created_at and
 *     the unique (source, idempotency_key) key are untouched: dedup and replay
 *     behave exactly as before.
 *   - Compare-and-swap: the UPDATE lands only where `md5(payload::text)` still
 *     equals the digest read with the page, so a payload changed in between
 *     (a later U7 erase blanking it) is never overwritten with older content.
 *   - Idempotent (minimizing a minimized payload is a no-op, and unchanged rows
 *     are not written) and resumable: every page reports its last id, which
 *     `--after` resumes from. Rows inserted after the deploy are already
 *     minimal, so a uuid cursor that skips them loses nothing.
 *   - A source with no policy is left exactly as found and reported by count,
 *     so the operator can classify it rather than have it blanked blind.
 *
 * Cost on a large table: one PK range read per page plus a rewrite of only the
 * rows that change. Each rewritten row is a new tuple (the old one is dead
 * until autovacuum), so dead-tuple volume and WAL are bounded by the legacy
 * rows' new (smaller) size; `pauseMs` spaces pages to cap the write rate.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { hasWebhookPayloadPolicy, minimizeWebhookPayload, type WebhookPayload } from './webhook-payload-allowlist';

/** One receipt as read for the backfill. `digest` is `md5(payload::text)`. */
export interface StoredReceiptRow {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
  digest: string;
}

export interface PayloadRewrite {
  id: string;
  /** The digest the row was read with: the write lands only if it still matches. */
  digest: string;
  payload: WebhookPayload;
}

export interface WebhookPayloadBackfillStore {
  /** Up to `limit` rows with id > `afterId` (from the start when null), by id. */
  readPage(afterId: string | null, limit: number): Promise<StoredReceiptRow[]>;
  /** Applies each rewrite whose row still has its digest; resolves how many landed. */
  rewrite(rewrites: readonly PayloadRewrite[]): Promise<number>;
}

export const WEBHOOK_BACKFILL_DEFAULT_BATCH_SIZE = 500;
export const WEBHOOK_BACKFILL_MAX_BATCH_SIZE = 5000;

export interface WebhookPayloadBackfillProgress {
  batch: number;
  /** The resume cursor: pass it as `afterId` to continue after this page. */
  lastId: string;
  scanned: number;
  rewritten: number;
}

export interface WebhookPayloadBackfillOptions {
  store: WebhookPayloadBackfillStore;
  /** Write the rewrites. Default false: a dry run that only counts them. */
  apply?: boolean;
  batchSize?: number;
  /** Resume after this id (a previous run's `lastId`). */
  afterId?: string | null;
  /** Stop after this many pages (the run then reports complete=false). */
  maxBatches?: number;
  /** Wait between full pages, to cap the write rate on a busy primary. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onBatch?: (progress: WebhookPayloadBackfillProgress) => void;
}

export interface WebhookPayloadBackfillResult {
  apply: boolean;
  scanned: number;
  /** Rows rewritten (apply) or that would be (dry run). */
  rewritten: number;
  /** Rows already in their minimized shape. */
  alreadyMinimal: number;
  /** Rewrites refused because the row changed after it was read (apply only). */
  skippedChanged: number;
  /** Rows left untouched because their source has no policy, by source. */
  unclassified: Record<string, number>;
  batches: number;
  /** The last id scanned: the cursor to resume from. Null when nothing was scanned. */
  lastId: string | null;
  /** True when the run reached the end of the table. */
  complete: boolean;
}

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runWebhookPayloadBackfill(opts: WebhookPayloadBackfillOptions): Promise<WebhookPayloadBackfillResult> {
  const batchSize = opts.batchSize ?? WEBHOOK_BACKFILL_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > WEBHOOK_BACKFILL_MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer in 1..${WEBHOOK_BACKFILL_MAX_BATCH_SIZE}`);
  }
  const apply = opts.apply ?? false;
  const sleep = opts.sleep ?? defaultSleep;
  const result: WebhookPayloadBackfillResult = {
    apply,
    scanned: 0,
    rewritten: 0,
    alreadyMinimal: 0,
    skippedChanged: 0,
    unclassified: {},
    batches: 0,
    lastId: opts.afterId ?? null,
    complete: false,
  };

  let cursor = opts.afterId ?? null;
  for (;;) {
    if (opts.maxBatches !== undefined && result.batches >= opts.maxBatches) break;
    const rows = await opts.store.readPage(cursor, batchSize);
    if (rows.length === 0) {
      result.complete = true;
      break;
    }
    result.batches += 1;

    const rewrites: PayloadRewrite[] = [];
    for (const row of rows) {
      result.scanned += 1;
      if (!hasWebhookPayloadPolicy(row.source)) {
        result.unclassified[row.source] = (result.unclassified[row.source] ?? 0) + 1;
        continue;
      }
      const minimized = minimizeWebhookPayload(row.source, row.eventType, row.payload);
      if (canonical(minimized) === canonical(row.payload)) {
        result.alreadyMinimal += 1;
        continue;
      }
      rewrites.push({ id: row.id, digest: row.digest, payload: minimized });
    }

    if (!apply) {
      result.rewritten += rewrites.length;
    } else if (rewrites.length > 0) {
      const landed = await opts.store.rewrite(rewrites);
      result.rewritten += landed;
      result.skippedChanged += rewrites.length - landed;
    }

    cursor = rows[rows.length - 1].id;
    result.lastId = cursor;
    opts.onBatch?.({ batch: result.batches, lastId: cursor, scanned: result.scanned, rewritten: result.rewritten });

    if (rows.length < batchSize) {
      result.complete = true;
      break;
    }
    if (opts.pauseMs) await sleep(opts.pauseMs);
  }
  return result;
}

/**
 * The Pg store. `webhook_events` is global (no tenant_id, no RLS), so it runs
 * on the principal through `withClient`, like the receipt repositories.
 */
export class PgWebhookPayloadBackfillStore extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async readPage(afterId: string | null, limit: number): Promise<StoredReceiptRow[]> {
    return this.withClient(async (client) => {
      const { rows } =
        afterId === null
          ? await client.query(
              `SELECT id, source, event_type, payload, md5(payload::text) AS digest
                 FROM webhook_events
                ORDER BY id
                LIMIT $1`,
              [limit],
            )
          : await client.query(
              `SELECT id, source, event_type, payload, md5(payload::text) AS digest
                 FROM webhook_events
                WHERE id > $1::uuid
                ORDER BY id
                LIMIT $2`,
              [afterId, limit],
            );
      return rows.map((r) => ({
        id: r.id as string,
        source: r.source as string,
        eventType: r.event_type as string,
        payload: r.payload as unknown,
        digest: r.digest as string,
      }));
    });
  }

  async rewrite(rewrites: readonly PayloadRewrite[]): Promise<number> {
    if (rewrites.length === 0) return 0;
    return this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE webhook_events AS we
            SET payload = v.payload
           FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, digest text, payload jsonb)
          WHERE we.id = v.id
            AND md5(we.payload::text) = v.digest`,
        [JSON.stringify(rewrites)],
      );
      return result.rowCount ?? 0;
    });
  }
}
