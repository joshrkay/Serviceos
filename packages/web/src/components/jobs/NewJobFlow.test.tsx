import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayInTz, tenantWallClockToUtc } from '../../utils/formatInTenantTz';
import { NewJobFlow } from './NewJobFlow';

const TZ = 'America/Los_Angeles';

const ROBERTO = {
  id: 'cust-roberto',
  displayName: 'Roberto Rodriguez',
  primaryPhone: '512-555-0100',
  locations: [
    {
      id: 'loc-1',
      street1: '412 Maple Drive, Austin TX',
      city: '',
      state: '',
      postalCode: '',
      isPrimary: true,
      serviceTypes: ['HVAC'],
    },
  ],
};

// Hoisted, reconfigurable mock state so individual tests can swap the customer
// list and drive the job/appointment mutations + apiFetch independently.
const H = vi.hoisted(() => ({
  customers: [] as unknown[],
  jobsMutate: vi.fn(),
  apptMutate: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: H.customers,
    total: H.customers.length,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  }),
}));

vi.mock('../../hooks/useTechnicianRoster', () => ({
  useTechnicianRoster: () => ({ technicians: [], isLoading: false, error: null }),
}));

vi.mock('../../hooks/useTenantTimezone', () => ({
  useTenantTimezone: () => TZ,
}));

