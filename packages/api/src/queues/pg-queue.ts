import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Queue, QueueConfig, QueueMessage } from './queue';
import { randomUUID } from 'crypto';

/**
 * Lightweight Postgres-backed queue using SELECT ... FOR UPDATE SKIP LOCKED.
 * Suitable for low-to-medium throughput workloads. For high throughput,
 * consider migrating to pg-boss.
 */
export class PgQueue extends PgBaseRepository implements Queue {
  private config: QueueConfig;
  private initialized = false;

  constructor(pool: Pool, config?: Partial<QueueConfig>) {
    super(pool);
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      visibilityTimeout: config?.visibilityTimeout ?? 30,
    };
  }

  private async ensureTable(client: import('pg').PoolClient): Promise<void> {
    if (this.initialized) return;
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
    this.initialized = true;
  }

  async send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const id = randomUUID();
      const key = idempotencyKey ?? id;
      await client.query(
        `INSERT INTO _queue_messages (id, type, payload, attempts, max_attempts, idempotency_key, visible_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [id, type, JSON.stringify(payload), 0, this.config.maxRetries, key]
      );
      return id;
    });
  }

  async receive<T>(): Promise<QueueMessage<T> | null> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);

      await client.query('BEGIN');
      try {
        const result = await client.query(
          `UPDATE _queue_messages
           SET attempts = attempts + 1,
               visible_at = NOW() + ($1 || ' seconds')::interval
           WHERE id = (
             SELECT id FROM _queue_messages
             WHERE visible_at <= NOW()
               AND attempts < max_attempts
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           RETURNING *`,
          [String(this.config.visibilityTimeout)]
        );
        await client.query('COMMIT');

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
          id: row.id as string,
          type: row.type as string,
          payload: (typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : row.payload) as T,
          attempts: Number(row.attempts),
          maxAttempts: Number(row.max_attempts),
          idempotencyKey: row.idempotency_key as string,
          createdAt: (row.created_at as Date).toISOString(),
        };
      } catch (err) {
        await client.query('ROLLBACK');
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

  getConfig(): QueueConfig {
    return { ...this.config };
  }
}
