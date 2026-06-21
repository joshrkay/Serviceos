// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Appointment {
  id: string;
  scheduledStart?: string;
  status?: string;
  appointmentType?: string;
}

const h = vi.hoisted(() => ({
  calledWith: [] as unknown[],
  data: [] as Appointment[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
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

// eslint-disable-next-line import/first
import Schedule from '../../app/schedule';

beforeEach(() => {
  vi.clearAllMocks();
  h.calledWith = [];
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Schedule screen', () => {
  it('requests appointments with paginated=true (avoids the legacy 400)', () => {
    render(createElement(Schedule));
    expect(h.calledWith[0]).toBe('/api/appointments');
    expect(h.calledWith[1]).toEqual({ params: { paginated: 'true' } });
  });

  it('renders an appointment row with its date and title-cased type/status', () => {
    h.data = [
      { id: 'a1', scheduledStart: '2026-06-22T12:00:00Z', status: 'scheduled', appointmentType: 'repair' },
    ];
    const { getByText } = render(createElement(Schedule));
    expect(getByText('Repair · Scheduled')).toBeTruthy();
  });

  it('shows the empty state when nothing is scheduled', () => {
    const { getByText } = render(createElement(Schedule));
    expect(getByText('Nothing scheduled.')).toBeTruthy();
  });
});
