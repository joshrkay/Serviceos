import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createQualityRouter } from '../../src/routes/quality';
import { InMemoryQualityMetricsRepository } from '../../src/quality/metrics';
import { InMemoryApprovalRepository } from '../../src/estimates/approval';
import { InMemoryEditDeltaRepository } from '../../src/estimates/edit-delta';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { v4 as uuidv4 } from 'uuid';

const TENANT_ID = 'tenant-quality-1';
const OTHER_TENANT_ID = 'tenant-quality-2';

function createAuthedApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  return app;
}

describe('quality analytics routes', () => {
  let app: express.Express;
  let qualityMetricsRepo: InMemoryQualityMetricsRepository;
  let approvalRepo: InMemoryApprovalRepository;
  let deltaRepo: InMemoryEditDeltaRepository;

  beforeEach(async () => {
    app = createAuthedApp();
    qualityMetricsRepo = new InMemoryQualityMetricsRepository();
    approvalRepo = new InMemoryApprovalRepository();
    deltaRepo = new InMemoryEditDeltaRepository();

    app.use(
      '/api/quality',
      createQualityRouter({
        metricsRepo: qualityMetricsRepo,
        approvalRepo,
        deltaRepo,
      })
    );

    const now = new Date('2026-03-01T00:00:00.000Z');

    // In-tenant HVAC diagnostic v2 approvals
    await approvalRepo.create({
      id: uuidv4(),
      tenantId: TENANT_ID,
      estimateId: 'est-1',
      status: 'approved',
      approvedBy: 'user-1',
      approvedAt: now,
      approvedWithEdits: false,
      metadata: { verticalType: 'hvac', serviceCategory: 'diagnostic', promptVersion: 'v2' },
      createdAt: now,
    });

    await approvalRepo.create({
      id: uuidv4(),
      tenantId: TENANT_ID,
      estimateId: 'est-2',
      status: 'approved_with_edits',
      approvedBy: 'user-1',
      approvedAt: now,
      approvedWithEdits: true,
      metadata: { verticalType: 'hvac', serviceCategory: 'diagnostic', promptVersion: 'v2' },
      createdAt: now,
    });

    // Same tenant but different category (should be filtered out when category=diagnostic)
    await approvalRepo.create({
      id: uuidv4(),
      tenantId: TENANT_ID,
      estimateId: 'est-3',
      status: 'rejected',
      rejectedBy: 'user-1',
      rejectedAt: now,
      rejectionReason: 'Price too high',
      approvedWithEdits: false,
      metadata: { verticalType: 'hvac', serviceCategory: 'repair', promptVersion: 'v2' },
      createdAt: now,
    });

    // Cross-tenant data that must never be included
    await approvalRepo.create({
      id: uuidv4(),
      tenantId: OTHER_TENANT_ID,
      estimateId: 'other-est-1',
      status: 'approved',
      approvedBy: 'other-user',
      approvedAt: now,
      approvedWithEdits: false,
      metadata: { verticalType: 'hvac', serviceCategory: 'diagnostic', promptVersion: 'v2' },
      createdAt: now,
    });

    await deltaRepo.create({
      id: uuidv4(),
      tenantId: TENANT_ID,
      estimateId: 'est-2',
      fromRevisionId: 'r1',
      toRevisionId: 'r2',
      deltas: [{ type: 'price_changed', field: 'unitPriceCents', oldValue: 10000, newValue: 9000 }],
      summary: '1 change',
      createdAt: now,
    });

    // Cross-tenant delta should not leak
    await deltaRepo.create({
      id: uuidv4(),
      tenantId: OTHER_TENANT_ID,
      estimateId: 'other-est-1',
      fromRevisionId: 'r1',
      toRevisionId: 'r2',
      deltas: [{ type: 'price_changed', field: 'unitPriceCents', oldValue: 5000, newValue: 1000 }],
      summary: '1 change',
      createdAt: now,
    });
  });

  it('returns filtered metrics using vertical/category/prompt/period filters', async () => {
    const res = await request(app)
      .get('/api/quality/vertical/hvac/metrics')
      .query({
        serviceCategory: 'diagnostic',
        promptVersion: 'v2',
        periodStart: '2026-02-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(true);
    expect(res.body.metrics.verticalType).toBe('hvac');
    expect(res.body.metrics.serviceCategory).toBe('diagnostic');
    expect(res.body.metrics.promptVersion).toBe('v2');
    expect(res.body.metrics.sampleSize).toBe(2);
    expect(res.body.metrics.approvalRate).toBe(1);
    expect(res.body.metrics.editRate).toBe(0.5);
  });

  it('returns benchmark with both speed and quality fields', async () => {
    const res = await request(app)
      .get('/api/quality/vertical/hvac/benchmark')
      .query({
        serviceCategory: 'diagnostic',
        promptVersion: 'v2',
        manualEstimateTimeMs: 100000,
        aiAssistedEstimateTimeMs: 40000,
      });

    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(true);
    expect(res.body.benchmark).toHaveProperty('manualEstimateTimeMs', 100000);
    expect(res.body.benchmark).toHaveProperty('aiAssistedEstimateTimeMs', 40000);
    expect(res.body.benchmark).toHaveProperty('timeSavingsPercent', 60);
    expect(res.body.benchmark).toHaveProperty('qualityScore');
    expect(typeof res.body.benchmark.qualityScore).toBe('number');
  });

  it('returns explicit and consistent empty-data shape for metrics and benchmark', async () => {
    const metricsRes = await request(app)
      .get('/api/quality/vertical/hvac/metrics')
      .query({ serviceCategory: 'maintenance', promptVersion: 'v2' });

    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.hasData).toBe(false);
    expect(metricsRes.body.message).toBe('No estimate analytics data found for the requested filters');
    expect(metricsRes.body.metrics.sampleSize).toBe(0);

    const benchmarkRes = await request(app)
      .get('/api/quality/vertical/hvac/benchmark')
      .query({ serviceCategory: 'maintenance', promptVersion: 'v2' });

    expect(benchmarkRes.status).toBe(200);
    expect(benchmarkRes.body.hasData).toBe(false);
    expect(benchmarkRes.body.message).toBe('No estimate analytics data found for the requested filters');
    expect(benchmarkRes.body.benchmark.sampleSize).toBe(0);
    expect(benchmarkRes.body.benchmark.qualityScore).toBe(0);
  });
});
