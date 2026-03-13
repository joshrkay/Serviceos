import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvoiceDetail } from './InvoiceDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('InvoiceDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', invoiceNumber: 'INV-001', status: 'sent', jobId: 'j1',
        subtotalCents: 20000, discountCents: 0, taxCents: 1600, totalCents: 21600,
        amountPaidCents: 10000, amountDueCents: 11600,
        dueDate: '2026-02-01T00:00:00Z', createdAt: '2026-01-15T00:00:00Z',
        lineItems: [
          { id: 'li1', description: 'Labor', quantity: 4, unitPriceCents: 5000, totalCents: 20000, taxable: true },
        ],
        payments: [
          { id: 'p1', amountCents: 10000, method: 'credit_card', status: 'completed', createdAt: '2026-01-20T00:00:00Z' },
        ],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders invoice details', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Invoice INV-001')).toBeInTheDocument();
    expect(screen.getByText('Invoice Info')).toBeInTheDocument();
    expect(screen.getByText('Line Items')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
  });

  it('renders line item and payment data', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Labor')).toBeInTheDocument();
    expect(screen.getByText('credit_card')).toBeInTheDocument();
  });

  it('renders balance details', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Amount Paid: $100.00')).toBeInTheDocument();
    expect(screen.getByText('Amount Due: $116.00')).toBeInTheDocument();
  });

  it('shows no payments message when empty', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', invoiceNumber: 'INV-002', status: 'draft', jobId: 'j2',
        subtotalCents: 5000, discountCents: 0, taxCents: 0, totalCents: 5000,
        amountPaidCents: 0, amountDueCents: 5000,
        createdAt: '2026-01-15T00:00:00Z',
        lineItems: [], payments: [],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('No payments recorded.')).toBeInTheDocument();
  });

  it('shows loading when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
