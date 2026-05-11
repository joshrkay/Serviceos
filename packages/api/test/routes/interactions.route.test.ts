/**
 * Unit tests for GET /api/interactions and GET /api/interactions/:id
 * (QA 15.8 — transcript appears in /interactions with correct customer linked,
 *  QA 15.9 — transcript contains actual words spoken).
 *
 * Uses a fake Postgres pool that returns canned rows so the test suite
 * does not need a live database.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createInteractionsRouter } from '../../src/routes/interactions';

const TENANT = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

/** Fake client returned by pool.connect() */
function makeClient(rowsForQuery: Record<string, unknown>[][], countRow: { total: string }[] = [{ total: '1' }]) {
  let callIdx = 0;
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      // BEGIN / COMMIT / ROLLBACK / SET (RLS context) → return empty
      if (/^(BEGIN|COMMIT|ROLLBACK|SET\b)/i.test(sql.trim())) {
        return { rows: [] } as QueryResult;
      }
      // SELECT COUNT(*) → return countRow
      if (/SELECT COUNT/i.test(sql)) {
        return { rows: countRow } as unknown as QueryResult;
      }
      // Main SELECT query → return rowsForQuery[callIdx++]
      const rows = rowsForQuery[callIdx] ?? [];
      callIdx++;
      return { rows } as unknown as QueryResult;
    }),
    release: vi.fn(),
  };
}

function makePool(
  rows: Record<string, unknown>[][],
  countRow?: { total: string }[],
): Pool {
  const client = makeClient(rows, countRow);
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

function buildApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  // Inject auth so requireAuth/requireTenant don't bounce.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/interactions', createInteractionsRouter({ pool }));
  return app;
}

// ─── Shared canned rows ────────────────────────────────────────────────────

const SESSION_ROW = {
  id: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
  channel: 'voice_inbound',
  outcome: 'completed',
  call_sid: 'CA-abc123',
  started_at: new Date('2026-01-10T12:00:00Z'),
  ended_at: new Date('2026-01-10T12:03:30Z'),
  ended_reason: 'caller_hangup',
  cost_cents: 42,
  transcript: ['caller: I need AC repair', 'agent: I can help you schedule that'],
  customer_id: 'c1d2e3f4-a5b6-7890-cdef-012345678901',
  customer_display_name: 'Alice Smith',
  customer_address: '123 Main St',
};

// ─── List tests ────────────────────────────────────────────────────────────

describe('GET /api/interactions', () => {
  it('returns 200 with data array and total', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.data).toHaveLength(1);
  });

  it('15.9 — excerpt contains actual caller words from transcript', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    const item = res.body.data[0];
    expect(typeof item.excerpt).toBe('string');
    expect(item.excerpt).toContain('AC repair');
  });

  it('15.8 — customer is linked with correct name and address', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    const item = res.body.data[0];
    expect(item.customer).not.toBeNull();
    expect(item.customer.id).toBe('c1d2e3f4-a5b6-7890-cdef-012345678901');
    expect(item.customer.displayName).toBe('Alice Smith');
    expect(item.customer.address).toBe('123 Main St');
  });

  it('customer is null when session has no customer_id', async () => {
    const row = { ...SESSION_ROW, customer_id: null, customer_display_name: null, customer_address: null };
    const pool = makePool([[row]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    expect(res.body.data[0].customer).toBeNull();
  });

  it('returns 200 with empty data when no sessions exist', async () => {
    const pool = makePool([[]], [{ total: '0' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('respects limit and offset query params', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '25' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions?limit=5&offset=10');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(10);
  });

  it('durationSeconds is computed from started_at / ended_at', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    const item = res.body.data[0];
    // 12:03:30 - 12:00:00 = 210 seconds
    expect(item.durationSeconds).toBe(210);
  });

  it('transcriptTurnCount equals number of transcript entries', async () => {
    const pool = makePool([[SESSION_ROW]], [{ total: '1' }]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions');

    expect(res.body.data[0].transcriptTurnCount).toBe(2);
  });
});

// ─── Detail tests ─────────────────────────────────────────────────────────

describe('GET /api/interactions/:id', () => {
  it('returns 200 with full transcript array', async () => {
    const pool = makePool([[SESSION_ROW]]);
    const app = buildApp(pool);

    const res = await request(app).get(`/api/interactions/${SESSION_ROW.id}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transcript)).toBe(true);
    expect(res.body.transcript).toContain('caller: I need AC repair');
    expect(res.body.transcript).toContain('agent: I can help you schedule that');
  });

  it('15.9 — transcript contains actual spoken words, not blank/[inaudible]', async () => {
    const pool = makePool([[SESSION_ROW]]);
    const app = buildApp(pool);

    const res = await request(app).get(`/api/interactions/${SESSION_ROW.id}`);

    for (const turn of res.body.transcript as string[]) {
      expect(turn).not.toMatch(/^\[inaudible\]$/i);
      expect(turn.length).toBeGreaterThan(5);
    }
  });

  it('15.8 — detail links correct customer', async () => {
    const pool = makePool([[SESSION_ROW]]);
    const app = buildApp(pool);

    const res = await request(app).get(`/api/interactions/${SESSION_ROW.id}`);

    expect(res.body.customer).toMatchObject({
      id: 'c1d2e3f4-a5b6-7890-cdef-012345678901',
      displayName: 'Alice Smith',
      address: '123 Main St',
    });
  });

  it('returns 404 when session not found for tenant', async () => {
    const pool = makePool([[/* empty */]]);
    const app = buildApp(pool);

    const res = await request(app).get('/api/interactions/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('returns empty transcript array for sessions without transcript', async () => {
    const row = { ...SESSION_ROW, transcript: null };
    const pool = makePool([[row]]);
    const app = buildApp(pool);

    const res = await request(app).get(`/api/interactions/${SESSION_ROW.id}`);

    expect(res.status).toBe(200);
    expect(res.body.transcript).toEqual([]);
  });

  it('includes outcome and endedReason in detail response', async () => {
    const pool = makePool([[SESSION_ROW]]);
    const app = buildApp(pool);

    const res = await request(app).get(`/api/interactions/${SESSION_ROW.id}`);

    expect(res.body.outcome).toBe('completed');
    expect(res.body.endedReason).toBe('caller_hangup');
  });
});
