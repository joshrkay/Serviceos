import type { AuditEvent, AuditRepository } from '../audit/audit';

/**
 * Epic 12.7 — Activity feed.
 *
 * Maps tenant-wide audit events into a chronological feed of "what happened":
 * agent vs human vs system actions, emergency-flagged, with the entity
 * type/id so the client can deep-link. `toActivityFeed` is pure and
 * unit-tested; the reporter just pages the audit log.
 *
 * Read-only: this surfaces audit events, it never mutates — no proposal path
 * is involved.
 */
export type ActivityActorKind = 'agent' | 'human' | 'system';

export interface ActivityFeedItem {
  id: string;
  eventType: string;
  /** Human-readable label derived from the event type. */
  label: string;
  actorKind: ActivityActorKind;
  actorRole: string;
  /** Emergency calls / escalations are flagged for triage. */
  isEmergency: boolean;
  entityType: string;
  entityId: string;
  createdAt: string;
}

/** voice_agent → the AI; system/platform → automated; everyone else → human. */
export function actorKindFor(actorRole: string): ActivityActorKind {
  if (actorRole === 'voice_agent') return 'agent';
  if (actorRole === 'system' || actorRole === 'platform') return 'system';
  return 'human';
}

const EMERGENCY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'escalation.requested',
  'frustration_escalation',
]);

/** Emergency dispatch / immediate-dial / paging events, plus escalations. */
export function isEmergencyEvent(eventType: string): boolean {
  return eventType.includes('emergency') || EMERGENCY_EVENT_TYPES.has(eventType);
}

/** 'appointment.booked' → 'Appointment booked'; 'frustration_escalation' → 'Frustration escalation'. */
export function labelForEvent(eventType: string): string {
  const words = eventType.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toActivityFeedItem(event: AuditEvent): ActivityFeedItem {
  return {
    id: event.id,
    eventType: event.eventType,
    label: labelForEvent(event.eventType),
    actorKind: actorKindFor(event.actorRole),
    actorRole: event.actorRole,
    isEmergency: isEmergencyEvent(event.eventType),
    entityType: event.entityType,
    entityId: event.entityId,
    createdAt: event.createdAt.toISOString(),
  };
}

export function toActivityFeed(events: AuditEvent[]): ActivityFeedItem[] {
  return events.map(toActivityFeedItem);
}

export interface ActivityFeedReporter {
  query(tenantId: string, opts?: { limit?: number }): Promise<ActivityFeedItem[]>;
}

export class RepoBackedActivityFeedReporter implements ActivityFeedReporter {
  constructor(private readonly auditRepo: AuditRepository) {}

  async query(tenantId: string, opts: { limit?: number } = {}): Promise<ActivityFeedItem[]> {
    if (!this.auditRepo.findRecentByTenant) {
      throw new Error('Audit repository does not support tenant-wide reads');
    }
    const events = await this.auditRepo.findRecentByTenant(tenantId, { limit: opts.limit ?? 50 });
    return toActivityFeed(events);
  }
}
