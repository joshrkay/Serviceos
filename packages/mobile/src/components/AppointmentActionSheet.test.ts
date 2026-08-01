// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  technicians: [] as { id: string; role: string; firstName?: string; lastName?: string }[],
  confirmAppointment: vi.fn().mockResolvedValue(undefined),
  cancelAppointment: vi.fn().mockResolvedValue(undefined),
  createReassignProposal: vi.fn().mockResolvedValue({ id: 'prop-1' }),
  addCrewMember: vi.fn().mockResolvedValue({ id: 'prop-2' }),
  removeCrewMember: vi.fn().mockResolvedValue({ id: 'prop-3' }),
  createRescheduleProposal: vi.fn().mockResolvedValue({ id: 'prop-4' }),
  fetchAvailability: vi.fn().mockResolvedValue({ timezone: 'UTC', durationMin: 60, slots: [] }),
  onClose: vi.fn(),
  onDone: vi.fn(),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: h.technicians, total: h.technicians.length, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../api/appointments', () => ({
  confirmAppointment: (...a: unknown[]) => h.confirmAppointment(...a),
  cancelAppointment: (...a: unknown[]) => h.cancelAppointment(...a),
  createReassignProposal: (...a: unknown[]) => h.createReassignProposal(...a),
  addCrewMember: (...a: unknown[]) => h.addCrewMember(...a),
  removeCrewMember: (...a: unknown[]) => h.removeCrewMember(...a),
  createRescheduleProposal: (...a: unknown[]) => h.createRescheduleProposal(...a),
  fetchAvailability: (...a: unknown[]) => h.fetchAvailability(...a),
}));

// eslint-disable-next-line import/first
import { AppointmentActionSheet } from './AppointmentActionSheet';

const APPT = { id: 'a1', updatedAt: 'v-1', status: 'scheduled' };

function renderSheet(appointment: typeof APPT | null = APPT) {
  return render(
    createElement(AppointmentActionSheet, {
      visible: true,
      appointment,
      timezone: 'America/New_York',
      onClose: h.onClose,
      onDone: h.onDone,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.technicians = [
    { id: '22222222-2222-2222-2222-222222222222', role: 'technician', firstName: 'Mia', lastName: 'Ross' },
    { id: '33333333-3333-3333-3333-333333333333', role: 'owner', firstName: 'Owner', lastName: 'Person' },
  ];
});

afterEach(() => cleanup());

describe('AppointmentActionSheet', () => {
  it('shows Confirm (B4) plus reschedule/reassign/crew/cancel actions for a scheduled appointment', () => {
    const { getByText } = renderSheet();
    expect(getByText('Confirm appointment')).toBeTruthy();
    expect(getByText('Reschedule…')).toBeTruthy();
    expect(getByText('Reassign technician…')).toBeTruthy();
    expect(getByText('Add crew member…')).toBeTruthy();
    expect(getByText('Remove crew member…')).toBeTruthy();
    expect(getByText('Cancel appointment…')).toBeTruthy();
  });

  it('hides Confirm once the appointment is already confirmed', () => {
    const { queryByText } = renderSheet({ ...APPT, status: 'confirmed' });
    expect(queryByText('Confirm appointment')).toBeNull();
    expect(queryByText('Cancel appointment…')).toBeTruthy();
  });

  it('B4: Confirm calls confirmAppointment then closes', async () => {
    const { getByText } = renderSheet();
    fireEvent.click(getByText('Confirm appointment').closest('button')!);
    await waitFor(() => expect(h.confirmAppointment).toHaveBeenCalledWith(h.api, 'a1'));
    expect(h.onDone).toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalled();
  });

  it('B3: Cancel demands the irreversible destructive confirm before firing', async () => {
    const { getByText, queryByText } = renderSheet();
    // Opening the menu does not cancel anything.
    fireEvent.click(getByText('Cancel appointment…').closest('button')!);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
    // The irreversible copy appears and the destructive confirm is required.
    expect(getByText(/this can't be undone/i)).toBeTruthy();
    const confirm = getByText('Yes, cancel it').closest('button')!;
    expect(confirm.className).toMatch(/bg-destructive/);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.cancelAppointment).toHaveBeenCalledWith(h.api, 'a1'));
  });

  it('B5: Reassign lists only technicians and mints a reassign proposal with the version', async () => {
    const { getByText, queryByText } = renderSheet();
    fireEvent.click(getByText('Reassign technician…').closest('button')!);
    expect(getByText('Mia Ross')).toBeTruthy();
    // The owner-role teammate is not offered as a reassignment target.
    expect(queryByText('Owner Person')).toBeNull();
    fireEvent.click(getByText('Mia Ross').closest('button')!);
    fireEvent.click(getByText('Send change').closest('button')!);
    await waitFor(() =>
      expect(h.createReassignProposal).toHaveBeenCalledWith(h.api, {
        appointmentId: 'a1',
        toTechnicianId: '22222222-2222-2222-2222-222222222222',
        appointmentVersion: 'v-1',
      }),
    );
  });

  it('warns and blocks version-dependent actions when the appointment has no version', () => {
    const { getByText } = renderSheet({ id: 'a1', status: 'scheduled' } as typeof APPT);
    expect(getByText(/need the latest appointment data/i)).toBeTruthy();
    expect(getByText('Reschedule…').closest('button')!.disabled).toBe(true);
    expect(getByText('Reassign technician…').closest('button')!.disabled).toBe(true);
    // Confirm and Cancel are direct (no version) and stay enabled.
    expect(getByText('Confirm appointment').closest('button')!.disabled).toBe(false);
  });
});
