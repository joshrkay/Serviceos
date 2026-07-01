import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewJobFlow, deriveScheduledStartISO } from './NewJobFlow';

const listQueryStable = {
  data: [
    {
      id: 'cust-roberto',
      displayName: 'Roberto Rodriguez',
      primaryPhone: '512-555-0100',
      locations: [
        {
          id: 'loc-1',
          street1: '412 Maple Drive, Austin TX',
          city: '',
          state: '',
          postalCode: '',
          isPrimary: true,
          serviceTypes: ['HVAC'],
        },
      ],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setFilters: vi.fn(),
};

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: () => listQueryStable,
}));

vi.mock('../../hooks/useTechnicianRoster', () => ({
  useTechnicianRoster: () => ({ technicians: [], isLoading: false, error: null }),
}));

vi.mock('../../hooks/useMutation', () => ({
  useMutation: () => ({ mutate: vi.fn(), isLoading: false, error: null }),
}));

function renderFlow() {
  return render(
    <NewJobFlow
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />
  );
}

describe('NewJobFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows creating and selecting a new customer from the customer step', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Taylor Rivera');
    await user.type(screen.getByPlaceholderText('Address *'), '99 Test Lane, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    expect(await screen.findByText('Taylor Rivera')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /next: job details/i })).toBeEnabled();
  });

  it('marks an existing customer address as old when a new customer is created with the same address', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Jordan Lopez');
    await user.type(screen.getByPlaceholderText('Address *'), '412 Maple Drive, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    const existingCustomerRow = (await screen.findByText('Roberto Rodriguez')).closest('button');
    expect(existingCustomerRow).not.toBeNull();
    expect(await within(existingCustomerRow as HTMLElement).findByText('old address')).toBeInTheDocument();
  });

  it('renders the customer step on Path A tokens with kit inputs — no raw palette leaks', async () => {
    const user = userEvent.setup();
    const { container } = renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    // The migrated new-customer fields are kit inputs with a ≥44px target.
    expect(screen.getByPlaceholderText('Full name *')).toHaveClass('min-h-11');
    expect(screen.getByPlaceholderText('Address *')).toHaveClass('min-h-11');

    // No raw Tailwind palette classes survive the Path A migration.
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});

describe('deriveScheduledStartISO — NewJobFlow schedule draft → ISO', () => {
  // A fixed "now" (local time) keeps Today/Tomorrow deterministic.
  const NOW = new Date(2026, 6, 1, 9, 30); // 2026-07-01 09:30 local

  it('resolves Today + a chosen time to that local instant', () => {
    const iso = deriveScheduledStartISO('Today', '3:00 PM', NOW);
    const d = new Date(iso!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(0);
  });

  it('resolves Tomorrow to the next day', () => {
    const d = new Date(deriveScheduledStartISO('Tomorrow', '8:00 AM', NOW)!);
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(8);
  });

  it('resolves an explicit YYYY-MM-DD custom date', () => {
    const d = new Date(deriveScheduledStartISO('2026-09-15', '2:00 PM', NOW)!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(14);
  });

  it('defaults a missing time to 8:00 AM', () => {
    const d = new Date(deriveScheduledStartISO('Today', '', NOW)!);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('does NOT book unresolvable inputs (placeholder chips, empty, Custom)', () => {
    expect(deriveScheduledStartISO('Tue Mar 11', '3:00 PM', NOW)).toBeUndefined();
    expect(deriveScheduledStartISO('', '3:00 PM', NOW)).toBeUndefined();
    expect(deriveScheduledStartISO('Custom', '3:00 PM', NOW)).toBeUndefined();
  });
});
