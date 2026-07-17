import { randomUUID } from 'crypto';
import { Logger } from '../logging/logger';
import { createHash } from 'crypto';

type RedactionSink = 'worker' | 'dlq';

export function redactForSink<T>(input: T, _sink: RedactionSink): T {
  // Single policy gate for worker logs + DLQ metadata.
  return sanitizePayloadSnapshot(input) as T;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sanitizePayloadSnapshot(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return input.length > 160 ? `${input.slice(0, 160)}…` : input;
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.slice(0, 10).map((v) => sanitizePayloadSnapshot(v));

  const record = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && /transcript|content|text/i.test(key)) {
      out[key] = {
        excerpt: value.slice(0, 160),
        fingerprint: hashString(value),
      };
      continue;
    }
    out[key] = sanitizePayloadSnapshot(value);
  }
  return out;
}

export function toEnvelopeMeta(message: QueueMessage<unknown>): Record<string, unknown> {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : undefined;
  const correlationId =
    typeof payload.correlationId === 'string'
      ? payload.correlationId
      : typeof payload.correlation_id === 'string'
        ? payload.correlation_id
        : undefined;

  return {
    job_id: message.id,
    tenant_id: tenantId,
    type: message.type,
    attempt: message.attempts,
    correlation_id: correlationId,
  };
}

function parseBoundedDebugMode(): boolean {
  const value = process.env.WORKER_DEBUG_BOUNDED;
  return value === '1' || value === 'true';
}

export interface QueueMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface QueueConfig {
  maxRetries: number;
  visibilityTimeout: number;
}

/** Optional per-message send options. */
export interface SendOptions {
  /**
   * Delayed delivery: the message stays invisible to receive/receiveBatch
   * until `delaySeconds` from now (UC-5: durable timers — e.g. the emergency
   * page-retry ladder's 2-minute steps are delayed enqueues, not setTimeout).
   * PgQueue maps this onto `visible_at`; fractional seconds are honored.
   */
  delaySeconds?: number;
}

export interface DeadLetterEntry {
  messageId: string;
  type: string;
  payload: unknown;
  attempts: number;
  idempotencyKey: string;
  error: string;
  failedAt: string;
  diagnostics?: Record<string, unknown>;
}

export interface Queue {
  send<T>(
    type: string,
    payload: T,
    idempotencyKey?: string,
    options?: SendOptions,
  ): Promise<string>;
  receive<T>(): Promise<QueueMessage<T> | null>;
  /**
   * Scale-to-1000 (P3): atomically claim up to `max` visible messages in one
   * round-trip (oldest first), so the poll loop can process a batch concurrently
   * per tick instead of one message per tick. Same claim semantics as receive()
   * — each message is claimed by exactly one consumer (FOR UPDATE SKIP LOCKED in
   * PgQueue), attempts incremented, visibility extended. Returns [] when idle.
   */
  receiveBatch<T>(max: number): Promise<QueueMessage<T>[]>;
  delete(messageId: string): Promise<void>;
  moveToDeadLetter(message: QueueMessage, error: string): Promise<void>;
  listDeadLetter(): Promise<DeadLetterEntry[]>;
  /**
   * Current queue backlog for observability (scale-to-1000 C1 SLO: PgQueue
   * depth < 1,000 sustained). `pending` = rows still in the main queue table
   * (waiting + in-flight/invisible); `deadLetter` = DLQ rows. A cheap COUNT,
   * sampled by a leader-elected interval — never called on the hot path.
   */
  depth(): Promise<QueueDepth>;
  /**
   * WS15 (SLO monitor) — count of pending messages older than
   * `olderThanSeconds`. The poll loop drains every second, so an old pending
   * row means the queue is STUCK (dead poller, wedged handler, poison-retry
   * loop) — the staleness signal the queue_staleness SLO alerts on, distinct
   * from raw depth (which a healthy burst can also raise). Cheap COUNT on an
   * interval — never called on the hot path.
   */
  stalePendingCount(olderThanSeconds: number): Promise<number>;
  getConfig(): QueueConfig;
}

export interface QueueDepth {
  pending: number;
  deadLetter: number;
}

export function createQueueConfig(env: string): QueueConfig {
  return {
    maxRetries: env === 'prod' ? 5 : 3,
    // First-claim processing window. Slow handlers (media transcription +
    // LLM correction pass) routinely exceed 30s; the unified poll loop runs
    // on EVERY replica, so a window shorter than the slowest handler lets a
    // second replica re-claim an in-flight message and double-process it
    // (double provider spend, re-fired downstream hooks). Retries back off
    // exponentially from this base (see PgQueue.receiveBatch).
    visibilityTimeout: 120,
  };
}

/**
 * In-memory queue for testing only. Not safe for production use.
 * Production uses pg-boss (Postgres-backed job queue) — no separate
 * queue service required since Railway Postgres is already provisioned.
 */
