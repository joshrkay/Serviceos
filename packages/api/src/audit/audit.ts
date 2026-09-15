import { v4 as uuidv4 } from 'uuid';

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId: string;
  actorRole: string;
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventInput {
  tenantId: string;
  actorId: string;
  actorRole: string;
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * #1051 follow-up — the audit rows the tenant-wide voice money-approval PIN lock
 * is derived from: a wrong code that did not lock its session, the wrong code
 * that did, and the owner alert sent when the tenant lock engages. The Pg
 * lookup inlines these literals so the migration-279 partial index
 * (`idx_audit_events_voice_pin_lock`) serves it — change them in both places.
 */
export const VOICE_APPROVAL_PIN_LOCK_EVENT_TYPES = [
  'proposal.voice_approval_challenge_failed',
  'proposal.voice_challenge_lockout',
  'proposal.voice_approval_tenant_lock_alerted',
] as const;

export interface AuditRepository {
  create(event: AuditEvent): Promise<AuditEvent>;
  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]>;
  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]>;
  /**
   * #1051 follow-up — this tenant's `VOICE_APPROVAL_PIN_LOCK_EVENT_TYPES` rows
   * created at or after `since`, oldest first, across EVERY voice session.
   * Required (not optional like `findRecentByTenant`): the tenant-wide PIN lock
   * fails closed on a repository that cannot answer it.
   */
  findVoiceApprovalPinLockEvents(tenantId: string, since: Date): Promise<AuditEvent[]>;
  /**
   * Epic 12.7 — tenant-wide chronological read (newest first) backing the
   * activity feed. Optional on the interface (matching findByCustomer /
   * listWithMeta elsewhere) so existing in-memory fakes stay valid; the
   * activity reporter 503s when an implementation doesn't provide it.
   */
  findRecentByTenant?(
    tenantId: string,
    opts?: { limit?: number },
  ): Promise<AuditEvent[]>;
}

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  if (!input.tenantId) throw new Error('tenantId is required for audit event');
  if (!input.actorId) throw new Error('actorId is required for audit event');
  if (!input.eventType) throw new Error('eventType is required for audit event');
  if (!input.entityType) throw new Error('entityType is required for audit event');
  if (!input.entityId) throw new Error('entityId is required for audit event');

  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorRole: input.actorRole,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: input.correlationId || uuidv4(),
    metadata: input.metadata || {},
    createdAt: new Date(),
  };
}

export class InMemoryAuditRepository implements AuditRepository {
  private events: AuditEvent[] = [];

  async create(event: AuditEvent): Promise<AuditEvent> {
    this.events.push({ ...event });
    return event;
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) => e.tenantId === tenantId && e.entityType === entityType && e.entityId === entityId
    );
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) => e.tenantId === tenantId && e.correlationId === correlationId
    );
  }

  async findVoiceApprovalPinLockEvents(tenantId: string, since: Date): Promise<AuditEvent[]> {
    const types: readonly string[] = VOICE_APPROVAL_PIN_LOCK_EVENT_TYPES;
    return this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          types.includes(e.eventType) &&
          e.createdAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => ({ ...e }));
  }

  async findRecentByTenant(
    tenantId: string,
    opts: { limit?: number } = {},
  ): Promise<AuditEvent[]> {
    const limit = opts.limit ?? 50;
    return this.events
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
