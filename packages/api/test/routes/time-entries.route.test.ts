/**
 * Unit tests for the time-entries router (U5 / E15).
 *
 * Focus: the `?jobId=` branch on GET /api/time-entries returns that job's
 * entries via repo.findByJob, independent of the caller's userId — backing
 * the JobDetail time panel. Uses the InMemory repo so no live DB is needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createTimeEntriesRouter } from '../../src/routes/time-entries';
import {
  InMemoryTimeEntryRepository,
  type TimeEntry,
} from '../../src/time-tracking/time-entry';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Role } from '../../src/auth/rbac';

const TENANT = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const OTHER_TENANT = 'f0e1d2c3-b4a5-6789-0123-456789abcdef';
const JOB_A = '11111111-1111-1111-1111-111111111111';
const JOB_B = '22222222-2222-2222-2222-222222222222';

function makeEntry(over: Partial<TimeEntry> & { id: string; jobId?: string; userId?: string; tenantId?: string }): TimeEntry {
  const now = over.clockedInAt ?? new Date('2026-06-01T12:00:00Z');
  // Closed by default: the one-active-per-user unique rule (mirrored by the
  // InMemory repo) forbids two open entries for the same user, and these
  // fixtures seed multiple entries per user.
  const clockedOutAt = over.clockedOutAt ?? new Date(now.getTime() + 30 * 60_000);
  return {
    id: over.id,
    tenantId: over.tenantId ?? TENANT,
    userId: over.userId ?? 'user-1',
    jobId: over.jobId,
    entryType: 'job',
    clockedInAt: now,
    clockedOutAt,
    durationMinutes: over.durationMinutes ?? 30,
    notes: over.notes,
    createdAt: now,
    updatedAt: now,
  };
}

function buildApp(repo: InMemoryTimeEntryRepository, opts: { userId?: string; role?: Role; tenantId?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: opts.userId ?? 'user-1',
      sessionId: 'sess-1',
      tenantId: opts.tenantId ?? TENANT,
      role: opts.role ?? 'technician',
    };
    next();
  });
  app.use('/api/time-entries', createTimeEntriesRouter(repo, new InMemoryAuditRepository()));
  return app;
}

describe('GET /api/time-entries?jobId=', () => {
  let repo: InMemoryTimeEntryRepository;

  beforeEach(async () => {
    repo = new InMemoryTimeEntryRepository();
    // Two jobs, entries from different users.
    await repo.create(makeEntry({ id: 'a1', jobId: JOB_A, userId: 'user-1' }));
    await repo.create(makeEntry({ id: 'a2', jobId: JOB_A, userId: 'user-2', clockedInAt: new Date('2026-06-01T13:00:00Z') }));
    await repo.create(makeEntry({ id: 'b1', jobId: JOB_B, userId: 'user-1' }));
  });

  it('owner sees every user\'s entries on the requested job', async () => {
    const app = buildApp(repo, { userId: 'user-1', role: 'owner' });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('dispatcher (office role) also sees all users\' entries on the job', async () => {
    // Caller is user-1 but job A also has user-2's entry — both come back.
    const app = buildApp(repo, { userId: 'user-1', role: 'dispatcher' });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    const userIds = new Set((res.body as Array<{ userId: string }>).map((e) => e.userId));
    expect(userIds.has('user-1')).toBe(true);
    expect(userIds.has('user-2')).toBe(true);
  });

  it('technician sees only their own entries on the job (peers hidden)', async () => {
    // Caller is technician user-1; job A also has user-2's entry, which must
    // not be exposed. Self-scope, not a 403 — the panel stays useful.
    const app = buildApp(repo, { userId: 'user-1', role: 'technician' });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id).sort();
    expect(ids).toEqual(['a1']);
    const userIds = new Set((res.body as Array<{ userId: string }>).map((e) => e.userId));
    expect(userIds).toEqual(new Set(['user-1']));
  });

  it('technician viewing a job where they have no entries gets an empty list', async () => {
    // user-2 has an entry on JOB_A (a2) but user-3 does not.
    const app = buildApp(repo, { userId: 'user-3', role: 'technician' });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('isolates by tenant — another tenant\'s job returns nothing (owner)', async () => {
    await repo.create(makeEntry({ id: 'other', jobId: JOB_A, tenantId: OTHER_TENANT }));
    const app = buildApp(repo, { tenantId: OTHER_TENANT, role: 'owner' });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual(['other']);
  });

  it('tenant isolation holds for a technician too — only their own tenant rows', async () => {
    // Seed an other-tenant entry for the same userId on the same jobId; the
    // tenant scope (RLS) must exclude it before the self-filter runs.
    await repo.create(makeEntry({ id: 'other', jobId: JOB_A, userId: 'user-1', tenantId: OTHER_TENANT }));
    const app = buildApp(repo, { userId: 'user-1', role: 'technician', tenantId: TENANT });
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual(['a1']);
  });

  it('returns an empty list for a job with no entries', async () => {
    const app = buildApp(repo, { role: 'owner' });
    const res = await request(app).get('/api/time-entries?jobId=33333333-3333-3333-3333-333333333333');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('falls through to userId-scoped list when no jobId is supplied', async () => {
    // No jobId → existing behavior: caller (user-1) sees only their entries.
    const app = buildApp(repo, { userId: 'user-1', role: 'technician' });
    const res = await request(app).get('/api/time-entries');

    expect(res.status).toBe(200);
    const userIds = new Set((res.body as Array<{ userId: string }>).map((e) => e.userId));
    expect(userIds).toEqual(new Set(['user-1']));
  });
});
