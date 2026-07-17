import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('../jobs/NewJobFlow', () => ({ NewJobFlow: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { CustomersPage } from './CustomersPage';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { track } from '../../lib/analytics';

const trackMock = vi.mocked(track);

const listResult = {
  data: [
    { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith', primaryPhone: '5125550001', tags: [], locations: [] },
    { id: 'c2', displayName: 'Bob Jones', firstName: 'Bob', lastName: 'Jones', primaryPhone: '5125550002', tags: [], locations: [] },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setFilters: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  trackMock.mockClear();
  vi.mocked(useListQuery).mockReturnValue(listResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <CustomersPage />
    </MemoryRouter>,
  );
}

describe('CustomersPage — customer_search_run', () => {
  it('fires once (debounced) with has_query + result_count, never the query text', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search name, address, phone…');

    fireEvent.change(input, { target: { value: 'Alice Smith 512-555' } });
    // Before the debounce window elapses, nothing has fired.
    expect(trackMock.mock.calls.filter((c) => c[0] === 'customer_search_run')).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const calls = trackMock.mock.calls.filter((c) => c[0] === 'customer_search_run');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ has_query: true, result_count: 2 });
    // PII guardrail: the typed query must never leave the device.
    expect(JSON.stringify(calls[0][1])).not.toContain('Alice');
    expect(JSON.stringify(calls[0][1])).not.toContain('512');
  });

  it('does not fire for an empty search', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search name, address, phone…');

    fireEvent.change(input, { target: { value: '   ' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(trackMock.mock.calls.filter((c) => c[0] === 'customer_search_run')).toHaveLength(0);
  });
});
