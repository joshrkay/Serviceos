/**
 * #908 — EntityPicker (the shared CustomerPicker/JobPicker base) aborts a
 * still-in-flight search when a newer one starts, so a slow, stale response
 * can never overwrite fresher results. Neither original picker guarded
 * against this; this is new behavior introduced by the extraction, pinned
 * here directly against the generic base (not through either wrapper).
 */
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityPicker } from '../EntityPicker';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

interface Item {
  id: string;
  label: string;
}

function Harness() {
  const [v, setV] = useState<Item | null>(null);
  return (
    <EntityPicker<Item>
      value={v}
      onChange={setV}
      debounceMs={0}
      buildSearchUrl={(search) => `/api/things?search=${encodeURIComponent(search)}`}
      getId={(i) => i.id}
      displayLabel={(i) => i.label}
      placeholder="Search things"
      requiredPlaceholder="Search things (required)"
      ariaLabel="thing-search"
      testIdPrefix="thing-picker"
      optionTestIdPrefix="thing-option"
      emptyStateLabel="No matching things"
    />
  );
}

/** A fetch whose promise only settles when its AbortSignal fires — it
 *  otherwise hangs forever, standing in for "a slow request that hasn't
 *  come back yet". */
function pendingUntilAborted(): Promise<Response> {
  return new Promise((_resolve, reject) => {
    // The real apiFetch call happens synchronously inside EntityPicker's
    // runSearch, so by the time the mock is invoked `init.signal` is the
    // controller EntityPicker just created for THIS call.
  });
}

describe('EntityPicker — stale-response race (#908)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('aborts the previous request when a newer search starts, so a slow stale response never lands', async () => {
    let firstCallAborted = false;

    vi.mocked(apiFetch).mockImplementationOnce((_url, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        firstCallAborted = true;
      });
      return pendingUntilAborted();
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'fresh-1', label: 'Fresh result' }] }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('thing-search');

    // First search: fires immediately (debounceMs=0) and never resolves.
    fireEvent.change(input, { target: { value: 'first' } });
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1));

    // Second search: EntityPicker must abort the first controller before
    // issuing this one.
    fireEvent.change(input, { target: { value: 'second' } });

    await waitFor(() => {
      expect(screen.getByTestId('thing-option-fresh-1')).toBeInTheDocument();
    });
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe('/api/things?search=second');
    expect(firstCallAborted).toBe(true);
  });
});
