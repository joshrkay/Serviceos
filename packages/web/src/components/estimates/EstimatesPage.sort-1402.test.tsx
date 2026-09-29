/**
 * #1402 (QA §4) — the estimates list can be sorted server-side through the
 * shared list-sort control (`?sortBy=&sort=`), and the choice survives a
 * status-tab change.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';
import { listQueryResult } from '../../test-utils/list-query-result';
import { apiEstimate } from '../../test-utils/money-fixtures';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';

let result = listQueryResult([apiEstimate({ estimateNumber: 'EST-0001' })]);

beforeEach(() => {
  result = listQueryResult([apiEstimate({ estimateNumber: 'EST-0001' })]);
  vi.mocked(useListQuery).mockReturnValue(result);
});

describe('EstimatesPage sort (#1402)', () => {
  it('choosing "Highest total" asks the API for sortBy=total desc, and a tab change keeps it', () => {
    render(<MemoryRouter><EstimatesPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Sort estimates'), { target: { value: 'total:desc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'total', sort: 'desc' });

    fireEvent.click(screen.getByRole('button', { name: 'Viewed' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ stage: 'viewed', sortBy: 'total', sort: 'desc' });
  });

  it('offers customer A→Z and oldest-first orderings', () => {
    render(<MemoryRouter><EstimatesPage /></MemoryRouter>);
    const select = screen.getByLabelText('Sort estimates');
    fireEvent.change(select, { target: { value: 'customer:asc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'customer', sort: 'asc' });
    fireEvent.change(select, { target: { value: 'created:asc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'created', sort: 'asc' });
  });
});
