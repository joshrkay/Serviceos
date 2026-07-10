import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReassignDialog } from '../ReassignDialog';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('P11-007 ReassignDialog', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('loads users from /api/users?role=technician and renders them', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'u-1', name: 'Tech One' },
          { id: 'u-2', name: 'Tech Two' },
        ],
      }),
    } as unknown as Response);

    render(<ReassignDialog appointmentId="a-1" jobId="j-1" />);

    await waitFor(() => {
      expect(screen.getByText('Tech One')).toBeInTheDocument();
      expect(screen.getByText('Tech Two')).toBeInTheDocument();
    });

    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/users?role=technician');
  });

  it('PUTs assignedTechnicianId to the job on save', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'u-1', name: 'Tech One' }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response);

    const onSaved = vi.fn();
    render(<ReassignDialog appointmentId="a-1" jobId="j-1" onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByText('Tech One')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('assignedUserId'), { target: { value: 'u-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = vi.mocked(apiFetch).mock.calls[1];
    // Assignment persists on the job, not the appointment (which has no
    // assignment field).
    expect(putCall[0]).toBe('/api/jobs/j-1');
    expect(putCall[1]?.method).toBe('PUT');
    const body = JSON.parse(putCall[1]?.body as string);
    expect(body.assignedTechnicianId).toBe('u-1');
  });

  it('falls back to manual ID input when users endpoint fails', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response);

    render(<ReassignDialog appointmentId="a-1" jobId="j-1" />);

    await waitFor(() => {
      const input = screen.getByLabelText('assignedUserId') as HTMLInputElement;
      expect(input.tagName).toBe('INPUT');
    });
  });

  it('requires a selection before submit', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'u-1', name: 'Tech One' }] }),
    } as unknown as Response);

    render(<ReassignDialog appointmentId="a-1" jobId="j-1" />);

    await waitFor(() => {
      expect(screen.getByText('Tech One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pick/i);
  });
});
