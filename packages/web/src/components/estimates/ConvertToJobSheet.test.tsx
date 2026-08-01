import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConvertToJobSheet } from './ConvertToJobSheet';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../hooks/useTechnicianRoster', () => ({ useTechnicianRoster: vi.fn() }));

import { apiFetch } from '../../utils/api-fetch';
import { useTechnicianRoster } from '../../hooks/useTechnicianRoster';

const input = {
  estimateId: 'est-1',
  estimateNumber: 'EST-001',
  customerName: 'Alice Smith',
  description: 'Furnace repair',
};

function mockApiOk(jobId: string) {
  (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => ({ job: { id: jobId } }),
  });
}

describe('ConvertToJobSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useTechnicianRoster as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      technicians: [{ id: 'tech-1', name: 'Dana Tech' }],
      isLoading: false,
      error: null,
    });
  });

  it('auto-schedules: POSTs to /from-estimate with an empty body and reports the new job', async () => {
    mockApiOk('job-99');
    const onConverted = vi.fn();
    render(<ConvertToJobSheet input={input} onClose={() => {}} onConverted={onConverted} />);

    fireEvent.click(screen.getByRole('button', { name: /convert to job/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/jobs/from-estimate/est-1',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
      );
    });
    await waitFor(() => expect(onConverted).toHaveBeenCalledWith('job-99'));
  });

  it('override: sends the picked technician and start time as an ISO instant', async () => {
    mockApiOk('job-77');
    render(<ConvertToJobSheet input={input} onClose={() => {}} onConverted={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /pick technician & time/i }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tech-1' } });
    fireEvent.change(screen.getByLabelText(/start time/i), {
      target: { value: '2026-07-01T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^convert to job$/i }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = JSON.parse(
      (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.technicianId).toBe('tech-1');
    expect(body.scheduledStart).toBe(new Date('2026-07-01T09:00').toISOString());
  });

  it('surfaces the backend error message (e.g. no technician available)', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'No technicians available to schedule this job' }),
    });
    const onConverted = vi.fn();
    render(<ConvertToJobSheet input={input} onClose={() => {}} onConverted={onConverted} />);

    fireEvent.click(screen.getByRole('button', { name: /^convert to job$/i }));

    expect(await screen.findByText(/no technicians available/i)).toBeInTheDocument();
    expect(onConverted).not.toHaveBeenCalled();
  });
});
