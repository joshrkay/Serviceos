import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RecurringJobsPanel,
  type RecurringJobsPanelApi,
} from './RecurringJobsPanel';
import type { RecurringJob } from '../../api/recurring-jobs';

const job = (over: Partial<RecurringJob> = {}): RecurringJob => ({
  id: 'r1',
  tenantId: 'tn',
  customerId: 'c1',
  title: 'Monthly filter change',
  anchorDate: '2026-06-01',
  rule: { frequency: 'monthly', interval: 1 },
  notes: null,
  isArchived: false,
  scheduleSummary: 'Every month',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<RecurringJobsPanelApi> = {}): RecurringJobsPanelApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(job()),
    archive: vi.fn().mockResolvedValue(undefined),
    occurrences: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe('RecurringJobsPanel (R-JOB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hints when the customer has no recurring jobs', async () => {
    render(<RecurringJobsPanel customerId="c1" api={mockApi()} />);
    expect(await screen.findByText(/No recurring jobs/)).toBeInTheDocument();
  });

  it('lists series with schedule summary and next visit dates', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([job()]),
      occurrences: vi.fn().mockResolvedValue(['2026-06-01', '2026-07-01']),
    });
    render(<RecurringJobsPanel customerId="c1" api={api} />);
    expect(await screen.findByText('Monthly filter change')).toBeInTheDocument();
    expect(screen.getByText('Every month')).toBeInTheDocument();
    expect(screen.getByText(/Next: 2026-06-01, 2026-07-01/)).toBeInTheDocument();
    expect(api.occurrences).toHaveBeenCalledWith('r1', { limit: 3 });
  });

  it('creates a recurring job from the form', async () => {
    const api = mockApi();
    render(<RecurringJobsPanel customerId="c1" api={api} />);

    fireEvent.click(await screen.findByText('Add recurring job'));
    fireEvent.change(screen.getByLabelText('Recurring job name'), {
      target: { value: 'Weekly lawn' },
    });
    fireEvent.change(screen.getByLabelText('First visit date'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        customerId: 'c1',
        title: 'Weekly lawn',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1 },
      }),
    );
  });

  it('blocks creating a series without a name and date', async () => {
    const api = mockApi();
    render(<RecurringJobsPanel customerId="c1" api={api} />);
    fireEvent.click(await screen.findByText('Add recurring job'));
    fireEvent.click(screen.getByText('Create'));
    expect(await screen.findByText(/Give the recurring job a name/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('archives a series', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([job()]) });
    render(<RecurringJobsPanel customerId="c1" api={api} />);
    fireEvent.click(await screen.findByLabelText('Stop Monthly filter change'));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('r1'));
  });
});
