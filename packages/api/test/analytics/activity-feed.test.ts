import { describe, it, expect } from 'vitest';
import {
  actorKindFor,
  isEmergencyEvent,
  labelForEvent,
  toActivityFeed,
  RepoBackedActivityFeedReporter,
} from '../../src/analytics/activity-feed';
import {
  InMemoryAuditRepository,
  createAuditEvent,
  type AuditEvent,
  type AuditRepository,
} from '../../src/audit/audit';

describe('actorKindFor', () => {
  it('classifies the AI, automated, and human actors', () => {
    expect(actorKindFor('voice_agent')).toBe('agent');
    expect(actorKindFor('system')).toBe('system');
    expect(actorKindFor('platform')).toBe('system');
    expect(actorKindFor('owner')).toBe('human');
    expect(actorKindFor('technician')).toBe('human');
    expect(actorKindFor('customer')).toBe('human');
  });
});

describe('isEmergencyEvent', () => {
  it('flags emergency and escalation events', () => {
    expect(isEmergencyEvent('emergency_immediate_dial')).toBe(true);
    expect(isEmergencyEvent('emergency_dispatch.executed')).toBe(true);
    expect(isEmergencyEvent('escalation.requested')).toBe(true);
    expect(isEmergencyEvent('frustration_escalation')).toBe(true);
    expect(isEmergencyEvent('appointment.booked')).toBe(false);
  });
});

describe('labelForEvent', () => {
  it('humanizes the dotted/underscored event type', () => {
    expect(labelForEvent('appointment.booked')).toBe('Appointment booked');
    expect(labelForEvent('frustration_escalation')).toBe('Frustration escalation');
    expect(labelForEvent('customer.created_from_lead')).toBe('Customer created from lead');
  });
});

describe('toActivityFeed', () => {
  it('maps audit events into feed items with actor kind, emergency flag, and entity refs', () => {
    const base = {
      tenantId: 't1',
      actorId: 'u1',
      actorRole: 'voice_agent',
      entityType: 'appointment',
      entityId: 'appt-1',
    };
    const events = [
      createAuditEvent({ ...base, eventType: 'appointment.booked' }),
      createAuditEvent({
        ...base,
        actorRole: 'owner',
        eventType: 'emergency_immediate_dial',
        entityType: 'job',
        entityId: 'job-9',
      }),
    ];
    const feed = toActivityFeed(events);
    expect(feed[0]).toMatchObject({
      eventType: 'appointment.booked',
      label: 'Appointment booked',
      actorKind: 'agent',
      isEmergency: false,
      entityType: 'appointment',
      entityId: 'appt-1',
    });
    expect(typeof feed[0].createdAt).toBe('string');
    expect(feed[1]).toMatchObject({
      actorKind: 'human',
      isEmergency: true,
      entityType: 'job',
      entityId: 'job-9',
    });
  });
});

describe('RepoBackedActivityFeedReporter', () => {
  it('returns the tenant audit log newest-first, mapped to feed items', async () => {
    const repo = new InMemoryAuditRepository();
    const older = createAuditEvent({
      tenantId: 't1', actorId: 'u1', actorRole: 'owner',
      eventType: 'customer.created', entityType: 'customer', entityId: 'c1',
    });
    older.createdAt = new Date('2026-06-01T10:00:00.000Z');
    const newer = createAuditEvent({
      tenantId: 't1', actorId: 'sys', actorRole: 'voice_agent',
      eventType: 'appointment.booked', entityType: 'appointment', entityId: 'a1',
    });
    newer.createdAt = new Date('2026-06-02T10:00:00.000Z');
    // Different tenant — must never appear.
    const other = createAuditEvent({
      tenantId: 't2', actorId: 'u9', actorRole: 'owner',
      eventType: 'invoice.created', entityType: 'invoice', entityId: 'i1',
    });
    await repo.create(older);
    await repo.create(newer);
    await repo.create(other);

    const reporter = new RepoBackedActivityFeedReporter(repo);
    const feed = await reporter.query('t1', { limit: 10 });
    expect(feed.map((f) => f.id)).toEqual([newer.id, older.id]);
  });

  it('throws when the repo cannot do tenant-wide reads', async () => {
    const repo = {
      create: async (e: AuditEvent) => e,
      findByEntity: async () => [],
      findByCorrelation: async () => [],
    } as unknown as AuditRepository;
    const reporter = new RepoBackedActivityFeedReporter(repo);
    await expect(reporter.query('t1')).rejects.toThrow(/tenant-wide/);
  });
});
