import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryDispatchAnalyticsRepository,
  captureDispatchEvent,
  getDispatchSummary,
  createDispatchMetric,
} from '../../src/dispatch/analytics';

describe('P6-022A — Dispatch metric model', () => {
  let repo: InMemoryDispatchAnalyticsRepository;
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    repo = new InMemoryDispatchAnalyticsRepository();
  });

  it('creates a dispatch metric with valid data', () => {
    const metric = createDispatchMetric(tenantId, 'assigned', {
      appointmentId: 'appt-1',
      technicianId: 'tech-1',
    });
    expect(metric.id).toBeDefined();
    expect(metric.tenantId).toBe(tenantId);
    expect(metric.eventType).toBe('assigned');
    expect(metric.appointmentId).toBe('appt-1');
    expect(metric.technicianId).toBe('tech-1');
    expect(metric.recordedAt).toBeInstanceOf(Date);
  });

  it('captures and retrieves dispatch events', async () => {
    await captureDispatchEvent(repo, tenantId, 'assigned', { appointmentId: 'a1' });
    await captureDispatchEvent(repo, tenantId, 'reassigned', { appointmentId: 'a2' });

    const metrics = await repo.getMetrics(tenantId);
    expect(metrics).toHaveLength(2);
  });

  it('filters metrics by event type', async () => {
    await captureDispatchEvent(repo, tenantId, 'assigned');
    await captureDispatchEvent(repo, tenantId, 'canceled');
    await captureDispatchEvent(repo, tenantId, 'assigned');

    const assigned = await repo.getMetricsByType(tenantId, 'assigned');
    expect(assigned).toHaveLength(2);
  });

  it('filters metrics by date range', async () => {
    await captureDispatchEvent(repo, tenantId, 'assigned');

    const future = { from: new Date('2099-01-01'), to: new Date('2099-12-31') };
    const metrics = await repo.getMetrics(tenantId, future);
    expect(metrics).toHaveLength(0);
  });

  it('generates dispatch summary', async () => {
    await captureDispatchEvent(repo, tenantId, 'assigned');
    await captureDispatchEvent(repo, tenantId, 'assigned');
    await captureDispatchEvent(repo, tenantId, 'reassigned');
    await captureDispatchEvent(repo, tenantId, 'canceled');

    const summary = await getDispatchSummary(repo, tenantId);
    expect(summary.totalEvents).toBe(4);
    expect(summary.byType['assigned']).toBe(2);
    expect(summary.byType['reassigned']).toBe(1);
    expect(summary.byType['canceled']).toBe(1);
  });

  it('enforces tenant isolation', async () => {
    await captureDispatchEvent(repo, tenantId, 'assigned');
    const otherMetrics = await repo.getMetrics('other-tenant');
    expect(otherMetrics).toHaveLength(0);
  });

  it('returns empty summary for no events', async () => {
    const summary = await getDispatchSummary(repo, tenantId);
    expect(summary.totalEvents).toBe(0);
    expect(summary.byType).toEqual({});
  });
});
