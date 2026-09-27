/**
 * #1400 (QA 2026-09-26 §4) — estimate status tabs. Sent queried only
 * `ready_for_review`, Viewed could never match, Expired never listed a sent
 * estimate past its validUntil. The tabs now ask the API for the derived
 * `stage` bucket and label rows with the same shared rule.
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

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const unopened = apiEstimate({ estimateNumber: 'EST-0101', status: 'sent', sentAt: iso(-DAY), validUntil: iso(7 * DAY) });
const opened = apiEstimate({ estimateNumber: 'EST-0102', status: 'sent', sentAt: iso(-DAY), firstViewedAt: iso(-DAY / 2), validUntil: iso(7 * DAY) });
const lapsed = apiEstimate({ estimateNumber: 'EST-0103', status: 'sent', sentAt: iso(-40 * DAY), validUntil: iso(-2 * DAY) });

let result = listQueryResult([unopened, opened, lapsed]);

beforeEach(() => {
  result = listQueryResult([unopened, opened, lapsed]);
  vi.mocked(useListQuery).mockReturnValue(result);
});

function renderList() {
  return render(<MemoryRouter><EstimatesPage /></MemoryRouter>);
}

describe('EstimatesPage status tabs (#1400)', () => {
  it('Viewed asks the API for opened estimates and lists the one the customer opened', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Viewed' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ stage: 'viewed' });
    expect(screen.getByText(/EST-0102/)).toBeInTheDocument();
    expect(screen.queryByText(/EST-0101/)).not.toBeInTheDocument();
  });

  it('Expired asks the API for lapsed estimates and lists a sent estimate past its validUntil', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ stage: 'expired' });
    expect(screen.getByText(/EST-0103/)).toBeInTheDocument();
    expect(screen.queryByText(/EST-0101/)).not.toBeInTheDocument();
  });

  it('Sent asks the API for both ready_for_review and sent (unopened) estimates', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ stage: 'sent' });
    expect(screen.getByText(/EST-0101/)).toBeInTheDocument();
    expect(screen.queryByText(/EST-0102/)).not.toBeInTheDocument();
  });
});
