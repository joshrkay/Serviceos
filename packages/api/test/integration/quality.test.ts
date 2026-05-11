import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgQualityMetricsRepository } from '../../src/quality/pg-metrics';

describe('Postgres integration — quality', () => {
  let pool: Pool;
  let metricsRepo: PgQualityMetricsRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    metricsRepo = new PgQualityMetricsRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('records metric data point', async () => {
      await metricsRepo.recordMetric({
        metricName: 'estimateApprovalRate',
        value: 0.75,
        tenantId: tenant.tenantId,
        timestamp: new Date(),
        metadata: { sampleSize: 100 },
      });

      const metrics = await metricsRepo.getMetrics(
        tenant.tenantId,
        new Date(Date.now() - 86400000),
        new Date()
      );
      expect(metrics.length).toBeGreaterThanOrEqual(1);
    });

    it('retrieves metric time series', async () => {
      await metricsRepo.recordMetric({
        metricName: 'estimateEditRate',
        value: 0.25,
        tenantId: tenant.tenantId,
        timestamp: new Date(),
      });

      const timeSeries = await metricsRepo.getMetricTimeSeries(
        tenant.tenantId,
        'estimateEditRate',
        new Date(Date.now() - 86400000),
        new Date()
      );
      expect(Array.isArray(timeSeries)).toBe(true);
    });

    it('retrieves latest metrics', async () => {
      await metricsRepo.recordMetric({
        metricName: 'proposalExecutionSuccessRate',
        value: 0.95,
        tenantId: tenant.tenantId,
        timestamp: new Date(),
      });

      const latest = await metricsRepo.getLatestMetrics(tenant.tenantId);
      expect(latest).not.toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      await metricsRepo.recordMetric({
        metricName: 'secretMetric',
        value: 1.0,
        tenantId: tenant.tenantId,
        timestamp: new Date(),
      });

      const metrics = await metricsRepo.getMetrics(
        otherTenant.tenantId,
        new Date(Date.now() - 86400000),
        new Date()
      );
      expect(metrics.filter(m => m.metricName === 'secretMetric').length).toBe(0);
    });
  });
});