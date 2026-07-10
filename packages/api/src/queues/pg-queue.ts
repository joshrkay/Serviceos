import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Queue, QueueConfig, QueueDepth, QueueMessage, DeadLetterEntry, SendOptions, redactForSink, toEnvelopeMeta } from './queue';
import { randomUUID } from 'crypto';

/**
 * Ceiling for the exponential visibility backoff in receiveBatch — a failed
 * message is never hidden longer than this between retries (15 min).
 */
const MAX_VISIBILITY_SECONDS = 900;

/**
 * Lightweight Postgres-backed queue using SELECT ... FOR UPDATE SKIP LOCKED.
 * Suitable for low-to-medium throughput workloads. For high throughput,
 * consider migrating to pg-boss.
 */
export class PgQueue extends PgBaseRepository implements Queue {
  private config: QueueConfig;
  // Promise-based init lock: the first caller kicks off the CREATE TABLE
  // DDL, concurrent callers await the same promise, and on failure the
  // promise is cleared so the next call retries from scratch.
  private initPromise?: Promise<void>;

  constructor(pool: Pool, config?: Partial<QueueConfig>) {
    super(pool);
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      visibilityTimeout: config?.visibilityTimeout ?? 30,
    };
  }

  private async ensureTable(client: import('pg').PoolClient): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _queue_messages (
          id UUID PRIMARY KEY,
          type TEXT NOT NULL,
          payload JSONB NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          idempotency_key TEXT NOT NULL,
          visible_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (idempotency_key)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS _queue_dlq (
          message_id UUID PRIMARY KEY,
          type TEXT NOT NULL,
          payload JSONB NOT NULL,
          attempts INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          error TEXT NOT NULL,
          failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })();
    try {
      await this.initPromise;
    } catch (err) {
      // Clear the cached failure so the next caller retries.
      this.initPromise = undefined;
      throw err;
    }
  }

  async send<T>(
    type: string,
    payload: T,
    idempotencyKey?: string,
    options?: SendOptions,
  ): Promise<string> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const id = randomUUID();
      const key = idempotencyKey ?? id;
      // Delayed delivery (UC-5 durable timers): visible_at = NOW() + delay so
      // receive/receiveBatch skip the row until the delay elapses. Delay 0 is
      // the pre-existing immediate path.
      const delaySeconds = Math.max(0, options?.delaySeconds ?? 0);
      await client.query(
        `INSERT INTO _queue_messages (id, type, payload, attempts, max_attempts, idempotency_key, visible_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' seconds')::interval, NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [id, type, JSON.stringify(payload), 0, this.config.maxRetries, key, String(delaySeconds)]
      );
      return id;
    });
  }

  async receive<T>(): Promise<QueueMessage<T> | null> {
    const [msg] = await this.receiveBatch<T>(1);
    return msg ?? null;
  }

  async receiveBatch<T>(max: number): Promise<QueueMessage<T>[]> {
    if (max <= 0) return [];
    return this.withClient(async (client) => {
      await this.ensureTable(client);

      await client.query('BEGIN');
      try {
        // Claim up to `max` oldest visible messages atomically. FOR UPDATE SKIP
        // LOCKED means concurrent ticks/replicas each grab a DISJOINT set — no
        // message is processed twice.
        //
        // visible_at scales with the (pre-increment) attempt count:
        // base * 2^attempts, capped. This gives failed messages exponential
        // retry backoff instead of hammering a struggling downstream every
        // `visibilityTimeout` seconds, and gives later attempts of slow jobs
        // a longer processing window before another replica re-claims them.
        const result = await client.query(
          `UPDATE _queue_messages
           SET attempts = attempts + 1,
               visible_at = NOW() + (LEAST($1::float * POWER(2, attempts), $2)::int || ' seconds')::interval
           WHERE id IN (
             SELECT id FROM _queue_messages
             WHERE visible_at <= NOW()
               AND attempts < max_attempts
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $3
           )
           RETURNING *`,
          [String(this.config.visibilityTimeout), String(MAX_VISIBILITY_SECONDS), max]
        );

        // Reap crash-orphans: a worker that died mid-processing on the FINAL
        // attempt leaves attempts == max_attempts in _queue_messages; the
        // claim filter (attempts < max_attempts) then skips the row forever
        // and it never reaches the DLQ — a silently stuck message. Move any
        // such expired rows to the DLQ (same redaction as moveToDeadLetter),
        // bounded per tick; SKIP LOCKED + ON CONFLICT keep concurrent
        // replicas idempotent.
        const orphans = await client.query(
          `DELETE FROM _queue_messages
           WHERE id IN (
             SELECT id FROM _queue_messages
             WHERE visible_at <= NOW()
               AND attempts >= max_attempts
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 10
           )
           RETURNING *`
        );
        for (const row of orphans.rows) {
          const orphan: QueueMessage = {
            id: row.id as string,
            type: row.type as string,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            attempts: Number(row.attempts),
            maxAttempts: Number(row.max_attempts),
            idempotencyKey: row.idempotency_key as string,
            createdAt: (row.created_at as Date).toISOString(),
          };
          await client.query(
            `INSERT INTO _queue_dlq (message_id, type, payload, attempts, idempotency_key, error)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (message_id) DO NOTHING`,
            [
              orphan.id,
              orphan.type,
              JSON.stringify(
                redactForSink(
                  { envelope: toEnvelopeMeta(orphan), payload: orphan.payload },
                  'dlq'
                )
              ),
              orphan.attempts,
              orphan.idempotencyKey,
              'orphaned: attempts exhausted without completion (worker died mid-processing)',
            ]
          );
        }

        await client.query('COMMIT');

        return result.rows
          .map((row) => ({
            id: row.id as string,
            type: row.type as string,
            payload: (typeof row.payload === 'string'
              ? JSON.parse(row.payload)
              : row.payload) as T,
            attempts: Number(row.attempts),
            maxAttempts: Number(row.max_attempts),
            idempotencyKey: row.idempotency_key as string,
            createdAt: (row.created_at as Date).toISOString(),
          }))
          // RETURNING order is unspecified; restore oldest-first claim order.
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      } catch (err) {
        // Guarded: on a broken connection the ROLLBACK itself rejects and
        // would replace `err`, hiding the real failure on the queue path.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  async delete(messageId: string): Promise<void> {
    await this.withClient(async (client) => {
      await this.ensureTable(client);
      await client.query(
        `DELETE FROM _queue_messages WHERE id = $1`,
        [messageId]
      );
    });
  }

  async moveToDeadLetter(message: QueueMessage, error: string): Promise<void> {
    await this.withClient(async (client) => {
      await this.ensureTable(client);
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO _queue_dlq (message_id, type, payload, attempts, idempotency_key, error)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (message_id) DO NOTHING`,
          [
            message.id,
            message.type,
            JSON.stringify(
              redactForSink(
                {
                  envelope: toEnvelopeMeta(message),
                  payload: message.payload,
                },
                'dlq'
              )
            ),
            message.attempts,
            message.idempotencyKey,
            error,
          ]
        );
        await client.query(`DELETE FROM _queue_messages WHERE id = $1`, [message.id]);
        await client.query('COMMIT');
      } catch (err) {
        // Guarded for the same reason as receiveBatch above.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  async listDeadLetter(): Promise<DeadLetterEntry[]> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const result = await client.query(
        `SELECT message_id, type, payload, attempts, idempotency_key, error, failed_at
         FROM _queue_dlq
         ORDER BY failed_at DESC`
      );
      return result.rows.map((row) => ({
        messageId: row.message_id as string,
        type: row.type as string,
        payload:
          typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        attempts: Number(row.attempts),
        idempotencyKey: row.idempotency_key as string,
        error: row.error as string,
        failedAt: (row.failed_at as Date).toISOString(),
      }));
    });
  }

  /**
   * Backlog snapshot for the scale-to-1000 depth SLO. Single round-trip: two
   * correlated COUNTs (main queue + DLQ). Cheap enough to sample on an interval;
   * never call it on the hot path.
   */
  async depth(): Promise<QueueDepth> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const res = await client.query<{ pending: string; dead_letter: string }>(
        `SELECT
           (SELECT COUNT(*) FROM _queue_messages) AS pending,
           (SELECT COUNT(*) FROM _queue_dlq)      AS dead_letter`,
      );
      return {
        pending: Number(res.rows[0].pending),
        deadLetter: Number(res.rows[0].dead_letter),
      };
    });
  }

  getConfig(): QueueConfig {
    return { ...this.config };
  }
}
