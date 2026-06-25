// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestPayload, DigestResponse } from '../api/digest';

const h = vi.hoisted(() => ({
  data: null as DigestResponse | null,
  isLoading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useDigest', () => ({
  useDigest: () => ({
    data: h.data,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import EndOfDayDigest from '../../app/digest/end-of-day';
// eslint-disable-next-line import/first
import WeeklyDigest from '../../app/digest/index';

const basePayload: DigestPayload = {
  date: '2026-06-10',
  timezone: 'America/New_York',
  revenueCents: 125_00,
  grossRevenueCents: 130_00,
  refundsCents: 5_00,
  paymentsCount: 3,
  jobsCompletedCount: 2,
  tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
  pendingApprovals: { totalCount: 2, top: [] },
  overdueInvoicesCount: 4,
  unbilledJobs: [],
};

const digest: DigestResponse = {
  date: '2026-06-10',
  payload: basePayload,
  narrative: 'A solid day.',
  generatedAt: '2026-06-10T22:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Digest screens', () => {
  it('renders the narrative and key fields on the end-of-day screen', () => {
    h.data = digest;
    const { getByText } = render(createElement(EndOfDayDigest));
    expect(getByText('A solid day.')).toBeTruthy();
    expect(getByText('2026-06-10')).toBeTruthy();
    expect(getByText('$125.00')).toBeTruthy();
  });

  it('renders the weekly digest screen from the same snapshot', () => {
    h.data = digest;
    const { getByText } = render(createElement(WeeklyDigest));
    expect(getByText('A solid day.')).toBeTruthy();
    expect(getByText('2026-06-10')).toBeTruthy();
  });

  it('shows the empty state when no digest exists for the day', () => {
    h.error = 'No digest for this day';
    const { getByText } = render(createElement(EndOfDayDigest));
    expect(getByText('No digest for this day')).toBeTruthy();
  });
});
