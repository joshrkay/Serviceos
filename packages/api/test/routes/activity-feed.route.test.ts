/**
 * GET /api/analytics/activity — the owner's Home feed (ActivityFeedCard).
 *
 * The shadow-comparison retention sweep writes a `shadow_comparison.purged`
 * audit row per tenant batch, about hourly for a tenant with sampled calls.
 * Mapped as-is it would put a System row labelled "Shadow comparison purged"
 * on the owner's Home feed: internal housekeeping, an internal term, and
 * enough rows to push real activity off the card. Seam: the real router and
 * reporter over the in-memory audit log.
 */
import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createActivityFeedRouter } from '../../src/analytics/activity-feed-router';
import { RepoBackedActivityFeedReporter } from '../../src/analytics/activity-feed';
import { InMemoryAuditRepository, createAuditEvent } from '../../src/audit/audit';

const TENANT = 'tenant-feed-1';

function buildApp(auditRepo: InMemoryAuditRepository) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-feed-1',
      sessionId: 'session-feed-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/analytics/activity',
    createActivityFeedRouter({ activityFeedReporter: new RepoBackedActivityFeedReporter(auditRepo) }),
  );
  return app;
}

async function seed(auditRepo: InMemoryAuditRepository, eventType: string, actorRole: string, at: string) {
  const event = createAuditEvent({
    tenantId: TENANT,
    actorId: actorRole === 'system' ? 'shadow-comparison-retention-worker' : 'user-feed-1',
    actorRole,
    eventType,
    entityType: actorRole === 'system' ? 'tenant' : 'customer',
    entityId: actorRole === 'system' ? TENANT : 'cust-1',
  });
  event.createdAt = new Date(at);
  await auditRepo.create(event);
  return event;
}

describe('GET /api/analytics/activity', () => {
  it('never shows the shadow-comparison retention purge, and the limit counts only rows the owner sees', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const created = await seed(auditRepo, 'customer.created', 'owner', '2026-10-20T10:00:00Z');
    const booked = await seed(auditRepo, 'appointment.booked', 'owner', '2026-10-21T10:00:00Z');
    // Three hourly purges, all newer than the owner's own activity.
    await seed(auditRepo, 'shadow_comparison.purged', 'system', '2026-10-22T10:00:00Z');
    await seed(auditRepo, 'shadow_comparison.purged', 'system', '2026-10-22T11:00:00Z');
    await seed(auditRepo, 'shadow_comparison.purged', 'system', '2026-10-22T12:00:00Z');

    const res = await request(buildApp(auditRepo)).get('/api/analytics/activity?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([booked.id, created.id]);
    expect(JSON.stringify(res.body)).not.toMatch(/shadow/i);
  });
});
