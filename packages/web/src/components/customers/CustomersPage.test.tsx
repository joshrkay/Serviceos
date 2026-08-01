import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CustomersPage } from './CustomersPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('../jobs/NewJobFlow', () => ({ NewJobFlow: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { toast } from 'sonner';

const mockCustomers = [
  {
    id: 'c1',
    displayName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    primaryPhone: '5125550001',
    email: 'alice@example.com',
    openJobs: 2,
    tags: [],
    locations: [{ id: 'l1', street1: '123 Main St', serviceTypes: ['HVAC'] }],
  },
  {
    id: 'c2',
    displayName: 'Bob Jones',
    firstName: 'Bob',
    lastName: 'Jones',
    primaryPhone: '5125550002',
    email: 'bob@example.com',
    openJobs: 0,
    tags: ['VIP'],
    locations: [{ id: 'l2', street1: '456 Oak Ave', serviceTypes: ['Plumbing'] }],
  },
];

const defaultListResult = {
  data: mockCustomers,
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
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <CustomersPage />
    </MemoryRouter>
  );
}

describe('CustomersPage', () => {
  it('renders customer list', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('shows customer count in header', () => {
    renderPage();
    expect(screen.getByText(/2 customers/)).toBeInTheDocument();
  });

  it('shows VIP badge', () => {
    renderPage();
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('shows open jobs badge', () => {
    renderPage();
    expect(screen.getByText('2 open')).toBeInTheDocument();
  });

  it('calls setSearch when user types in search input', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search name, address, phone…');
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(defaultListResult.setSearch).toHaveBeenCalledWith('alice');
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    renderPage();
    // loading spinner should be present (no customer names)
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry button', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load customers')).toBeInTheDocument();
    const retry = screen.getByText('Retry');
    fireEvent.click(retry);
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('shows empty state when no customers match', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No customers found')).toBeInTheDocument();
  });

  it('shows Add customer button', () => {
    renderPage();
    expect(screen.getByText('Add customer')).toBeInTheDocument();
  });

  it('uses /api/customers endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/customers');
  });

  it('shows the primary phone in each row (4.1)', () => {
    renderPage();
    expect(screen.getByText('5125550001')).toBeInTheDocument();
    expect(screen.getByText('5125550002')).toBeInTheDocument();
  });

  it('renders tag filter chips and narrows the list by tag (4.8)', () => {
    renderPage();
    const tagBar = screen.getByTestId('tag-filters');
    expect(tagBar).toBeInTheDocument();
    // Both customers visible before filtering.
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    // Click the #VIP tag chip → only Bob (who carries 'VIP') remains.
    fireEvent.click(screen.getByText('#VIP'));
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('hides the tag filter bar when no customer has tags', () => {
    vi.mocked(useListQuery).mockReturnValue({
      ...defaultListResult,
      data: [{ ...mockCustomers[0], tags: [] }],
    });
    renderPage();
    expect(screen.queryByTestId('tag-filters')).not.toBeInTheDocument();
  });

  it('flags a fuzzy name match as a possible duplicate in the Add sheet (4.4)', () => {
    renderPage();
    fireEvent.click(screen.getByText('Add customer')); // open the Add sheet
    const nameInput = screen.getByPlaceholderText('Full name *');
    fireEvent.change(nameInput, { target: { value: 'Alice Smyth' } });
    // 'Alice Smyth' is a close trigram match for the existing 'Alice Smith'.
    expect(screen.getByText('Possible duplicate')).toBeInTheDocument();
    expect(screen.getByText(/Similar name matches an existing customer/)).toBeInTheDocument();
  });

  it('does not flag an unrelated name in the Add sheet', () => {
    renderPage();
    fireEvent.click(screen.getByText('Add customer'));
    fireEvent.change(screen.getByPlaceholderText('Full name *'), {
      target: { value: 'Zachary Quinto' },
    });
    expect(screen.queryByText('Possible duplicate')).not.toBeInTheDocument();
    expect(screen.queryByText('Already in your system')).not.toBeInTheDocument();
  });

  it('offers an acquisition-source selector when adding a customer', () => {
    renderPage();
    fireEvent.click(screen.getByText('Add customer')); // open the Add sheet
    const select = screen.getByLabelText('How did you hear about us?') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Referral' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Repeat client' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'referral' } });
    expect(select.value).toBe('referral');
  });

  // U7a — Path A class contract: the cluster renders on brand tokens only, and
  // the service-type chip collapses to the calm neutral token (the per-type
  // hue distinction is carried by the emoji + label, not colour).
  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = renderPage();
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });

  it('uses the neutral service-type chip token (not a per-type hue)', () => {
    const { container } = renderPage();
    // Row chips render "<emoji> <ServiceType>"; the filter pills render the
    // emoji in a child span with no trailing space, so this finds the chip.
    const chip = Array.from(container.querySelectorAll('span')).find((el) =>
      /^(❄️|🔧|🎨)\s/.test(el.textContent ?? ''),
    );
    expect(chip).toBeDefined();
    expect(chip?.className).toContain('bg-secondary');
    expect(chip?.className).not.toMatch(/(bg|text|border)-(blue|green|violet)-\d{2,3}/);
  });
});

