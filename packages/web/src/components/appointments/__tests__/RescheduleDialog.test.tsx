import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RescheduleDialog } from '../RescheduleDialog';

const _sharedApiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: _sharedApiFetchMock,
}));
vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => _sharedApiFetchMock,
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('P11-007 RescheduleDialog', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders start and end inputs pre-filled from initial values', () => {
    render(
      <RescheduleDialog
        appointmentId="a-1"
        initialStart="2026-06-01T15:00:00Z"
        initialEnd="2026-06-01T16:00:00Z"
      />
    );
    expect(screen.getByLabelText('scheduledStart')).toBeInTheDocument();
    expect(screen.getByLabelText('scheduledEnd')).toBeInTheDocument();
  });

  it('disables save when end is not after start', () => {
    render(<RescheduleDialog appointmentId="a-1" />);
    fireEvent.change(screen.getByLabelText('scheduledStart'), {
      target: { value: '2026-06-01T15:00' },
    });
    fireEvent.change(screen.getByLabelText('scheduledEnd'), {
      target: { value: '2026-06-01T14:00' },
    });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('PUTs ISO timestamps on save', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const onSaved = vi.fn();
    render(<RescheduleDialog appointmentId="a-1" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('scheduledStart'), {
      target: { value: '2026-06-01T15:00' },
    });
    fireEvent.change(screen.getByLabelText('scheduledEnd'), {
      target: { value: '2026-06-01T16:00' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe('/api/appointments/a-1');
    expect(call[1]?.method).toBe('PUT');
    const body = JSON.parse(call[1]?.body as string);
    expect(body.scheduledStart).toMatch(/T/);
    expect(body.scheduledEnd).toMatch(/T/);
    expect(new Date(body.scheduledEnd).getTime()).toBeGreaterThan(
      new Date(body.scheduledStart).getTime()
    );
  });

  it('surfaces API errors', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'boom' }),
    } as unknown as Response);

    render(<RescheduleDialog appointmentId="a-1" />);
    fireEvent.change(screen.getByLabelText('scheduledStart'), {
      target: { value: '2026-06-01T15:00' },
    });
    fireEvent.change(screen.getByLabelText('scheduledEnd'), {
      target: { value: '2026-06-01T16:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
