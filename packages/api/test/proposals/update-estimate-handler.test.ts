/**
 * UpdateEstimateExecutionHandler tests (rewritten).
 *
 * The old handler was a stub that just validated estimateId. This
 * suite covers the rewritten handler that actually fetches the
 * estimate, applies edits, and writes back — mirroring the Phase-2
 * invoice-edit handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateEstimateExecutionHandler } from '../../src/proposals/execution/update-estimate-handler';
import {
  Estimate,
  EstimateRepository,
} from '../../src/estimates/estimate';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal } from '../../src/proposals/proposal';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import type { Job, JobRepository } from '../../src/jobs/job';

/** Minimal job repo: resolves job-1 with the given paid deposit. */
function makeJobRepo(depositPaidCents = 0): Pick<JobRepository, 'findById'> {
  return {
    findById: async (tenantId: string, id: string) =>
      id === 'job-1' && tenantId === 't-1'
        ? ({ id: 'job-1', tenantId: 't-1', depositPaidCents } as Job)
        : null,
  };
}

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Site visit', 1, 15000, 0, true, 'labor'),
    buildLineItem('li-2', '50-gallon heater', 1, 85000, 1, true, 'material'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'est-1',
    tenantId: 't-1',
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'draft',
    lineItems,
    totals,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: 't-1',
    proposalType: 'update_estimate',
    status: 'approved',
    payload: {
      estimateId: 'est-1',
      editActions: [
        {
          type: 'add_line_item',
          lineItem: { description: 'Disposal fee', quantity: 1, unitPrice: 7500 },
        },
      ],
    },
    summary: 'Add disposal fee',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('UpdateEstimateExecutionHandler', () => {
  let estimateRepo: EstimateRepository;
  let handler: UpdateEstimateExecutionHandler;

  beforeEach(async () => {
    estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(makeEstimate());
    handler = new UpdateEstimateExecutionHandler(
      estimateRepo,
      undefined,
      undefined,
      undefined,
      makeJobRepo(),
    );
  });

  it('applies an add_line_item and persists the updated estimate', async () => {
    const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('est-1');

    const updated = await estimateRepo.findById('t-1', 'est-1');
    expect(updated!.lineItems).toHaveLength(3);
    expect(updated!.lineItems[2].description).toBe('Disposal fee');
    expect(updated!.totals.subtotalCents).toBe(15000 + 85000 + 7500);
  });

  it('bumps version and emits an audit event so the stale-accept guard catches voice edits', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const h = new UpdateEstimateExecutionHandler(
      estimateRepo,
      auditRepo,
      undefined,
      undefined,
      makeJobRepo(),
    );
    await estimateRepo.update('t-1', 'est-1', { version: 1 });

    const result = await h.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);

    const updated = await estimateRepo.findById('t-1', 'est-1');
    expect(updated!.version).toBe(2);

    const events = await auditRepo.findByEntity('t-1', 'estimate', 'est-1');
    expect(events.some((e) => e.eventType === 'estimate.updated')).toBe(true);
  });

  it('supports a chain of edits in a single proposal', async () => {
    const proposal = makeProposal({
      payload: {
        estimateId: 'est-1',
        editActions: [
          { type: 'remove_line_item', index: 0 },
          {
            type: 'add_line_item',
            lineItem: { description: 'Tankless', quantity: 1, unitPrice: 145000 },
          },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
    const updated = await estimateRepo.findById('t-1', 'est-1');
    expect(updated!.lineItems).toHaveLength(2);
    expect(updated!.lineItems.map((l) => l.description)).toEqual([
      '50-gallon heater',
      'Tankless',
    ]);
  });

  it('fails when the estimate is missing', async () => {
    const proposal = makeProposal({
      payload: {
        estimateId: 'nope',
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'x', quantity: 1, unitPrice: 100 } },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('fails on wrong tenant', async () => {
    const result = await handler.execute(
      makeProposal({ tenantId: 't-other' }),
      { tenantId: 't-other', executedBy: 'u-1' }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('fails when estimate status is sent', async () => {
    await estimateRepo.update('t-1', 'est-1', { status: 'sent' });
    const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/draft|sent|editable/i);
  });

  it('fails when payload has no estimateId', async () => {
    const proposal = makeProposal({
      payload: {
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'x', quantity: 1, unitPrice: 1 } },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/estimateId/i);
  });

  it('fails on empty editActions', async () => {
    const proposal = makeProposal({
      payload: { estimateId: 'est-1', editActions: [] },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/action/i);
  });

  it('surfaces ValidationError from the editor', async () => {
    const proposal = makeProposal({
      payload: {
        estimateId: 'est-1',
        editActions: [{ type: 'remove_line_item', index: 99 }],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/out of range/i);
  });

  it('propagates repo errors as thrown exceptions', async () => {
    const failingRepo = {
      findById: vi.fn(async () => makeEstimate()),
      update: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as EstimateRepository;
    const failingHandler = new UpdateEstimateExecutionHandler(
      failingRepo,
      undefined,
      undefined,
      undefined,
      makeJobRepo(),
    );
    await expect(
      failingHandler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' })
    ).rejects.toThrow(/db down/);
  });

  describe('deposit lock (linked job depositPaidCents)', () => {
    function acceptedOverrides(): Partial<Estimate> {
      return {
        status: 'accepted',
        version: 1,
        acceptedAt: new Date('2026-06-05T12:00:00Z'),
        acceptedByName: 'Jane Henderson',
      };
    }

    it('refuses an accepted estimate whose job has a PAID deposit (no invalidation)', async () => {
      await estimateRepo.update('t-1', 'est-1', acceptedOverrides());
      const h = new UpdateEstimateExecutionHandler(
        estimateRepo,
        undefined,
        undefined,
        undefined,
        makeJobRepo(50_000),
      );

      const result = await h.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/deposit has already been paid/i);

      const unchanged = await estimateRepo.findById('t-1', 'est-1');
      expect(unchanged!.status).toBe('accepted');
      expect(unchanged!.acceptedAt).toEqual(new Date('2026-06-05T12:00:00Z'));
      expect(unchanged!.lineItems).toHaveLength(2);
    });

    it('still invalidates acceptance when the job has NO deposit paid', async () => {
      await estimateRepo.update('t-1', 'est-1', acceptedOverrides());
      const h = new UpdateEstimateExecutionHandler(
        estimateRepo,
        undefined,
        undefined,
        undefined,
        makeJobRepo(0),
      );

      const result = await h.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
      expect(result.success).toBe(true);

      const after = await estimateRepo.findById('t-1', 'est-1');
      expect(after!.status).toBe('sent');
      expect(after!.acceptedAt == null).toBe(true);
      expect(after!.lineItems).toHaveLength(3);
    });

    it('fails closed when the estimate has a jobId but no jobRepo is wired', async () => {
      const h = new UpdateEstimateExecutionHandler(estimateRepo);
      const result = await h.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/deposit/i);

      const unchanged = await estimateRepo.findById('t-1', 'est-1');
      expect(unchanged!.lineItems).toHaveLength(2);
    });

    it('registry wires the jobRepo: deposit-locked estimate refuses through the registry handler', async () => {
      await estimateRepo.update('t-1', 'est-1', acceptedOverrides());
      const { createExecutionHandlerRegistry } = await import(
        '../../src/proposals/execution/handlers'
      );
      const registry = createExecutionHandlerRegistry({
        estimateRepo,
        jobRepo: makeJobRepo(25_000) as unknown as JobRepository,
      });
      const h = registry.get('update_estimate')!;
      const result = await h.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/deposit has already been paid/i);
    });
  });
});
