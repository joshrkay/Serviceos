import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CustomerRecordsPanel } from './CustomerRecordsPanel';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';

const mock = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function setup() {
  return render(
    <MemoryRouter>
      <CustomerRecordsPanel customerId="c1" />
    </MemoryRouter>,
  );
}

describe('CustomerRecordsPanel (US-069)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.mockImplementation((url: string) => {
      if (url.includes('/api/reports/customer-profit/')) {
        return Promise.resolve(jsonOk({ data: { revenueCents: 250000 } }));
      }
      if (url.startsWith('/api/jobs')) {
        return Promise.resolve(
          jsonOk([{ id: 'j1', summary: 'AC repair', status: 'completed' }]),
        );
      }
      if (url.startsWith('/api/estimates')) {
        return Promise.resolve(
          jsonOk([
            { id: 'e1', estimateNumber: 'EST-1', status: 'sent', totals: { totalCents: 50000 } },
          ]),
        );
      }
      if (url.startsWith('/api/invoices')) {
        return Promise.resolve(
          jsonOk([
            { id: 'i1', invoiceNumber: 'INV-1', status: 'paid', totals: { totalCents: 80000 } },
          ]),
        );
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
  });

  it('renders the total-revenue badge and the customer-scoped jobs by default', async () => {
    setup();
    expect(await screen.findByTestId('customer-total-revenue')).toHaveTextContent('$2,500.00');
    expect(await screen.findByText('AC repair')).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith('/api/jobs?customerId=c1');
  });

  it('switches to the Invoices tab and renders the customer-scoped invoice', async () => {
    setup();
    await screen.findByText('AC repair');
    fireEvent.click(screen.getByRole('tab', { name: 'Invoices' }));
    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('$800.00')).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith('/api/invoices?customerId=c1');
  });

  it('switches to the Estimates tab and renders the customer-scoped estimate', async () => {
    setup();
    await screen.findByText('AC repair');
    fireEvent.click(screen.getByRole('tab', { name: 'Estimates' }));
    expect(await screen.findByText('EST-1')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith('/api/estimates?customerId=c1');
  });

  it('shows an empty state when the customer has no records', async () => {
    mock.mockImplementation((url: string) => {
      if (url.includes('customer-profit')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      return Promise.resolve(jsonOk([]));
    });
    setup();
    expect(await screen.findByText(/No jobs for this customer yet/)).toBeInTheDocument();
    // The revenue badge does not render when the rollup is unavailable.
    expect(screen.queryByTestId('customer-total-revenue')).not.toBeInTheDocument();
  });
});
