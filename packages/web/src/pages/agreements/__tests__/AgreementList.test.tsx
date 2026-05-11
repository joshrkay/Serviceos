import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgreementList } from '../AgreementList';

vi.mock('../../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../../hooks/useListQuery';

describe('P9-003 AgreementList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [
        {
          id: '1',
          tenantId: 't',
          customerId: 'c',
          name: 'Quarterly HVAC Tune-up',
          recurrenceRule: 'FREQ=QUARTERLY;BYMONTHDAY=15',
          priceCents: 19900,
          autoGenerateInvoice: true,
          autoGenerateJob: true,
          nextRunAt: '2026-09-15T00:00:00.000Z',
          status: 'active',
          startsOn: '2026-06-15',
          createdBy: 'u',
          createdAt: '',
          updatedAt: '',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      setPage: vi.fn(),
      setSearch: vi.fn(),
      setFilters: vi.fn(),
    });
  });

  it('renders the list with header and a row', () => {
    render(<AgreementList />);
    expect(screen.getByText('Service Agreements')).toBeInTheDocument();
    expect(screen.getByText('Quarterly HVAC Tune-up')).toBeInTheDocument();
    expect(screen.getByText('$199.00')).toBeInTheDocument();
  });

  it('shows the empty state when no rows', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 25,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      setPage: vi.fn(),
      setSearch: vi.fn(),
      setFilters: vi.fn(),
    });
    render(<AgreementList />);
    expect(screen.getByText('No service agreements yet')).toBeInTheDocument();
  });
});
