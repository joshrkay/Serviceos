import React, { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerPicker, CustomerOption } from '../CustomerPicker';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

function Harness() {
  const [v, setV] = useState<CustomerOption | null>(null);
  return <CustomerPicker value={v} onChange={setV} />;
}

describe('CustomerPicker (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('debounces typeahead by 300ms before calling the customers API', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'c-1', firstName: 'Alice' }] }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('customer-search');

    fireEvent.change(input, { target: { value: 'al' } });
    // Before 300ms: no fetch.
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();

    // After full 300ms: one fetch fires.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(
      '/api/customers?search=al&limit=10'
    );

    vi.useRealTimers();
  });

  it('renders results and selecting one updates the value', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'c-1', firstName: 'Alice', lastName: 'Wong' },
          { id: 'c-2', firstName: 'Bob' },
        ],
      }),
    } as unknown as Response);

    render(<Harness />);
    const input = screen.getByLabelText('customer-search');
    fireEvent.change(input, { target: { value: 'a' } });

    await waitFor(() => {
      expect(screen.getByTestId('customer-option-c-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('customer-option-c-1'));
    // Selected name should now appear in the input.
    expect((input as HTMLInputElement).value).toContain('Alice');
  });

  it('does not call the API when the search string is empty', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('renders the kit search input at the 44px tap target (U8c)', () => {
    render(<Harness />);
    expect(screen.getByLabelText('customer-search').className).toContain('min-h-11');
  });

  // #908 — CustomerPicker and JobPicker now share the EntityPicker base;
  // this closes a gap review found (JobPicker had an explicit empty state
  // and min-h-11 option buttons, CustomerPicker had neither).
  it('shows an explicit "No matching customers" empty state for a zero-result search', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    render(<Harness />);
    fireEvent.change(screen.getByLabelText('customer-search'), {
      target: { value: 'zzz-nothing' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('customer-picker-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customer-picker-empty').textContent).toBe('No matching customers');
  });

  it('meets the 44px tap-target contract on result options (CLAUDE.md)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'c-1', firstName: 'Alice' }] }),
    } as unknown as Response);

    render(<Harness />);
    fireEvent.change(screen.getByLabelText('customer-search'), { target: { value: 'al' } });

    await waitFor(() => {
      expect(screen.getByTestId('customer-option-c-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customer-option-c-1').className).toContain('min-h-11');
  });
});
