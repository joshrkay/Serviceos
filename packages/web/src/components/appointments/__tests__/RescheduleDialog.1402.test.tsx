/**
 * #1402 §3/§15 — the reschedule form refuses a start in the past and shows
 * the API's non-blocking outside-business-hours warning after saving.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RescheduleDialog } from '../RescheduleDialog';
import { TenantTimezoneProvider } from '../../../hooks/useTenantTimezone';

vi.mock('../../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../../utils/api-fetch';
import { expectAllTapTargets } from '../../../test-utils/tap-target';

function renderDialog(onSaved = vi.fn()) {
  render(
    <TenantTimezoneProvider overrideTimezone="UTC">
      <RescheduleDialog appointmentId="appt-1" onSaved={onSaved} />
    </TenantTimezoneProvider>,
  );
  return onSaved;
}

function enter(start: string, end: string) {
  fireEvent.change(screen.getByLabelText('scheduledStart'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('scheduledEnd'), { target: { value: end } });
}

describe('#1402 RescheduleDialog — scheduling integrity', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('refuses a start in the past without calling the API', async () => {
    const onSaved = renderDialog();
    enter('2020-01-01T09:00', '2020-01-01T10:00');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/in the past/i);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('after saving an out-of-hours slot, shows the warning and closes only on Done', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'appt-1', warnings: ['Appointment is outside business hours'] }),
    } as unknown as Response);
    const onSaved = renderDialog();
    enter('2099-06-01T22:00', '2099-06-01T23:00');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Saved. Appointment is outside business hours',
    );
    expect(onSaved).not.toHaveBeenCalled();
    expectAllTapTargets(screen.getByTestId('reschedule-dialog'), 'reschedule warning state');
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('every control in the form is a ≥44px tap target', () => {
    renderDialog();
    expectAllTapTargets(screen.getByTestId('reschedule-dialog'), 'reschedule form');
  });
});
