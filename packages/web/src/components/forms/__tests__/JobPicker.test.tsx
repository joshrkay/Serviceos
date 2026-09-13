import React, { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobPicker, JobOption } from '../JobPicker';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

function Harness() {
  const [v, setV] = useState<JobOption | null>(null);
  return <JobPicker value={v} onChange={setV} />;
}

describe('JobPicker (#879)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('debounces typeahead by 300ms before calling the jobs API', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'j-1', jobNumber: 'JOB-001', summary: 'Fix AC' }] }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('job-search');

    fireEvent.change(input, { target: { value: 'ac' } });
    // Before 300ms: no fetch.
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();

    // After full 300ms: one fetch fires.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/jobs?search=ac&limit=10');

    vi.useRealTimers();
  });

  it('renders JOB-#### — summary (customer) options and selecting one updates the value', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'j-1',
            jobNumber: 'JOB-001',
            summary: 'Fix AC unit',
            customer: { displayName: 'Alice Smith' },
          },
          { id: 'j-2', jobNumber: 'JOB-002', summary: 'Drain cleaning' },
        ],
      }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('job-search');
    fireEvent.change(input, { target: { value: 'a' } });

    await waitFor(() => {
      expect(screen.getByTestId('job-option-j-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('job-option-j-1').textContent).toBe(
      'JOB-001 — Fix AC unit (Alice Smith)'
    );

    fireEvent.click(screen.getByTestId('job-option-j-1'));
    // Selected label should now appear in the input; the list closes.
    expect((input as HTMLInputElement).value).toContain('JOB-001');
    expect(screen.queryByTestId('job-picker-results')).not.toBeInTheDocument();
  });

  it('does not call the API when the search string is empty', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('shows an explicit "No matching jobs" empty state for a zero-result search', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    render(<Harness />);
    fireEvent.change(screen.getByLabelText('job-search'), {
      target: { value: 'zzz-nothing' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('job-picker-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('job-picker-empty').textContent).toBe('No matching jobs');
  });

  it('meets the 44px tap-target contract on the input and result options (CLAUDE.md)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'j-1', jobNumber: 'JOB-001', summary: 'Fix AC' }] }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('job-search');
    expect(input.className).toContain('min-h-11');

    fireEvent.change(input, { target: { value: 'ac' } });
    await waitFor(() => {
      expect(screen.getByTestId('job-option-j-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('job-option-j-1').className).toContain('min-h-11');
  });
});
