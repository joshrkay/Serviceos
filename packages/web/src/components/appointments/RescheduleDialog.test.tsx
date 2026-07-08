import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RescheduleDialog } from './RescheduleDialog';
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../utils/api-fetch';

function renderDialog(props: Partial<React.ComponentProps<typeof RescheduleDialog>> = {}) {
  return render(
    <TenantTimezoneProvider overrideTimezone="America/New_York">
      <RescheduleDialog appointmentId="appt-1" {...props} />
    </TenantTimezoneProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
});

describe('RescheduleDialog — tenant-tz round-trip', () => {
  it('renders the initial UTC instants as tenant-local wall clock (EST)', () => {
    // 13:00Z / 15:00Z on a winter day = 08:00 / 10:00 EST (UTC-5).
    renderDialog({ initialStart: '2026-01-15T13:00:00Z', initialEnd: '2026-01-15T15:00:00Z' });
    expect((screen.getByLabelText('scheduledStart') as HTMLInputElement).value).toBe('2026-01-15T08:00');
    expect((screen.getByLabelText('scheduledEnd') as HTMLInputElement).value).toBe('2026-01-15T10:00');
  });

  it('submits the entered tenant-local wall clock converted to UTC, not browser-local', async () => {
    renderDialog({ initialStart: '2026-01-15T13:00:00Z', initialEnd: '2026-01-15T15:00:00Z' });

    // Operator moves the appointment to 09:00–11:00 tenant-local.
    fireEvent.change(screen.getByLabelText('scheduledStart'), {
      target: { value: '2026-01-15T09:00' },
    });
    fireEvent.change(screen.getByLabelText('scheduledEnd'), {
      target: { value: '2026-01-15T11:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/api/appointments/appt-1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]!.body));
    // 09:00 / 11:00 EST (UTC-5) = 14:00Z / 16:00Z.
    expect(body.scheduledStart).toBe('2026-01-15T14:00:00.000Z');
    expect(body.scheduledEnd).toBe('2026-01-15T16:00:00.000Z');
  });
});
