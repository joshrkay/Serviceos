/**
 * Docker-gated integration test for U5 / E15 —
 * GET /api/time-entries?jobId= returns that job's entries from real Postgres.
 *
 * Pins the real `time_entries` columns (the mocked-DB caveat in CLAUDE.md:
 * a route that "works" against a mocked Pool can still reference nonexistent
 * columns). Drives the actual PgTimeEntryRepository.findByJob through the
 * HTTP route so the SELECT (tenant_id, job_id, clocked_in_at ...) is exercised.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createTimeEntriesRouter } from '../../src/routes/time-entries';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { TimeEntry } from '../../src/time-tracking/time-entry';

describe('Postgres integration — GET /api/time-entries?jobId=', () => {
  let pool: Pool;
  let repo: PgTimeEntryRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  const JOB_A = crypto.randomUUID();
  const JOB_B = crypto.randomUUID();

  function buildApp(tenantId: string, userId: string, role: 'owner' | 'dispatcher' | 'technician' = 'owner') {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId,
        sessionId: 'sess-1',
        tenantId,
        role,
      };
      next();
    });
    app.use('/api/time-entries', createTimeEntriesRouter(repo, new InMemoryAuditRepository()));
    return app;
  }

  async function seed(tenantId: string, over: { jobId?: string; userId: string; minutes: number; at: string }) {
    const now = new Date(over.at);
    const out = new Date(now.getTime() + over.minutes * 60_000);
    const entry: TimeEntry = {
      id: crypto.randomUUID(),
      tenantId,
      userId: over.userId,
      jobId: over.jobId,
      entryType: 'job',
      clockedInAt: now,
      clockedOutAt: out,
      durationMinutes: over.minutes,
      notes: 'seed',
      createdAt: now,
      updatedAt: now,
    };
    return repo.create(entry);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTimeEntryRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    // Tenant A: two jobs, multiple users on job A (entries are closed so the
    // one-active-per-user unique index isn't tripped).
    await seed(tenantA.tenantId, { jobId: JOB_A, userId: 'tech-1', minutes: 60, at: '2026-06-01T09:00:00Z' });
    await seed(tenantA.tenantId, { jobId: JOB_A, userId: 'tech-2', minutes: 30, at: '2026-06-01T10:00:00Z' });
    await seed(tenantA.tenantId, { jobId: JOB_B, userId: 'tech-1', minutes: 45, at: '2026-06-01T11:00:00Z' });

    // Tenant B: a same-jobId entry that must never leak into tenant A's view.
    await seed(tenantB.tenantId, { jobId: JOB_A, userId: 'tech-9', minutes: 99, at: '2026-06-01T12:00:00Z' });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('?jobId=A returns only job A entries (all users), not job B', async () => {
    const app = buildApp(tenantA.tenantId, tenantA.userId);
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const entries = res.body as Array<{ jobId: string; userId: string; durationMinutes: number }>;
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.jobId === JOB_A)).toBe(true);
    expect(new Set(entries.map((e) => e.userId))).toEqual(new Set(['tech-1', 'tech-2']));
    // Real columns surfaced (mapRow): durationMinutes present.
    expect(entries.map((e) => e.durationMinutes).sort((a, b) => a - b)).toEqual([30, 60]);
  });

  it('?jobId=B returns only job B entries', async () => {
    const app = buildApp(tenantA.tenantId, tenantA.userId);
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_B}`);

    expect(res.status).toBe(200);
    const entries = res.body as Array<{ jobId: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].jobId).toBe(JOB_B);
  });

  it('tenant isolation — tenant A never sees tenant B entries for the same jobId', async () => {
    const app = buildApp(tenantA.tenantId, tenantA.userId);
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    const entries = res.body as Array<{ durationMinutes: number }>;
    // tenant B seeded a 99-minute entry on JOB_A; it must be excluded.
    expect(entries.some((e) => e.durationMinutes === 99)).toBe(false);
  });

  it('tenant B sees its own job A entry only', async () => {
    const app = buildApp(tenantB.tenantId, tenantB.userId);
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    const entries = res.body as Array<{ durationMinutes: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].durationMinutes).toBe(99);
  });

  it('technician caller is self-scoped on job A (only their own rows)', async () => {
    // tech-1 has the 60-min entry on JOB_A; tech-2's 30-min entry is a peer's
    // and must be filtered out after the tenant-scoped findByJob SELECT.
    const app = buildApp(tenantA.tenantId, 'tech-1', 'technician');
    const res = await request(app).get(`/api/time-entries?jobId=${JOB_A}`);

    expect(res.status).toBe(200);
    const entries = res.body as Array<{ jobId: string; userId: string; durationMinutes: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe('tech-1');
    expect(entries[0].jobId).toBe(JOB_A);
    // Real column round-trips through mapRow even on the self-scoped path.
    expect(entries[0].durationMinutes).toBe(60);
  });
});
