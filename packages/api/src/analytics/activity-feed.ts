import type { AuditEvent, AuditRepository } from '../audit/audit';
import { SHADOW_COMPARISON_PURGED_EVENT } from '../workers/shadow-comparison-retention-worker';
import { AI_RUN_CONTENT_PURGED_EVENT } from '../workers/recording-retention-worker';

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

/**
 * Audit events the feed never shows: internal housekeeping the owner did not
 * do and cannot act on, whose label would name an internal mechanism. The
 * shadow-comparison retention sweep writes one per tenant batch, about hourly
 * for a tenant with sampled calls, which would also push real activity off
 * the Home card. The AI-run content purge is the same kind of event, and its
 * label ("Ai run content purged") would put a banned word on the owner's Home.
 * Left out in the read itself, so `limit` counts visible rows.
 */
export const ACTIVITY_FEED_HIDDEN_EVENT_TYPES: readonly string[] = [
  SHADOW_COMPARISON_PURGED_EVENT,
  AI_RUN_CONTENT_PURGED_EVENT,
];

export interface ActivityFeedReporter {
  query(tenantId: string, opts?: { limit?: number }): Promise<ActivityFeedItem[]>;
}

export class RepoBackedActivityFeedReporter implements ActivityFeedReporter {
  constructor(private readonly auditRepo: AuditRepository) {}

  async query(tenantId: string, opts: { limit?: number } = {}): Promise<ActivityFeedItem[]> {
    if (!this.auditRepo.findRecentByTenant) {
      throw new Error('Audit repository does not support tenant-wide reads');
    }
    const events = await this.auditRepo.findRecentByTenant(tenantId, {
      limit: opts.limit ?? 50,
      excludeEventTypes: ACTIVITY_FEED_HIDDEN_EVENT_TYPES,
    });
    return toActivityFeed(events);
  }
}
