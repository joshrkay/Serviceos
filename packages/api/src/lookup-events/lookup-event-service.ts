/**
 * P11-001 — Service wrapper around `LookupEventRepository`.
 *
 * Skill code records via `record(input)`; the UI list endpoint pulls
 * via `list(tenantId, opts)`. Keeping the indirection thin lets the
 * skill-side codepath stay synchronous-feeling (no need to hand-build
 * a row + remember to stamp createdAt).
 */
import {
  buildLookupEvent,
  type LookupEvent,
  type LookupEventListOptions,
  type LookupEventRepository,
  type LookupEventStatus,
} from './lookup-event';

export interface RecordLookupEventInput {
  tenantId: string;
  sessionId?: string;
  customerId?: string;
  intent: string;
  resultStatus: LookupEventStatus;
  resultCount: number;
  summary: string;
  latencyMs: number;
}

export class LookupEventService {
  constructor(private readonly repo: LookupEventRepository) {}

  /**
   * Persist a lookup event. Errors propagate — the skill layer wraps
   * the call in try/catch so an audit-write failure never breaks the
   * caller-facing TTS turn.
   */
  async record(input: RecordLookupEventInput): Promise<LookupEvent> {
    const event = buildLookupEvent(input);
    return this.repo.create(event);
  }

  async list(tenantId: string, options?: LookupEventListOptions): Promise<LookupEvent[]> {
    return this.repo.listByTenant(tenantId, options);
  }
}