export class InMemoryQueue implements Queue {
  private messages: Array<QueueMessage & { visibleAt: number }> = [];
  private dlq: DeadLetterEntry[] = [];
  private config: QueueConfig;
  private receiving = false;

  constructor(config?: Partial<QueueConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      visibilityTimeout: config?.visibilityTimeout ?? 30,
      ...config,
    };
  }

  async send<T>(
    type: string,
    payload: T,
    idempotencyKey?: string,
    options?: SendOptions,
  ): Promise<string> {
    const id = randomUUID();
    // Mirror PgQueue's ON CONFLICT (idempotency_key) DO NOTHING: an explicit
    // duplicate key against a still-pending message is a silent no-op (the
    // returned id is unconditionally fresh in PgQueue too).
    if (
      idempotencyKey &&
      this.messages.some((m) => m.idempotencyKey === idempotencyKey)
    ) {
      return id;
    }
    const delayMs = Math.max(0, options?.delaySeconds ?? 0) * 1000;
    this.messages.push({
      id,
      type,
      payload,
      attempts: 0,
      maxAttempts: this.config.maxRetries,
      idempotencyKey: idempotencyKey || id,
      createdAt: new Date().toISOString(),
      visibleAt: Date.now() + delayMs,
    });
    return id;
  }

  async receive<T>(): Promise<QueueMessage<T> | null> {
    const [msg] = await this.receiveBatch<T>(1);
    return msg ?? null;
  }

  async receiveBatch<T>(max: number): Promise<QueueMessage<T>[]> {
    if (max <= 0 || this.receiving) return [];
    this.receiving = true;
    try {
      const now = Date.now();
      const out: QueueMessage<T>[] = [];
      // Claim oldest-first among VISIBLE messages; delayed messages stay
      // queued until their visibleAt passes (PgQueue's visible_at semantics).
      for (let i = 0; i < this.messages.length && out.length < max; ) {
        const msg = this.messages[i];
        if (msg.visibleAt <= now) {
          this.messages.splice(i, 1);
          msg.attempts++;
          const { visibleAt: _visibleAt, ...delivered } = msg;
          out.push(delivered as QueueMessage<T>);
        } else {
          i++;
        }
      }
      return out;
    } finally {
      this.receiving = false;
    }
  }

  async delete(_messageId: string): Promise<void> {
    // Message already removed on receive in-memory
  }

  async moveToDeadLetter(message: QueueMessage, error: string): Promise<void> {
    const diagnostics = redactForSink(
      {
        envelope: toEnvelopeMeta(message),
        payload: message.payload,
      },
      'dlq'
    );
    this.dlq.push({
      messageId: message.id,
      type: message.type,
      payload: message.payload,
      attempts: message.attempts,
      idempotencyKey: message.idempotencyKey,
      error,
      failedAt: new Date().toISOString(),
      diagnostics: (diagnostics as Record<string, unknown>) ?? {},
    });
  }

  async listDeadLetter(): Promise<DeadLetterEntry[]> {
    return [...this.dlq];
  }

  getConfig(): QueueConfig {
    return this.config;
  }

  size(): number {
    return this.messages.length;
  }

  dlqSize(): number {
    return this.dlq.length;
  }

  async depth(): Promise<QueueDepth> {
    return { pending: this.messages.length, deadLetter: this.dlq.length };
  }

  /** WS15 — mirror of PgQueue.stalePendingCount (created_at age filter). */
  async stalePendingCount(olderThanSeconds: number): Promise<number> {
    const cutoff = Date.now() - Math.max(0, olderThanSeconds) * 1000;
    return this.messages.filter((m) => new Date(m.createdAt).getTime() < cutoff).length;
  }
}

export interface WorkerHandler<T = unknown> {
  type: string;
  handle(message: QueueMessage<T>, logger: Logger): Promise<void>;
}

export async function processMessage<T>(
  message: QueueMessage<T>,
  handler: WorkerHandler<T>,
  logger: Logger
): Promise<boolean> {
  const envelopeMeta = toEnvelopeMeta(message as QueueMessage<unknown>);
  const boundedDebugMode = parseBoundedDebugMode();
  const log = logger.child({
    ...envelopeMeta,
    ...(boundedDebugMode ? { idempotency_key: message.idempotencyKey, created_at: message.createdAt } : {}),
  });

  if (message.type !== handler.type) {
    log.warn('Message type mismatch', { expected: handler.type, actual: message.type });
    return false;
  }

  try {
    log.info('Processing message', {
      payload: redactForSink(message.payload, 'worker'),
    });
    await handler.handle(message, log);
    log.info('Message processed successfully');
    return true;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Message processing failed', {
      error: error.message,
      canRetry: message.attempts < message.maxAttempts,
      payload: redactForSink(message.payload, 'worker'),
    });

    if (message.attempts >= message.maxAttempts) {
      log.error('Message exceeded max attempts, sending to DLQ');
    }
    return false;
  }
}
