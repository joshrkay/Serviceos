/**
 * P11-001 — `lookup_events` audit row.
 *
 * Each row records ONE invocation of a voice lookup skill (the
 * `lookup_*` family). Volume can be high (every voice turn that hits
 * a lookup intent writes one), so the payload is intentionally tiny:
 * intent + result_status + result_count + summary + latency. No raw
 * data payloads — the skill response carries those for the in-flight
 * TTS turn only.
 */
import { v4 as uuidv4 } from 'uuid';

export type LookupEventStatus = 'found' | 'none' | 'error';

export interface LookupEvent {
  id: string;
  tenantId: string;
  /** UUID of the voice session this lookup ran inside. */
  sessionId: string;
  /** Optional customer this lookup was scoped to. */
  customerId?: string;
  /** The intent that triggered the lookup, e.g. `lookup_appointments`. */
  intent: string;
  resultStatus: LookupEventStatus;
  resultCount: number;
  /** TTS-ready single-line summary the caller heard. */
  summary: string;
  /** End-to-end skill latency in ms (timer started in the skill). */
  latencyMs: number;
  createdAt: Date;
}

export interface CreateLookupEventInput {
  tenantId: string;
  /**
   * Optional from the caller's perspective — adapter-side flow may not
   * always have a session id wired (tests, dev). When omitted the row is
   * stamped with a synthetic uuidv4 so the column stays NOT NULL.
   */
  sessionId?: string;
  customerId?: string;
  intent: string;
  resultStatus: LookupEventStatus;
  resultCount: number;
  summary: string;
  latencyMs: number;
}

export interface LookupEventListOptions {
  /** Filter to a single voice session. */
  sessionId?: string;
  /** Filter to a single customer. */
  customerId?: string;
  /** Cap on rows returned. Default 50, hard-capped at 200. */
  limit?: number;
}

export const DEFAULT_LOOKUP_EVENT_LIMIT = 50;
export const MAX_LOOKUP_EVENT_LIMIT = 200;

export interface LookupEventRepository {
  create(event: LookupEvent): Promise<LookupEvent>;
  /** Newest-first list, scoped to a tenant. */
  listByTenant(tenantId: string, options?: LookupEventListOptions): Promise<LookupEvent[]>;
}

/**
 * Pure constructor. The service layer wraps this in `record()` so
 * callers don't need to remember to mint an id / stamp createdAt.
 */
export function buildLookupEvent(input: CreateLookupEventInput): LookupEvent {
  if (!input.tenantId) throw new Error('tenantId is required for lookup event');
  if (!input.intent) throw new Error('intent is required for lookup event');
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    sessionId: input.sessionId ?? uuidv4(),
    customerId: input.customerId,
    intent: input.intent,
    resultStatus: input.resultStatus,
    resultCount: input.resultCount,
    summary: input.summary,
    latencyMs: input.latencyMs,
    createdAt: new Date(),
  };
}

export class InMemoryLookupEventRepository implements LookupEventRepository {
  private rows: LookupEvent[] = [];

  async create(event: LookupEvent): Promise<LookupEvent> {
    this.rows.push({ ...event });
    return { ...event };
  }

  async listByTenant(
    tenantId: string,
    options?: LookupEventListOptions,
  ): Promise<LookupEvent[]> {
    let results = this.rows.filter((r) => r.tenantId === tenantId);
    if (options?.sessionId) results = results.filter((r) => r.sessionId === options.sessionId);
    if (options?.customerId) results = results.filter((r) => r.customerId === options.customerId);
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const limit = Math.min(options?.limit ?? DEFAULT_LOOKUP_EVENT_LIMIT, MAX_LOOKUP_EVENT_LIMIT);
    return results.slice(0, limit).map((r) => ({ ...r }));
  }
}
