// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agreement } from '../api/agreements';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  data: [] as Agreement[],
  endpoint: null as string | null,
  refetch: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push, back: vi.fn() }) }));
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: { timezone: 'UTC' } }) }));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string) => {
    h.endpoint = endpoint;
    return { data: h.data, total: h.data.length, isLoading: false, error: null, refetch: h.refetch };
  },
}));

// eslint-disable-next-line import/first
import Agreements from '../../app/agreements';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.endpoint = null;
});

afterEach(() => cleanup());

describe('Agreements list screen', () => {
  it('lists agreements with recurrence, price, status and next run', () => {
    h.data = [
      {
        id: 'agr-1',
        customerId: 'c1',
        name: 'Quarterly HVAC tune-up',
        recurrenceRule: 'FREQ=QUARTERLY',
        priceCents: 15000,
        autoGenerateInvoice: true,
        autoGenerateJob: true,
        nextRunAt: '2026-08-01T00:00:00Z',
        status: 'active',
        startsOn: '2026-01-01',
      },
    ];
    const { getByText } = render(createElement(Agreements));
    expect(h.endpoint).toBe('/api/agreements');
    expect(getByText('Quarterly HVAC tune-up')).toBeTruthy();
    expect(getByText(/Quarterly · \$150\.00 · Active · next/)).toBeTruthy();
  });

  it('navigates to the detail on row press', () => {
    h.data = [
      {
        id: 'agr-9',
        customerId: 'c1',
        name: 'Monthly plan',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 5000,
        autoGenerateInvoice: true,
        autoGenerateJob: false,
        nextRunAt: '2026-08-01T00:00:00Z',
        status: 'active',
        startsOn: '2026-01-01',
      },
    ];
    const { getByText } = render(createElement(Agreements));
    fireEvent.click(getByText('Monthly plan').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/agreements/agr-9');
  });
});
