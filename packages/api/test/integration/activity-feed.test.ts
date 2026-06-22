/**
 * Postgres integration — audit activity feed (Epic 12.7).
 *
 * The unit tests mock the repo, so they can't prove the new
 * `findRecentByTenant` SQL is correct or that RLS isolates it. These drive
 * PgAuditRepository against real Postgres to pin: the real columns exist, the
 * newest-first ordering + limit hold, and a tenant only ever sees its own
 * events (FORCE RLS on audit_events).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createAuditEvent } from '../../src/audit/audit';
import { RepoBackedActivityFeedReporter } from '../../src/analytics/activity-feed';

describe('Postgres integration — audit activity feed', () => {
  let pool: Pool;
  let repo: PgAuditRepository;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);

    // Three events for `tenant` at known times, one for `other`.
    const mk = (over: { actorRole: string; eventType: string; entityType: string; entityId: string; tenantId: string; createdAt: Date }) => {
      const e = createAuditEvent({
        tenantId: over.tenantId,
        actorId: over.tenantId,
        actorRole: over.actorRole,
        eventType: over.eventType,
        entityType: over.entityType,
        entityId: over.entityId,
      });
      e.createdAt = over.createdAt;
      return e;
    };

    await repo.create(mk({ tenantId: tenant.tenantId, actorRole: 'owner', eventType: 'customer.created', entityType: 'customer', entityId: crypto.randomUUID(), createdAt: new Date('2026-06-01T10:00:00Z') }));
    await repo.create(mk({ tenantId: tenant.tenantId, actorRole: 'voice_agent', eventType: 'appointment.booked', entityType: 'appointment', entityId: crypto.randomUUID(), createdAt: new Date('2026-06-03T10:00:00Z') }));
    await repo.create(mk({ tenantId: tenant.tenantId, actorRole: 'owner', eventType: 'emergency_immediate_dial', entityType: 'job', entityId: crypto.randomUUID(), createdAt: new Date('2026-06-02T10:00:00Z') }));
    await repo.create(mk({ tenantId: other.tenantId, actorRole: 'owner', eventType: 'invoice.created', entityType: 'invoice', entityId: crypto.randomUUID(), createdAt: new Date('2026-06-04T10:00:00Z') }));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('returns the tenant audit log newest-first with real columns mapped', async () => {
    const events = await repo.findRecentByTenant(tenant.tenantId, { limit: 50 });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.eventType)).toEqual([
      'appointment.booked', // 06-03
      'emergency_immediate_dial', // 06-02
      'customer.created', // 06-01
    ]);
    // Columns the feed depends on must be populated (not undefined).
    expect(events[0].actorRole).toBe('voice_agent');
    expect(events[0].entityType).toBe('appointment');
    expect(events[0].entityId).toBeTruthy();
  });

  it('honors the limit', async () => {
    const events = await repo.findRecentByTenant(tenant.tenantId, { limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('appointment.booked');
  });

  it('never leaks another tenant’s events (FORCE RLS)', async () => {
    const events = await repo.findRecentByTenant(tenant.tenantId, { limit: 50 });
    expect(events.every((e) => e.tenantId === tenant.tenantId)).toBe(true);
    expect(events.some((e) => e.eventType === 'invoice.created')).toBe(false);
  });

  it('maps through the reporter into flagged, deep-linkable feed items', async () => {
    const reporter = new RepoBackedActivityFeedReporter(repo);
    const feed = await reporter.query(tenant.tenantId, { limit: 50 });
    const emergency = feed.find((f) => f.eventType === 'emergency_immediate_dial');
    expect(emergency?.isEmergency).toBe(true);
    const booked = feed.find((f) => f.eventType === 'appointment.booked');
    expect(booked?.actorKind).toBe('agent');
  });
});
