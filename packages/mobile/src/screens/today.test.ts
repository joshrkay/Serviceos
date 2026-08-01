// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnRouteNoticeResponse,
  MeResponse,
  TechnicianDayAppointment,
} from '@ai-service-os/shared';
import { __setLinkingOpenURL } from '../../test/stubs/react-native';

const TECHNICIAN_ID = '059f1a36-2d09-4698-954f-e640d61a9237';
const DEFAULT_ME: MeResponse = {
  user_id: 'user_clerk_123',
  internal_user_id: TECHNICIAN_ID,
  tenant_id: 'tenant-1',
  role: 'technician',
  can_field_serve: true,
  current_mode: 'tech',
  mode_changed_at: null,
  permissions: [],
  backup_supervisor_user_id: null,
  timezone: 'America/Los_Angeles',
  unsupervised_proposal_routing: 'queue_only',
};
const APPOINTMENT: TechnicianDayAppointment = {
  id: 'appointment-1',
  jobId: 'job-1',
  customerName: 'Rivera Family',
  locationAddress: '12 Market St, Oakland, CA',
  locationLatitude: 37.8,
  locationLongitude: -122.3,
  scheduledStart: '2026-07-15T16:00:00.000Z',
  scheduledEnd: '2026-07-15T17:30:00.000Z',
  status: 'scheduled',
  jobSummary: 'Repair upstairs air conditioner',
  updatedAt: '2026-07-15T14:00:00.000Z',
};

