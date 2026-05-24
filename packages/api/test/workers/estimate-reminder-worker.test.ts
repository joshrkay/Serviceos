import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEstimate, InMemoryEstimateRepository, Estimate } from '../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';
import type { SendService } from '../../src/notifications/send-service';
import {
  runEstimateReminderSweep,
  EstimateReminderWorkerDeps,
} from '../../src/workers/estimate-reminder-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
const ONE_DAY_AGO = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

const items = [buildLineItem('i1', 'AC tune-up', 1, 12500, 0, true, 'labor')];

describe('runEstimateReminderSweep', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;
  let sendEstimate: ReturnType<typeof vi.fn>;
  let sendService: SendService;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
    sendEstimate = vi.fn().mockResolvedValue({ estimateId: 'x', viewUrl: 'u', viewToken: 't', channelsSent: [] });
    sendService = { sendEstimate } as unknown as SendService;
  });

  function deps(overrides: Partial<EstimateReminderWorkerDeps> = {}): EstimateReminderWorkerDeps {
    return {
      estimateRepo,
      sendService,
      auditRepo,
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      ...overrides,
    };
  }

  async function seedSent(overrides: Partial<Estimate> = {}, sentAt: Date = FIVE_DAYS_AGO): Promise<Estimate> {
    const est = await createEstimate(
      { tenantId: 't1', jobId: 'j1', estimateNumber: 'EST-1', lineItems: items, createdBy: 'u1' },
      estimateRepo,
    );
    return (await estimateRepo.update('t1', est.id, { status: 'sent', sentAt, ...overrides }))!;
  }

  it('returns zeroed result when there are no tenants', async () => {
    const result = await runEstimateReminderSweep(deps({ listTenantIds: async () => [] }));
    expect(result).toEqual({ tenants: 0, reminders: 0, failed: 0 });
    expect(sendEstimate).not.toHaveBeenCalled();
  });

  it('sends one reminder for a stale, unviewed sent estimate and bumps reminderCount', async () => {
    const est = await seedSent();
    const result = await runEstimateReminderSweep(deps());
    expect(result.reminders).toBe(1);
    expect(sendEstimate).toHaveBeenCalledTimes(1);
    expect(sendEstimate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', estimateId: est.id }));

    const after = await estimateRepo.findById('t1', est.id);
    expect(after?.reminderCount).toBe(1);
    expect(after?.lastReminderAt).toEqual(NOW);

    const events = await auditRepo.findByEntity('t1', 'estimate', est.id);
    expect(events.some((e) => e.eventType === 'estimate.reminder_sent')).toBe(true);
  });

  it('does not remind estimates sent too recently', async () => {
    await seedSent({}, ONE_DAY_AGO);
    const result = await runEstimateReminderSweep(deps());
    expect(result.reminders).toBe(0);
    expect(sendEstimate).not.toHaveBeenCalled();
  });

  it('does not remind estimates the customer already engaged with', async () => {
    await seedSent({ firstViewedAt: new Date(NOW.getTime() - 1000) });
    await seedSent({ acceptedAt: new Date(NOW.getTime() - 1000) });
    await seedSent({ rejectedAt: new Date(NOW.getTime() - 1000) });
    const result = await runEstimateReminderSweep(deps());
    expect(result.reminders).toBe(0);
    expect(sendEstimate).not.toHaveBeenCalled();
  });

  it('is idempotent — a second sweep sends nothing once the cap is reached', async () => {
    await seedSent();
    await runEstimateReminderSweep(deps());
    await runEstimateReminderSweep(deps());
    expect(sendEstimate).toHaveBeenCalledTimes(1);
  });

  it('respects a higher maxReminders cap', async () => {
    await seedSent();
    await runEstimateReminderSweep(deps({ maxReminders: 2 }));
    await runEstimateReminderSweep(deps({ maxReminders: 2 }));
    await runEstimateReminderSweep(deps({ maxReminders: 2 }));
    expect(sendEstimate).toHaveBeenCalledTimes(2);
  });

  it('isolates a single estimate send failure without aborting the rest', async () => {
    const bad = await seedSent({ estimateNumber: 'EST-BAD' });
    await seedSent({ estimateNumber: 'EST-OK' });
    sendEstimate.mockImplementation(async ({ estimateId }: { estimateId: string }) => {
      if (estimateId === bad.id) throw new Error('no phone on file');
      return { estimateId, viewUrl: 'u', viewToken: 't', channelsSent: [] };
    });
    const result = await runEstimateReminderSweep(deps());
    expect(result.reminders).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('keeps sweeping when one tenant fails to list', async () => {
    await seedSent();
    const failingRepo = {
      findByTenant: vi.fn(async (t: string, options?: Parameters<InMemoryEstimateRepository['findByTenant']>[1]) => {
        if (t === 'bad') throw new Error('db down');
        return estimateRepo.findByTenant(t, options);
      }),
      update: estimateRepo.update.bind(estimateRepo),
    } as unknown as InMemoryEstimateRepository;
    const result = await runEstimateReminderSweep(
      deps({ estimateRepo: failingRepo, listTenantIds: async () => ['bad', 't1'] }),
    );
    expect(result.failed).toBe(1);
    expect(result.reminders).toBe(1);
  });
});
