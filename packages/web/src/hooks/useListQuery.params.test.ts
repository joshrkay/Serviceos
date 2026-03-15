/**
 * Layer 2 — Query Parameter Tests
 *
 * Proves that UI state changes (setFilters, setSearch, setPage) produce
 * the correct URL query parameters when the hook calls fetch. This is the
 * missing proof between "the component calls setFilters" and "the API
 * receives the right query string."
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useListQuery } from './useListQuery';
import { useDetailQuery } from './useDetailQuery';
import { useMutation } from './useMutation';

function mockFetch(body: unknown = []) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 })
  );
}

function getLastUrl(spy: ReturnType<typeof mockFetch>): string {
  const calls = spy.mock.calls;
  return String(calls[calls.length - 1][0]);
}

describe('useListQuery — URL parameter generation', () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from the correct endpoint on mount with page=1 and pageSize=25', async () => {
    renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const url = getLastUrl(fetchSpy);
    expect(url).toContain('/api/jobs');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=25');
  });

  it('encodes a single filter as a query param', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setFilters({ status: 'in_progress' });
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).toContain('status=in_progress');
    });
  });

  it('encodes multiple filters simultaneously', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setFilters({ status: 'scheduled', priority: 'high' });
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).toContain('status=scheduled');
      expect(url).toContain('priority=high');
    });
  });

  it('clears previous filters when setFilters({}) is called', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setFilters({ status: 'completed' });
    });
    await waitFor(() => expect(getLastUrl(fetchSpy)).toContain('status=completed'));

    act(() => {
      result.current.setFilters({});
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).not.toContain('status=');
    });
  });

  it('encodes search as a query param', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setSearch('alice');
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).toContain('search=alice');
    });
  });

  it('omits search param when search is cleared', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setSearch('bob');
    });
    await waitFor(() => expect(getLastUrl(fetchSpy)).toContain('search=bob'));

    act(() => {
      result.current.setSearch('');
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).not.toContain('search=');
    });
  });

  it('encodes page number as a query param', async () => {
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setPage(3);
    });

    await waitFor(() => {
      const url = getLastUrl(fetchSpy);
      expect(url).toContain('page=3');
    });
  });

  it('combines filters and search in a single request', async () => {
    const { result } = renderHook(() => useListQuery('/api/estimates'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    act(() => {
      result.current.setFilters({ status: 'accepted' });
      result.current.setSearch('roof');
    });

    // Wait for the combined fetch to happen
    await waitFor(() => {
      const calls = fetchSpy.mock.calls;
      const hasAll = calls.some((call) => {
        const url = String(call[0]);
        return url.includes('status=accepted') && url.includes('search=roof');
      });
      expect(hasAll).toBe(true);
    });
  });

  it('uses a different endpoint for estimates vs jobs', async () => {
    renderHook(() => useListQuery('/api/estimates'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(getLastUrl(fetchSpy)).toContain('/api/estimates');
    expect(getLastUrl(fetchSpy)).not.toContain('/api/jobs');
  });
});

describe('useDetailQuery — URL construction', () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch({ id: 'job-1', summary: 'Test' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the exact URL endpoint/id', async () => {
    renderHook(() => useDetailQuery('/api/jobs', 'job-abc-123'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(getLastUrl(fetchSpy)).toBe('/api/jobs/job-abc-123');
  });

  it('skips fetch entirely when id is null', async () => {
    renderHook(() => useDetailQuery('/api/jobs', null));
    // Give it time to mount
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-fetches when id changes', async () => {
    const { rerender } = renderHook(
      ({ id }) => useDetailQuery('/api/invoices', id),
      { initialProps: { id: 'inv-1' } }
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(getLastUrl(fetchSpy)).toBe('/api/invoices/inv-1');

    rerender({ id: 'inv-2' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(getLastUrl(fetchSpy)).toBe('/api/invoices/inv-2');
  });
});

describe('useMutation — HTTP method and body', () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch({ id: 'job-1', status: 'scheduled' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends POST with JSON body to the correct path', async () => {
    const { result } = renderHook(() =>
      useMutation('POST', '/api/jobs/job-1/transition')
    );

    await act(async () => {
      await result.current.mutate({ status: 'scheduled' });
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/jobs/job-1/transition',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'scheduled' }),
      })
    );
  });

  it('sends PUT with JSON body', async () => {
    const { result } = renderHook(() =>
      useMutation('PUT', '/api/jobs/job-1')
    );

    await act(async () => {
      await result.current.mutate({ summary: 'Updated summary' });
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/jobs/job-1',
      expect.objectContaining({ method: 'PUT' })
    );
  });
});