const h = vi.hoisted(() => ({
  push: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  client: vi.fn(),
  listAppointments: vi.fn(),
  enRoute: vi.fn(),
  runningLate: vi.fn(),
  me: null as MeResponse | null,
  meLoading: false,
  meError: null as Error | null,
  meRefetch: vi.fn(),
  trackingStatus: 'tracking' as
    | 'idle'
    | 'requesting'
    | 'tracking'
    | 'paused'
    | 'denied'
    | 'error',
  tracker: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({
    showToast: h.showToast,
    showErrorToast: h.showErrorToast,
    hideToast: vi.fn(),
  }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({
    me: h.me,
    isLoading: h.meLoading,
    error: h.meError,
    switchMode: vi.fn(),
    refetch: h.meRefetch,
  }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.client }));
vi.mock('../api/technicianField', () => ({
  listTechnicianAppointments: h.listAppointments,
  postEnRoute: h.enRoute,
  postRunningLate: h.runningLate,
}));
vi.mock('../location/useForegroundLocationTracker', () => ({
  useForegroundLocationTracker: (options: unknown) => h.tracker(options),
}));

// eslint-disable-next-line import/first
import Today from '../../app/(tabs)/today';

beforeEach(() => {
  vi.clearAllMocks();
  h.me = { ...DEFAULT_ME };
  h.meLoading = false;
  h.meError = null;
  h.trackingStatus = 'tracking';
  h.tracker.mockImplementation(() => ({ status: h.trackingStatus }));
  h.listAppointments.mockResolvedValue({ appointments: [APPOINTMENT], total: 1 });
  h.enRoute.mockResolvedValue({ accepted: true, notified: true, idempotencyKey: 'notice-1' });
  h.runningLate.mockResolvedValue({
    appointmentId: APPOINTMENT.id,
    delayMinutes: 20,
    queued: true,
  });
  __setLinkingOpenURL(async () => undefined);
});

afterEach(() => cleanup());

describe('Today technician screen', () => {
  it('loads the day with me.internal_user_id and never the Clerk user id', async () => {
    render(createElement(Today));

    await waitFor(() => expect(h.listAppointments).toHaveBeenCalledTimes(1));
    expect(h.listAppointments.mock.calls[0]?.[1]).toBe(TECHNICIAN_ID);
    expect(h.listAppointments.mock.calls[0]?.[1]).not.toBe(DEFAULT_ME.user_id);
    expect(h.listAppointments.mock.calls[0]?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows a no-profile state without calling the technician endpoint', () => {
    h.me = { ...DEFAULT_ME, internal_user_id: null };
    const { getByText } = render(createElement(Today));

    expect(getByText('No technician profile')).toBeTruthy();
    expect(h.listAppointments).not.toHaveBeenCalled();
  });

  it('renders the focused appointment details and 44px action contract', async () => {
    const { container, getByText } = render(createElement(Today));

    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());
    expect(getByText('Next up')).toBeTruthy();
    expect(getByText('9:00 AM–10:30 AM')).toBeTruthy();
    expect(getByText('12 Market St, Oakland, CA')).toBeTruthy();
    expect(getByText('Scheduled')).toBeTruthy();
    expect(getByText('Repair upstairs air conditioner')).toBeTruthy();
    expect(getByText('Sharing location for Rivera Family')).toBeTruthy();

    // En route + three running-late chips (10/20/30) + Open job + Maps.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.className).toMatch(/\bmin-h-11\b/);
      expect(button.className).not.toMatch(/\bmin-w-\[/);
    }
    expect(container.firstElementChild?.className).toMatch(/\bmax-w-full\b/);
    // The chip row names the action + recipient; each chip names its duration.
    expect(getByText('Running late? Let Rivera Family know how far behind you are:')).toBeTruthy();
    expect(getByText('10 min')).toBeTruthy();
    expect(getByText('20 min')).toBeTruthy();
    expect(getByText('30 min')).toBeTruthy();
  });

  it('attaches GPS pings to the active / next appointment id', async () => {
    vi.setSystemTime(new Date('2026-07-15T15:00:00.000Z'));
    render(createElement(Today));

    await waitFor(() =>
      expect(h.tracker).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          technicianId: TECHNICIAN_ID,
          appointmentId: APPOINTMENT.id,
        }),
      ),
    );
  });

  it('locks GPS to the visit the technician marked en route', async () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    const later: TechnicianDayAppointment = {
      ...APPOINTMENT,
      id: 'appointment-2',
      jobId: 'job-2',
      customerName: 'Later Stop',
      scheduledStart: '2026-07-15T20:00:00.000Z',
      scheduledEnd: '2026-07-15T21:00:00.000Z',
    };
    h.listAppointments.mockResolvedValue({
      appointments: [APPOINTMENT, later],
      total: 2,
    });
    const { getAllByText, getByText } = render(createElement(Today));
    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());

    fireEvent.click(getAllByText('En route')[1]!.closest('button')!);
    await waitFor(() =>
      expect(h.tracker).toHaveBeenCalledWith(
        expect.objectContaining({ appointmentId: later.id }),
      ),
    );
  });

  it('renders an empty day and can refetch after an API error', async () => {
    h.listAppointments
      .mockRejectedValueOnce(new Error('Today failed'))
      .mockResolvedValueOnce({ appointments: [], total: 0 });
    const { getByText } = render(createElement(Today));

    await waitFor(() => expect(getByText('Today failed')).toBeTruthy());
    fireEvent.click(getByText('Try again').closest('button')!);
    await waitFor(() => expect(h.listAppointments).toHaveBeenCalledTimes(2));
    expect(getByText('No visits scheduled today.')).toBeTruthy();
  });

  it('prevents duplicate en-route taps and surfaces success through the toast', async () => {
    let resolveEnRoute!: (response: EnRouteNoticeResponse) => void;
    h.enRoute.mockReturnValueOnce(
      new Promise<EnRouteNoticeResponse>((resolve) => {
        resolveEnRoute = resolve;
      }),
    );
    const { getByText } = render(createElement(Today));
    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());

    const button = getByText('En route').closest('button')!;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(h.enRoute).toHaveBeenCalledTimes(1);

    resolveEnRoute({ accepted: true, notified: true, idempotencyKey: 'notice-1' });
    await waitFor(() =>
      expect(h.showToast).toHaveBeenCalledWith({
        title: 'Customer notified',
        body: 'They know you are on the way.',
        tone: 'info',
      }),
    );
  });

  it('opens jobs and maps when location data is available', async () => {
    const openURL = vi.fn(async () => undefined);
    __setLinkingOpenURL(openURL);
    const { getByText } = render(createElement(Today));
    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());

    fireEvent.click(getByText('Open job').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/jobs/job-1');
    fireEvent.click(getByText('Maps').closest('button')!);
    await waitFor(() =>
      expect(openURL).toHaveBeenCalledWith(
        'http://maps.apple.com/?q=12%20Market%20St%2C%20Oakland%2C%20CA',
      ),
    );
  });

  it('sends only the explicitly chosen running-late duration (no default fires)', async () => {
    const { getByText } = render(createElement(Today));
    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());

    // Rendering the picker must not send anything on its own.
    expect(h.runningLate).not.toHaveBeenCalled();

    fireEvent.click(getByText('30 min').closest('button')!);
    await waitFor(() =>
      expect(h.runningLate).toHaveBeenCalledWith(expect.any(Function), APPOINTMENT.id, 30),
    );
    // Exactly one notice, carrying only the tapped duration — no 20m default.
    expect(h.runningLate).toHaveBeenCalledTimes(1);
    expect(h.runningLate).not.toHaveBeenCalledWith(expect.any(Function), APPOINTMENT.id, 20);
    await waitFor(() =>
      expect(h.showToast).toHaveBeenCalledWith({
        title: 'Delay sent',
        body: 'The customer was told you are running 30 minutes late.',
        tone: 'info',
      }),
    );
  });

  it('sends each chip’s own duration and toasts action failures', async () => {
    const failure = new Error('Could not notify');
    h.runningLate.mockRejectedValueOnce(failure);
    const { getByText } = render(createElement(Today));
    await waitFor(() => expect(getByText('Rivera Family')).toBeTruthy());

    fireEvent.click(getByText('10 min').closest('button')!);
    await waitFor(() =>
      expect(h.runningLate).toHaveBeenCalledWith(expect.any(Function), APPOINTMENT.id, 10),
    );
    expect(h.showErrorToast).toHaveBeenCalledWith(failure);
  });
});
