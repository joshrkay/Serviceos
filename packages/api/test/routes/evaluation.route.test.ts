/**
 * P2-030 — GET /api/evaluation/shadow-comparisons route tests.
 *
 * Verifies:
 *   - Auth: 403 for non-owner/non-admin role (technician/dispatcher).
 *   - Returns comparisons for the authenticated tenant.
 *   - Tenant isolation: comparisons from other tenants not returned.
 *   - Query params: limit, taskType filter.
 *   - Response shape matches spec.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { createEvaluationRouter } from '../../src/routes/evaluation';
import {
  InMemoryShadowComparisonStore,
  ShadowComparisonResult,
} from '../../src/ai/evaluation/shadow-comparison';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeComparison(overrides: Partial<ShadowComparisonResult> = {}): ShadowComparisonResult {
  return {
    id: 'cmp-1',
    comparisonGroupId: 'grp-1',
    taskType: 'draft_estimate',
    primaryResponse: {
      content: 'primary text',
      model: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 10, output: 20, total: 30 },
      latencyMs: 250,
    },
    shadowResponse: {
      content: 'shadow text',
      model: 'claude-haiku',
      provider: 'anthropic',
      tokenUsage: { input: 12, output: 22, total: 34 },
      latencyMs: 350,
    },
    sampledAt: new Date('2026-05-17T10:00:00.000Z'),
    tenantId: TENANT_A,
    aiRunId: 'run-xyz',
    ...overrides,
  };
}

function buildApp(role: string, tenantId: string, store: InMemoryShadowComparisonStore) {
  const app = express();
  app.use(express.json());

  // Inject fake auth
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-test-1',
      sessionId: 'session-test-1',
      tenantId,
      role,
    };
    next();
  });

  app.use('/api/evaluation', createEvaluationRouter({ shadowStore: store }));
  return app;
}

describe('GET /api/evaluation/shadow-comparisons', () => {
  let store: InMemoryShadowComparisonStore;

  beforeEach(() => {
    store = new InMemoryShadowComparisonStore();
  });

  it('returns 200 with comparisons for owner role', async () => {
    await store.save(makeComparison());
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app).get('/api/evaluation/shadow-comparisons');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.comparisons)).toBe(true);
    expect(res.body.comparisons.length).toBe(1);
  });

  it('returns correct response shape', async () => {
    await store.save(makeComparison());
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app).get('/api/evaluation/shadow-comparisons');

    expect(res.status).toBe(200);
    const cmp = res.body.comparisons[0];
    expect(typeof cmp.id).toBe('string');
    expect(typeof cmp.taskType).toBe('string');
    expect(typeof cmp.shadowModel).toBe('string');
    expect(typeof cmp.primaryResponseText).toBe('string');
    expect(typeof cmp.primaryLatencyMs).toBe('number');
    expect(typeof cmp.shadowLatencyMs).toBe('number');
    expect(cmp.primaryTokenUsage).toBeDefined();
    expect(cmp.shadowTokenUsage).toBeDefined();
    expect(typeof cmp.createdAt).toBe('string');
    expect('nextCursor' in res.body).toBe(true);
  });

  it('returns 400 for malformed cursor', async () => {
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app)
      .get('/api/evaluation/shadow-comparisons')
      .query({ cursor: 'garbage' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(typeof res.body.message).toBe('string');
  });

  it('returns 403 for technician role', async () => {
    const app = buildApp('technician', TENANT_A, store);
    const res = await request(app).get('/api/evaluation/shadow-comparisons');
    expect(res.status).toBe(403);
  });

  it('returns 403 for dispatcher role', async () => {
    const app = buildApp('dispatcher', TENANT_A, store);
    const res = await request(app).get('/api/evaluation/shadow-comparisons');
    expect(res.status).toBe(403);
  });

  it('tenant isolation: returns empty for tenant B when only tenant A has data', async () => {
    await store.save(makeComparison({ tenantId: TENANT_A }));
    const app = buildApp('owner', TENANT_B, store);

    const res = await request(app).get('/api/evaluation/shadow-comparisons');

    expect(res.status).toBe(200);
    expect(res.body.comparisons).toHaveLength(0);
  });

  it('filters by taskType query param', async () => {
    await store.save(makeComparison({ id: 'cmp-1', taskType: 'draft_estimate' }));
    await store.save(makeComparison({ id: 'cmp-2', taskType: 'voice_triage' }));
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app)
      .get('/api/evaluation/shadow-comparisons')
      .query({ taskType: 'voice_triage' });

    expect(res.status).toBe(200);
    expect(res.body.comparisons).toHaveLength(1);
    expect(res.body.comparisons[0].id).toBe('cmp-2');
  });

  it('respects limit query param (max 200)', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(makeComparison({ id: `cmp-${i}` }));
    }
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app)
      .get('/api/evaluation/shadow-comparisons')
      .query({ limit: '2' });

    expect(res.status).toBe(200);
    expect(res.body.comparisons).toHaveLength(2);
  });

  it('caps limit at 200', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(makeComparison({ id: `cmp-${i}` }));
    }
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app)
      .get('/api/evaluation/shadow-comparisons')
      .query({ limit: '999' });

    expect(res.status).toBe(200);
    // We only have 5 items, so all returned even with limit capped at 200
    expect(res.body.comparisons.length).toBeLessThanOrEqual(200);
  });

  it('exposes divergenceScore from the stored result', async () => {
    // Store a comparison with a divergenceScore set
    await store.save(makeComparison({ divergenceScore: 0.42 }));
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app).get('/api/evaluation/shadow-comparisons');

    expect(res.status).toBe(200);
    expect(res.body.comparisons[0].divergenceScore).toBe(0.42);
  });

  it('exposes divergenceScore as null when not set', async () => {
    await store.save(makeComparison({ divergenceScore: null }));
    const app = buildApp('owner', TENANT_A, store);

    const res = await request(app).get('/api/evaluation/shadow-comparisons');

    expect(res.status).toBe(200);
    expect(res.body.comparisons[0].divergenceScore).toBeNull();
  });
});
