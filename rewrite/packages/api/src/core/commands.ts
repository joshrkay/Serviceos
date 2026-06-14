import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { ActorType } from '@rivet/contracts';
import { withTenantTransaction, type Db } from './db';

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface DomainEvent {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

export interface OutboxItem {
  topic: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  /** Earliest time the job may run (e.g. proposal undo deadline). */
  notBefore?: Date;
}

export interface CommandScope {
  tenantId: string;
  actor: Actor;
  correlationId?: string;
}

export interface CommandCtx {
  client: PoolClient;
  tenantId: string;
  actor: Actor;
  correlationId: string;
  /** Append a domain event (flushed atomically with the command's writes). */
  emit(event: DomainEvent): void;
  /** Enqueue a side effect via the transactional outbox. */
  enqueue(item: OutboxItem): void;
  /** Run another command inside the same transaction and event buffer. */
  invoke<I, O>(command: CommandDef<I, O>, input: I): Promise<O>;
}

export interface CommandDef<I, O> {
  name: string;
  input: z.ZodType<I>;
  run(ctx: CommandCtx, input: I): Promise<O>;
}

export function defineCommand<I, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export class CommandError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * The single mutation pipeline. Every canonical write:
 *   validate input -> one tenant-scoped transaction -> handler
 *   -> append events -> insert outbox rows -> commit -> kick outbox dispatch.
 * Audit and side effects are structural: a handler cannot mutate state
 * without its events and outbox items committing atomically with it.
 */
export class CommandBus {
  constructor(
    private readonly db: Db,
    private readonly onAfterCommit?: () => void,
  ) {}

  async execute<I, O>(command: CommandDef<I, O>, scope: CommandScope, input: unknown): Promise<O> {
    const parsed = command.input.parse(input);
    const correlationId = scope.correlationId ?? randomUUID();
    const events: DomainEvent[] = [];
    const outbox: OutboxItem[] = [];

    const result = await withTenantTransaction(this.db, scope.tenantId, async (client) => {
      const ctx: CommandCtx = {
        client,
        tenantId: scope.tenantId,
        actor: scope.actor,
        correlationId,
        emit: (event) => events.push(event),
        enqueue: (item) => outbox.push(item),
        invoke: (inner, innerInput) => inner.run(ctx, inner.input.parse(innerInput)),
      };
      const out = await command.run(ctx, parsed);

      for (const event of events) {
        await client.query(
          `INSERT INTO events (tenant_id, event_type, entity_type, entity_id,
                               actor_type, actor_id, correlation_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            scope.tenantId,
            event.eventType,
            event.entityType,
            event.entityId ?? null,
            scope.actor.type,
            scope.actor.id,
            correlationId,
            JSON.stringify(event.payload ?? {}),
          ],
        );
      }
      for (const item of outbox) {
        await client.query(
          `INSERT INTO outbox (tenant_id, topic, payload, dedupe_key, not_before)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            scope.tenantId,
            item.topic,
            JSON.stringify({ ...item.payload, correlationId }),
            item.dedupeKey ?? null,
            item.notBefore ?? null,
          ],
        );
      }
      return out;
    });

    if (outbox.length > 0) this.onAfterCommit?.();
    return result;
  }
}