describe('AddCustomerSheet — save guard + retry (duplicate-customer fix)', () => {
  const createCustomerMock = vi.fn();
  const createLocationMock = vi.fn();

  beforeEach(() => {
    createCustomerMock.mockReset();
    createLocationMock.mockReset();
    vi.mocked(toast.error).mockClear();
    defaultListResult.refetch.mockClear();
    vi.mocked(useMutation).mockImplementation((_method, path) => ({
      mutate: path === '/api/customers' ? createCustomerMock : createLocationMock,
      isLoading: false,
      error: null,
    }));
  });

  /** Opens the Add sheet and fills both steps up to the save button. */
  function fillSheetToSave() {
    renderPage();
    fireEvent.click(screen.getByText('Add customer'));
    fireEvent.change(screen.getByPlaceholderText('Full name *'), {
      target: { value: 'Charlie Brown' },
    });
    fireEvent.click(screen.getByText('Next: Add location →'));
    fireEvent.change(screen.getByPlaceholderText('Street address *'), {
      target: { value: '12 Elm St, Austin, TX 78701' },
    });
    // The sheet's service chip is a BUTTON; the list rows render the same
    // "<emoji> <type>" text in SPAN chips, so pick by tag.
    const svcBtn = screen
      .getAllByText('❄️ HVAC')
      .find((el) => el.tagName === 'BUTTON')!;
    fireEvent.click(svcBtn);
    // Header button and the sheet's save button share the label; the sheet
    // is portalled last in the DOM.
    return screen.getAllByText('Add customer').at(-1)! as HTMLButtonElement;
  }

  it('double-tap on Add customer POSTs exactly one customer', async () => {
    let resolveCustomer!: (v: unknown) => void;
    createCustomerMock.mockReturnValue(
      new Promise((res) => {
        resolveCustomer = res;
      }),
    );
    createLocationMock.mockResolvedValue({ id: 'loc-1' });

    const saveBtn = fillSheetToSave();
    fireEvent.click(saveBtn);
    // Button is disabled (pending state) after the first tap…
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveTextContent('Adding…');
    // …and a second tap while in flight must not create a second customer.
    fireEvent.click(saveBtn);
    expect(createCustomerMock).toHaveBeenCalledTimes(1);

    resolveCustomer({ id: 'c9' });
    await screen.findByText('Charlie Brown added');
    expect(createCustomerMock).toHaveBeenCalledTimes(1);
    expect(createLocationMock).toHaveBeenCalledTimes(1);
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('createLocation failure surfaces a toast; retry POSTs only the location with the cached customer id', async () => {
    createCustomerMock.mockResolvedValue({ id: 'c9' });
    createLocationMock
      .mockRejectedValueOnce(new Error('HTTP 400'))
      .mockResolvedValueOnce({ id: 'loc-1' });

    const saveBtn = fillSheetToSave();
    fireEvent.click(saveBtn);

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('HTTP 400'));
    expect(createCustomerMock).toHaveBeenCalledTimes(1);
    expect(createLocationMock).toHaveBeenCalledTimes(1);
    // Still on the location step — the sheet did not advance on failure.
    expect(screen.queryByText('Charlie Brown added')).not.toBeInTheDocument();

    // Retry: reuses the cached customer id, no second POST /api/customers.
    fireEvent.click(screen.getAllByText('Add customer').at(-1)!);
    await screen.findByText('Charlie Brown added');
    expect(createCustomerMock).toHaveBeenCalledTimes(1);
    expect(createLocationMock).toHaveBeenCalledTimes(2);
    expect(createLocationMock.mock.calls[1][0]).toMatchObject({ customerId: 'c9' });
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });
});
