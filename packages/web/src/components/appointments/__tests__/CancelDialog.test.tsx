import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancelDialog } from '../CancelDialog';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('P11-007 CancelDialog', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('requires a reason before submitting', async () => {
    render(<CancelDialog appointmentId="a-1" />);
    fireEvent.click(screen.getByRole('button', { name: /confirm cancellation/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/reason/i);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('PUTs canonical status=canceled with the reason as notes on submit', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const onSaved = vi.fn();
    render(<CancelDialog appointmentId="a-1" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('cancelReason'), {
      target: { value: 'Customer rescheduled' },
    });
    fireEvent.click(screen.getByRole('button', { name: /confirm cancellation/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe('/api/appointments/a-1');
    expect(call[1]?.method).toBe('PUT');
    const body = JSON.parse(call[1]?.body as string);
    // Canonical API status is 'canceled' (single L); reason persists via notes.
    expect(body.status).toBe('canceled');
    expect(body.notes).toBe('Customer rescheduled');
  });

  it('calls onCancel when the back button is clicked', () => {
    const onCancel = vi.fn();
    render(<CancelDialog appointmentId="a-1" onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
