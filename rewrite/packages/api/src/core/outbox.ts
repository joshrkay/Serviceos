import type { Db } from './db';
import type { JobRunner } from './jobs';

/**
 * Drains undispatched outbox rows into pg-boss. Called after every command
 * commit (event-driven, keeps latency low) and from a cron backstop (crash
 * recovery). Rows with not_before in the future are dispatched immediately
 * with startAfter so pg-boss owns the delay (e.g. proposal undo windows).
 *
 * FOR UPDATE SKIP LOCKED makes concurrent drains safe across instances;
 * singletonKey + idempotent consumers cover the crash-between-send-and-mark
 * window.
 */
export async function drainOutbox(db: Db, jobs: JobRunner): Promise<number> {
  const client = await db.admin.connect();
  let dispatched = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      topic: string;
      payload: Record<string, unknown>;
      not_before: Date | null;
    }>(
      `SELECT id, tenant_id, topic, payload, not_before
       FROM outbox
       WHERE dispatched_at IS NULL
       ORDER BY created_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      await jobs.send(
        row.topic,
        { ...row.payload, tenantId: row.tenant_id, outboxId: row.id },
        {
          singletonKey: row.id,
          startAfter: row.not_before && row.not_before > new Date() ? row.not_before : undefined,
        },
      );
      await client.query('UPDATE outbox SET dispatched_at = now() WHERE id = $1', [row.id]);
      dispatched += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return dispatched;
}

/** Serialized, coalescing after-commit drain trigger. */
export function createOutboxDispatcher(db: Db, jobs: JobRunner): () => void {
  let running = false;
  let pending = false;
  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await drainOutbox(db, jobs);
      } while (pending);
    } catch (err) {
      console.error('[outbox] drain failed', { message: (err as Error).message });
    } finally {
      running = false;
    }
  };
  return () => {
    void run();
  };
}
