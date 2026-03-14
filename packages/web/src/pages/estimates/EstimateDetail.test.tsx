import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EstimateDetail } from './EstimateDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('EstimateDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', estimateNumber: 'EST-001', status: 'draft', jobId: 'j1',
        subtotalCents: 10000, discountCents: 500, taxCents: 950, totalCents: 10450,
        lineItems: [
          { id: 'li1', description: 'Pipe repair', quantity: 2, unitPriceCents: 5000, totalCents: 10000, taxable: true },
        ],
        sourceType: 'ai', approvalStatus: 'pending', createdAt: '2026-01-15T00:00:00Z',
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders estimate details', () => {
    render(<EstimateDetail estimateId="1" />);
    expect(screen.getByText('Estimate EST-001')).toBeInTheDocument();
    expect(screen.getByText('Estimate Info')).toBeInTheDocument();
    expect(screen.getByText('Line Items')).toBeInTheDocument();
    expect(screen.getByText('Totals')).toBeInTheDocument();
  });

  it('renders line item data', () => {
    render(<EstimateDetail estimateId="1" />);
    expect(screen.getByText('Pipe repair')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('renders source and approval info', () => {
    render(<EstimateDetail estimateId="1" />);
    expect(screen.getByText('Source: ai')).toBeInTheDocument();
    expect(screen.getByText('Approval: pending')).toBeInTheDocument();
  });

  it('shows loading when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<EstimateDetail estimateId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    render(<EstimateDetail estimateId="1" />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
