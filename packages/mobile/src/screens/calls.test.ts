// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionDetail, InteractionSummary } from '../api/interactions';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  refetch: vi.fn(),
  api: vi.fn(),
  getInteraction: vi.fn(),
  data: [] as InteractionSummary[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: h.back, replace: vi.fn() }),
  useLocalSearchParams: () => ({ id: 'call-1' }),
}));
vi.mock('../hooks/useInteractionsList', () => ({
  useInteractionsList: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../api/interactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/interactions')>();
  return {
    ...actual,
    getInteraction: (...args: unknown[]) => h.getInteraction(...args),
  };
});

// eslint-disable-next-line import/first
import CallDetail from '../../app/calls/[id]';
// eslint-disable-next-line import/first
import Calls from '../../app/calls';

const summary = (over: Partial<InteractionSummary> = {}): InteractionSummary => ({
  id: 'call-1',
  channel: 'voice_inbound',
  outcome: 'booked',
  callSid: 'CA123',
  startedAt: '2026-06-20T10:00:00Z',
  endedAt: '2026-06-20T10:05:00Z',
  durationSeconds: 300,
  customer: { id: 'cust-1', displayName: 'Acme Plumbing', address: null },
  excerpt: 'Booked a service visit',
  transcriptTurnCount: 4,
  ...over,
});

const detail = (over: Partial<InteractionDetail> = {}): InteractionDetail => ({
  ...summary(),
  transcript: ['caller: My AC is out', 'agent: I can help with that'],
  endedReason: 'completed',
  costCents: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
  h.getInteraction.mockResolvedValue(detail());
});

afterEach(() => cleanup());

describe('Calls list', () => {
  it('renders a customer row with a >=44px tap target', () => {
    h.data = [summary()];
    const { getByText } = render(createElement(Calls));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText(/Booked a service visit/)).toBeTruthy();
    const row = getByText('Acme Plumbing').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(row);
    expect(h.push).toHaveBeenCalledWith('/calls/call-1');
  });

  it('falls back to the channel label when there is no customer', () => {
    h.data = [summary({ customer: null, excerpt: 'Left voicemail' })];
    const { getByText } = render(createElement(Calls));
    expect(getByText('Inbound call')).toBeTruthy();
    const row = getByText('Inbound call').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
  });

  it('shows the empty state when there are no calls', () => {
    const { getByText } = render(createElement(Calls));
    expect(getByText('No calls logged yet.')).toBeTruthy();
  });
});

describe('Call detail', () => {
  it('shows transcript text when loaded', async () => {
    const { getByText } = render(createElement(CallDetail));
    await waitFor(() => expect(h.getInteraction).toHaveBeenCalledWith(h.api, 'call-1'));
    await waitFor(() => expect(getByText('My AC is out')).toBeTruthy());
    expect(getByText('I can help with that')).toBeTruthy();
  });
});
