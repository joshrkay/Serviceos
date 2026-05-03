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
});
