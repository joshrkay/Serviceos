// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  params: {} as Record<string, string>,
  fetchAvailability: vi.fn(),
  createAppointment: vi.fn(),
  customers: [] as Array<{ id: string; displayName?: string }>,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => h.params,
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: { tenant_id: 'ten-1', timezone: 'America/New_York' } }),
}));
// A STABLE client identity (the real useApiClient is memoized) — otherwise the
// availability effect, which depends on `api`, refires every render.
vi.mock('../lib/useApiClient', () => {
  const client = vi.fn();
  return { useApiClient: () => client };
});
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: h.customers, total: h.customers.length, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../api/appointments', () => ({
  fetchAvailability: (...args: unknown[]) => h.fetchAvailability(...args),
  createAppointment: (...args: unknown[]) => h.createAppointment(...args),
}));
// JobPicker pulls in the catalog/job-create flow; the booking wiring under test
// is the slot picker + POST, so stub it to a one-tap job selection.
vi.mock('../components/JobPicker', () => ({
  JobPicker: ({ onSelect }: { onSelect: (id: string) => void }) =>
    createElement('button', { onClick: () => onSelect('job-1') }, 'Pick job'),
}));

// eslint-disable-next-line import/first
import BookAppointment from '../../app/schedule/book';

const AVAILABILITY = {
  timezone: 'America/New_York',
  durationMin: 60,
  slots: [
    { start: '2026-07-23T18:00:00Z', end: '2026-07-23T19:00:00Z' },
    { start: '2026-07-23T19:00:00Z', end: '2026-07-23T20:00:00Z' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.params = {};
  h.customers = [];
  h.fetchAvailability.mockResolvedValue(AVAILABILITY);
  h.createAppointment.mockResolvedValue({ id: 'appt-1' });
});

afterEach(() => cleanup());

describe('Book appointment screen', () => {
  it('loads availability and books the chosen slot (pre-filled job)', async () => {
    h.params = { customerId: 'cust-1', jobId: 'job-9' };
    const { getByText, findByText } = render(createElement(BookAppointment));

    await waitFor(() => expect(h.fetchAvailability).toHaveBeenCalled());
    const [, tenantId, range] = h.fetchAvailability.mock.calls[0] as [unknown, string, { from: string; to: string }];
    expect(tenantId).toBe('ten-1');
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Slots render as tenant-zone wall-clock labels (18:00Z → 2:00 PM EDT).
    fireEvent.click(await findByText('2:00 PM'));
    fireEvent.click(getByText('Book visit'));

    await waitFor(() => expect(h.createAppointment).toHaveBeenCalled());
    expect(h.createAppointment).toHaveBeenCalledWith(expect.anything(), {
      jobId: 'job-9',
      scheduledStart: '2026-07-23T18:00:00Z',
      scheduledEnd: '2026-07-23T19:00:00Z',
      timezone: 'America/New_York',
    });
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/schedule'));
  });

  it('surfaces a double-booking conflict and reloads availability', async () => {
    h.params = { customerId: 'cust-1', jobId: 'job-9' };
    h.createAppointment.mockRejectedValueOnce(new Error('That technician is already booked at this time.'));
    const { getByText, findByText } = render(createElement(BookAppointment));

    await waitFor(() => expect(h.fetchAvailability).toHaveBeenCalledTimes(1));
    fireEvent.click(await findByText('2:00 PM'));
    fireEvent.click(getByText('Book visit'));

    await waitFor(() => expect(getByText(/already booked/)).toBeTruthy());
    // Availability is refetched so the operator picks from what's still open.
    expect(h.fetchAvailability).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('shows an empty-state when there are no open slots', async () => {
    h.params = { customerId: 'cust-1', jobId: 'job-9' };
    h.fetchAvailability.mockResolvedValue({ timezone: 'America/New_York', durationMin: 60, slots: [] });
    const { findByText } = render(createElement(BookAppointment));

    expect(await findByText(/No open slots/)).toBeTruthy();
  });
});
