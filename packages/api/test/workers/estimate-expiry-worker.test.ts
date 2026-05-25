import { describe, it, expect, beforeEach } from 'vitest';
import { createEstimate, InMemoryEstimateRepository, Estimate } from '../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';
import {
  runEstimateExpirySweep,
  EstimateExpiryWorkerDeps,
} from '../../src/workers/estimate-expiry-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const NEXT_WEEK = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);

const items = [buildLineItem('i1', 'AC tune-up', 1, 12500, 0, true, 'labor')];

describe('runEstimateExpirySweep', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(overrides: Partial<EstimateExpiryWorkerDeps> = {}): EstimateExpiryWorkerDeps {
    return {
      estimateRepo,
      auditRepo,
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      ...overrides,
    };
  }

  async function seedSent(validUntil?: Date): Promise<Estimate> {
    const est = await createEstimate(
      { tenantId: 't1', jobId: 'j1', estimateNumber: 'EST-1', lineItems: items, validUntil, createdBy: 'u1' },
      estimateRepo,
    );
    return (await estimateRepo.update('t1', est.id, { status: 'sent' }))!;
  }

  it('expires a sent estimate past its valid_until and emits audit', async () => {
    const est = await seedSent(YESTERDAY);
    const result = await runEstimateExpirySweep(deps());
    expect(result.expired).toBe(1);

    const after = await estimateRepo.findById('t1', est.id);
    expect(after?.status).toBe('expired');

    const events = await auditRepo.findByEntity('t1', 'estimate', est.id);
    expect(events.some((e) => e.eventType === 'estimate.expired')).toBe(true);
  });

  it('leaves estimates whose validity is still in the future', async () => {
    const est = await seedSent(NEXT_WEEK);
    const result = await runEstimateExpirySweep(deps());
    expect(result.expired).toBe(0);
    expect((await estimateRepo.findById('t1', est.id))?.status).toBe('sent');
  });

  it('ignores sent estimates with no validity date', async () => {
    const est = await seedSent(undefined);
    const result = await runEstimateExpirySweep(deps());
    expect(result.expired).toBe(0);
    expect((await estimateRepo.findById('t1', est.id))?.status).toBe('sent');
  });
});
