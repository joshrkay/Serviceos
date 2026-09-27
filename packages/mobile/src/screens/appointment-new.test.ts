// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Customer { id: string; displayName?: string }

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  api: vi.fn(),
  customers: [] as Customer[],
  fetchAvailability: vi.fn(),
  createAppointment: vi.fn(),
  run: vi.fn(),
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  error: null as string | null,
  timezone: 'America/New_York' as string | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: { timezone: h.timezone }, isLoading: false, error: null, switchMode: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: h.customers, total: h.customers.length, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../hooks/useSavePhase', () => ({
  useSavePhase: () => ({ phase: h.phase, error: h.error, run: h.run, reset: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../api/appointments', () => ({
  fetchAvailability: (...a: unknown[]) => h.fetchAvailability(...a),
  createAppointment: (...a: unknown[]) => h.createAppointment(...a),
}));
// Stub the entity/slot children so the test drives screen logic, not their
// internals. Host elements only — no dynamic import() (tsc rejects it, TS1323).
vi.mock('../components/JobPicker', () => ({
  JobPicker: ({ onSelect }: { onSelect: (id: string) => void }) =>
    createElement('button', { onClick: () => onSelect('job-1') }, 'pick-job'),
}));
vi.mock('../components/SlotPicker', () => ({
  SlotPicker: ({
    slots,
    onSelect,
    configNotes,
  }: {
    slots: { start: string; end: string }[];
    onSelect: (s: unknown) => void;
    configNotes?: string[];
  }) =>
    createElement(
      'div',
      null,
      (configNotes ?? []).map((n) => createElement('p', { key: n }, `note-${n}`)),
      slots.map((s) =>
        createElement('button', { key: s.start, onClick: () => onSelect(s) }, `slot-${s.start}`),
      ),
    ),
}));

// eslint-disable-next-line import/first
import NewAppointment from '../../app/appointments/new';

const SLOT = { start: '2026-06-22T13:00:00.000Z', end: '2026-06-22T14:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'idle';
  h.error = null;
  h.timezone = 'America/New_York';
  h.customers = [{ id: 'cust-1', displayName: 'Acme Co' }];
  h.run.mockImplementation(async (fn: () => Promise<void>) => { await fn(); });
  h.fetchAvailability.mockResolvedValue({ timezone: 'America/New_York', durationMin: 60, slots: [SLOT] });
  h.createAppointment.mockResolvedValue({ id: 'appt-1' });
});

afterEach(() => cleanup());

describe('New appointment (manual booking) screen', () => {
  it('renders the customer step and disables Next until a customer is picked', () => {
    const { getByText } = render(createElement(NewAppointment));
    expect(getByText('Pick a customer')).toBeTruthy();
    expect(getByText('Next: job').closest('button')!.disabled).toBe(true);
  });

  it('books an appointment end to end and returns to the schedule', async () => {
    const { getByText } = render(createElement(NewAppointment));

    // Step 1 → pick customer.
    fireEvent.click(getByText('Acme Co').closest('button')!);
    fireEvent.click(getByText('Next: job').closest('button')!);

    // Step 2 → pick job via the stub.
    fireEvent.click(getByText('pick-job').closest('button')!);
    fireEvent.click(getByText('Next: time').closest('button')!);

    // Step 3 → availability fetched, pick the slot.
    await waitFor(() => expect(h.fetchAvailability).toHaveBeenCalled());
    fireEvent.click(getByText(`slot-${SLOT.start}`).closest('button')!);
    fireEvent.click(getByText('Review').closest('button')!);

    // Step 4 → book.
    fireEvent.click(getByText('Book it').closest('button')!);

    await waitFor(() =>
      expect(h.createAppointment).toHaveBeenCalledWith(h.api, {
        jobId: 'job-1',
        scheduledStart: SLOT.start,
        scheduledEnd: SLOT.end,
        timezone: 'America/New_York',
      }),
    );
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/schedule'));
  });

  it('#1243: the time step hands the availability defaults notes to the slot picker', async () => {
    const note = 'Travel buffer not configured — using the 30-minute default.';
    h.fetchAvailability.mockResolvedValue({
      timezone: 'America/New_York',
      durationMin: 60,
      slots: [SLOT],
      config: {
        timezoneSource: 'tenant',
        businessHoursSource: 'tenant',
        bufferSource: 'default',
        bufferMinutes: 30,
        notes: [note],
      },
    });
    const { getByText, findByText } = render(createElement(NewAppointment));
    fireEvent.click(getByText('Acme Co').closest('button')!);
    fireEvent.click(getByText('Next: job').closest('button')!);
    fireEvent.click(getByText('pick-job').closest('button')!);
    fireEvent.click(getByText('Next: time').closest('button')!);
    expect(await findByText(`note-${note}`)).toBeTruthy();
  });
});
