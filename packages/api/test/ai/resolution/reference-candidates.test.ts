import { describe, it, expect, vi } from 'vitest';
import { candidatesForReference } from '../../../src/ai/resolution/reference-candidates';
import { calculateDocumentTotals } from '../../../src/shared/billing-engine';
import type { Invoice, InvoiceRepository } from '../../../src/invoices/invoice';
import type { Estimate, EstimateRepository } from '../../../src/estimates/estimate';

function invoiceRow(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    tenantId: 't1',
    jobId: 'job-1',
    invoiceNumber: 'INV-0042',
    status: 'open',
    lineItems: [],
    totals: calculateDocumentTotals([], 0, 0),
    amountPaidCents: 0,
    amountDueCents: 0,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function estimateRow(overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: 'est-1',
    tenantId: 't1',
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'draft',
    lineItems: [],
    totals: calculateDocumentTotals([], 0, 0),
    version: 1,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('candidatesForReference', () => {
  it('maps invoice matches into the EntityCandidate shape, capped at limit 5 by default', async () => {
    const findByTenant = vi.fn().mockResolvedValue([
      invoiceRow({ id: 'inv-1', invoiceNumber: 'INV-0042', status: 'open', customerMessage: 'Thanks for the quick work, much appreciated!' }),
      invoiceRow({ id: 'inv-2', invoiceNumber: 'INV-0043', status: 'draft' }),
    ]);
    const invoiceRepo: Pick<InvoiceRepository, 'findByTenant'> = { findByTenant };

    const result = await candidatesForReference({
      tenantId: 't1',
      reference: 'Henderson',
      kind: 'invoice',
      invoiceRepo,
    });

    expect(findByTenant).toHaveBeenCalledWith('t1', { search: 'Henderson', limit: 5 });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'inv-1', kind: 'invoice', label: 'INV-0042' });
    // Hint truncates a long customer message and includes status.
    expect(result[0].hint).toContain('open');
    expect(result[0].hint).toContain('…');
    expect(result[1]).toMatchObject({ id: 'inv-2', kind: 'invoice', label: 'INV-0043', hint: 'draft' });
  });

  it('maps estimate matches into the EntityCandidate shape', async () => {
    const findByTenant = vi.fn().mockResolvedValue([
      estimateRow({ id: 'est-1', estimateNumber: 'EST-0001', status: 'sent', customerMessage: 'quote' }),
    ]);
    const estimateRepo: Pick<EstimateRepository, 'findByTenant'> = { findByTenant };

    const result = await candidatesForReference({
      tenantId: 't1',
      reference: 'Johnson',
      kind: 'estimate',
      estimateRepo,
    });

    expect(findByTenant).toHaveBeenCalledWith('t1', { search: 'Johnson', limit: 5 });
    expect(result).toEqual([
      { id: 'est-1', kind: 'estimate', label: 'EST-0001', hint: 'sent • quote', score: 1 },
    ]);
  });

  it('respects a caller-supplied limit', async () => {
    const findByTenant = vi.fn().mockResolvedValue([]);
    await candidatesForReference({
      tenantId: 't1',
      reference: 'x',
      kind: 'invoice',
      invoiceRepo: { findByTenant },
      limit: 3,
    });
    expect(findByTenant).toHaveBeenCalledWith('t1', { search: 'x', limit: 3 });
  });

  it('zero matches → []', async () => {
    const invoiceRepo: Pick<InvoiceRepository, 'findByTenant'> = {
      findByTenant: vi.fn().mockResolvedValue([]),
    };
    const result = await candidatesForReference({
      tenantId: 't1',
      reference: 'nobody',
      kind: 'invoice',
      invoiceRepo,
    });
    expect(result).toEqual([]);
  });

  it('repo error → [] (failure-soft)', async () => {
    const invoiceRepo: Pick<InvoiceRepository, 'findByTenant'> = {
      findByTenant: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const result = await candidatesForReference({
      tenantId: 't1',
      reference: 'Henderson',
      kind: 'invoice',
      invoiceRepo,
    });
    expect(result).toEqual([]);
  });

  it('missing repo dep → [] (deliberately optional, never blocks drafting)', async () => {
    const result = await candidatesForReference({
      tenantId: 't1',
      reference: 'Henderson',
      kind: 'invoice',
    });
    expect(result).toEqual([]);
  });

  it('empty/whitespace reference → [] without calling the repo', async () => {
    const findByTenant = vi.fn();
    const result = await candidatesForReference({
      tenantId: 't1',
      reference: '   ',
      kind: 'invoice',
      invoiceRepo: { findByTenant },
    });
    expect(result).toEqual([]);
    expect(findByTenant).not.toHaveBeenCalled();
  });

  it('undefined reference → [] without calling the repo', async () => {
    const findByTenant = vi.fn();
    const result = await candidatesForReference({
      tenantId: 't1',
      reference: undefined,
      kind: 'invoice',
      invoiceRepo: { findByTenant },
    });
    expect(result).toEqual([]);
    expect(findByTenant).not.toHaveBeenCalled();
  });
});
