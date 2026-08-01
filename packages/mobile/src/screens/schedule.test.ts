// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@ai-service-os/shared';

interface Appointment {
  id: string;
  scheduledStart?: string;
  status?: string;
  appointmentType?: string;
  updatedAt?: string;
}

const SUPERVISOR_ME: MeResponse = {
  user_id: 'user_clerk_owner',
  internal_user_id: '059f1a36-2d09-4698-954f-e640d61a9237',
  tenant_id: 'tenant-1',
  role: 'owner',
  can_field_serve: false,
  current_mode: 'supervisor',
  mode_changed_at: null,
  permissions: [],
  backup_supervisor_user_id: null,
  timezone: undefined,
  unsupervised_proposal_routing: 'queue_only',
};

const TECH_ME: MeResponse = {
  ...SUPERVISOR_ME,
  user_id: 'user_clerk_tech',
  role: 'technician',
  can_field_serve: true,
  current_mode: 'tech',
};

const h = vi.hoisted(() => ({
  calledWith: [] as unknown[],
  data: [] as Appointment[],
  isLoading: false,
  error: null as string | null,
  me: null as MeResponse | null,
  replace: vi.fn(),
  push: vi.fn(),
  sheetProps: null as unknown,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: h.replace }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({
    me: h.me,
    isLoading: false,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string, options?: unknown) => {
    h.calledWith = [endpoint, options];
    return {
      data: h.data,
      total: h.data.length,
      isLoading: h.isLoading,
      error: h.error,
      refetch: vi.fn(),
    };
  },
}));
// Stub the action sheet so the schedule test asserts open/close wiring, not the
// sheet's internals (those are covered by the component's own tests). Host
// element only — no dynamic import() (tsc rejects it, TS1323).
vi.mock('../components/AppointmentActionSheet', () => ({
  AppointmentActionSheet: (props: { appointment?: { id?: string } }) => {
    h.sheetProps = props;
    return createElement('span', null, `sheet-open-${props.appointment?.id ?? ''}`);
  },
}));

// eslint-disable-next-line import/first
import Schedule from '../../app/schedule';

beforeEach(() => {
  vi.clearAllMocks();
  h.calledWith = [];
  h.data = [];
  h.isLoading = false;
  h.error = null;
  h.me = { ...SUPERVISOR_ME };
  h.sheetProps = null;
});

afterEach(() => cleanup());

describe('Schedule screen', () => {
  it('requests appointments with paginated=true (avoids the legacy 400)', () => {
    render(createElement(Schedule));
    expect(h.calledWith[0]).toBe('/api/appointments');
    expect(h.calledWith[1]).toEqual({
      params: { paginated: 'true' },
      enabled: true,
    });
  });

  it('redirects technicians to Today and skips the tenant-wide appointments fetch', () => {
    h.me = { ...TECH_ME };
    const { container } = render(createElement(Schedule));
    expect(h.replace).toHaveBeenCalledWith('/(tabs)/today');
    expect(h.calledWith[1]).toEqual({
      params: { paginated: 'true' },
      enabled: false,
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders an appointment row with its date and title-cased type/status', () => {
    h.data = [
      { id: 'a1', scheduledStart: '2026-06-22T12:00:00Z', status: 'scheduled', appointmentType: 'repair' },
    ];
    const { getByText } = render(createElement(Schedule));
    expect(getByText('Repair · Scheduled')).toBeTruthy();
  });

  it('renders the appointment date in the tenant timezone', () => {
    // 2026-06-22T02:00:00Z is still Jun 21 in America/New_York (UTC-4).
    h.me = { ...SUPERVISOR_ME, timezone: 'America/New_York' };
    h.data = [{ id: 'a1', scheduledStart: '2026-06-22T02:00:00Z' }];
    const { getByText } = render(createElement(Schedule));
    expect(getByText('Jun 21, 2026')).toBeTruthy();
  });

  it('shows the empty state when nothing is scheduled', () => {
    const { getByText } = render(createElement(Schedule));
    expect(getByText('Nothing scheduled.')).toBeTruthy();
  });

  it('navigates to manual booking from the Book header action', () => {
    const { getByText } = render(createElement(Schedule));
    fireEvent.click(getByText('Book').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/appointments/new');
  });

  it('opens the action sheet for the tapped appointment (with its version)', () => {
    h.data = [{ id: 'a1', scheduledStart: '2026-06-22T12:00:00Z', status: 'scheduled', updatedAt: 'v-1' }];
    const { getByText } = render(createElement(Schedule));
    // No sheet before a row is tapped.
    expect(() => getByText('sheet-open-a1')).toThrow();
    fireEvent.click(getByText('Jun 22, 2026').closest('button')!);
    expect(getByText('sheet-open-a1')).toBeTruthy();
    expect(h.sheetProps).toMatchObject({
      appointment: { id: 'a1', updatedAt: 'v-1', status: 'scheduled' },
    });
  });
});