vi.mock('../../hooks/useMutation', () => ({
  useMutation: (_method: string, path: string) => ({
    mutate: path === '/api/appointments' ? H.apptMutate : H.jobsMutate,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => H.apiFetch(...args),
}));

function renderFlow(props: Partial<React.ComponentProps<typeof NewJobFlow>> = {}) {
  return render(
    <NewJobFlow onClose={vi.fn()} onCreated={vi.fn()} {...props} />,
  );
}

/** Advance the manual flow to the schedule step with Roberto selected. */
async function goToScheduleStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Fill it in'));
  await user.click(screen.getByText('Roberto Rodriguez'));
  await user.click(screen.getByRole('button', { name: /next: job details/i }));
  await user.type(
    screen.getByPlaceholderText(/Describe the issue/i),
    'AC not cooling in the bedroom',
  );
  await user.click(screen.getByRole('button', { name: /next: schedule/i }));
}

beforeEach(() => {
  H.customers = [ROBERTO];
  H.jobsMutate.mockReset();
  H.apptMutate.mockReset();
  H.apiFetch.mockReset();
  H.apiFetch.mockResolvedValue({ ok: true, json: async () => [] });
});

describe('NewJobFlow', () => {
  it('allows creating and selecting a new customer from the customer step', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Taylor Rivera');
    await user.type(screen.getByPlaceholderText('Address *'), '99 Test Lane, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    expect(await screen.findByText('Taylor Rivera')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /next: job details/i })).toBeEnabled();
  });

  it('marks an existing customer address as old when a new customer is created with the same address', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Jordan Lopez');
    await user.type(screen.getByPlaceholderText('Address *'), '412 Maple Drive, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    const existingCustomerRow = (await screen.findByText('Roberto Rodriguez')).closest('button');
    expect(existingCustomerRow).not.toBeNull();
    expect(await within(existingCustomerRow as HTMLElement).findByText('old address')).toBeInTheDocument();
  });

  it('renders the customer step on Path A tokens with kit inputs — no raw palette leaks', async () => {
    const user = userEvent.setup();
    const { container } = renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    // The migrated new-customer fields are kit inputs with a ≥44px target.
    expect(screen.getByPlaceholderText('Full name *')).toHaveClass('min-h-11');
    expect(screen.getByPlaceholderText('Address *')).toHaveClass('min-h-11');

    // No raw Tailwind palette classes survive the Path A migration.
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });

  describe('create with a chosen slot', () => {
    it('POSTs /api/jobs, then /api/appointments (tenant-tz instants), then transitions the job to scheduled', async () => {
      const user = userEvent.setup();
      H.jobsMutate.mockResolvedValue({ id: 'job-new-1', jobNumber: 'JOB-100' });
      H.apptMutate.mockResolvedValue({ id: 'appt-1' });
      H.apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

      const onCreated = vi.fn();
      renderFlow({ onCreated });

      await goToScheduleStep(user);
      await user.click(screen.getByText('Today'));
      await user.click(screen.getByText('2:00 PM'));
      await user.click(screen.getByRole('button', { name: /create job/i }));

      // Job created first.
      await waitFor(() =>
        expect(H.jobsMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            customerId: 'cust-roberto',
            locationId: 'loc-1',
            summary: 'AC not cooling in the bedroom',
            priority: 'normal',
          }),
        ),
      );

      // Appointment persisted with the correct tenant-tz instants.
      const dateKey = todayInTz(TZ);
      const start = tenantWallClockToUtc(dateKey, '14:00', TZ);
      const end = new Date(start.getTime() + 60 * 60_000);
      await waitFor(() =>
        expect(H.apptMutate).toHaveBeenCalledWith({
          jobId: 'job-new-1',
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
          timezone: TZ,
        }),
      );

      // Job transitioned forward so it lands on the Scheduled tab.
      await waitFor(() =>
        expect(H.apiFetch).toHaveBeenCalledWith(
          '/api/jobs/job-new-1/transition',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ status: 'scheduled' }),
          }),
        ),
      );

      // Ordering: jobs → appointments → transition.
      const jobOrder = H.jobsMutate.mock.invocationCallOrder[0];
      const apptOrder = H.apptMutate.mock.invocationCallOrder[0];
      const transitionCall = H.apiFetch.mock.calls.findIndex(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'),
      );
      const transitionOrder = H.apiFetch.mock.invocationCallOrder[transitionCall];
      expect(jobOrder).toBeLessThan(apptOrder);
      expect(apptOrder).toBeLessThan(transitionOrder);

      // Done screen routes to the Scheduled tab.
      await user.click(await screen.findByText('View job'));
      expect(onCreated).toHaveBeenCalledWith('Scheduled');
    });
  });

  describe('create without a slot', () => {
    it('does not POST an appointment or transition, and the done screen shows no fabricated schedule', async () => {
      const user = userEvent.setup();
      H.jobsMutate.mockResolvedValue({ id: 'job-new-2', jobNumber: 'JOB-101' });

      renderFlow();

      await goToScheduleStep(user);
      // Leave the job unscheduled — pick no date/time.
      await user.click(screen.getByRole('button', { name: /create job/i }));

      await waitFor(() => expect(H.jobsMutate).toHaveBeenCalledTimes(1));

      expect(H.apptMutate).not.toHaveBeenCalled();
      expect(
        H.apiFetch.mock.calls.some(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'),
        ),
      ).toBe(false);

      // Done screen shows only persisted facts.
      expect(await screen.findByText('Unscheduled')).toBeInTheDocument();
    });
  });

  describe('voice flow', () => {
    class MockRecorder {
      state = 'inactive';
      ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
      onstop: (() => void) | null = null;
      mimeType = 'audio/webm';
      constructor(public stream: unknown) {}
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }

    beforeEach(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
      });
      vi.stubGlobal('MediaRecorder', MockRecorder as unknown as typeof MediaRecorder);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      // @ts-expect-error test cleanup of the injected mediaDevices
      delete navigator.mediaDevices;
    });

    it('fetches locations for the matched customer and renders the location picker', async () => {
      H.customers = [
        { id: 'cust-maria', displayName: 'Maria Garcia', primaryPhone: '512-555-0111', locations: [] },
      ];
      H.apiFetch.mockImplementation((url: unknown) => {
        if (typeof url === 'string' && url.startsWith('/api/voice/transcribe')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ transcript: 'Schedule an HVAC job for Maria Garcia, AC not cooling' }),
          });
        }
        if (typeof url === 'string' && url.startsWith('/api/locations')) {
          return Promise.resolve({
            ok: true,
            json: async () => [
              { id: 'loc-m1', label: 'Home', street1: '1 A St', city: 'LA', state: 'CA', postalCode: '90001', isPrimary: true, serviceTypes: ['HVAC'] },
            ],
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderFlow();

      await act(async () => { screen.getByText('Speak it').click(); });
      await act(async () => { screen.getByText('Tap to start').click(); });
      await waitFor(() =>
        expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled(),
      );
      // Flush the microtask that creates + starts the recorder.
      await act(async () => { await Promise.resolve(); });

      await act(async () => { screen.getByText('Tap to stop').click(); });
      await waitFor(() => expect(screen.getByText(/Parse this job/i)).toBeInTheDocument());

      await act(async () => { screen.getByText(/Parse this job/i).click(); });

      await waitFor(() =>
        expect(H.apiFetch).toHaveBeenCalledWith('/api/locations?customerId=cust-maria'),
      );
      expect(screen.getByText('Service location')).toBeInTheDocument();
      expect(screen.getByText('Home')).toBeInTheDocument();
    });
  });
});
