import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CustomerDetail } from './CustomerDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('../../components/customers/CommunicationTimeline', () => ({
  CommunicationTimeline: () => <div>Timeline</div>,
}));
// U1/U2 panels are self-contained (they fetch their own data); mock them here
// so this suite stays focused on CustomerDetail and its locations fetch order.
vi.mock('../../components/customers/ContactsPanel', () => ({
  ContactsPanel: () => <div>ContactsPanel</div>,
}));
vi.mock('../../components/customers/TagsPanel', () => ({
  TagsPanel: () => <div>TagsPanel</div>,
}));
vi.mock('../../components/customers/CustomFieldsPanel', () => ({
  CustomFieldsPanel: () => <div>CustomFieldsPanel</div>,
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { apiFetch } from '../../utils/api-fetch';

function renderCustomerDetail() {
  return render(
    <MemoryRouter>
      <CustomerDetail customerId="1" />
    </MemoryRouter>
  );
}

describe('CustomerDetail', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).startsWith('/api/locations')) {
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], total: 0 }),
      } as unknown as Response;
    });
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', displayName: 'Alice', firstName: 'Alice', lastName: 'Smith',
        companyName: 'Acme', email: 'alice@test.com', primaryPhone: '555-0100',
        secondaryPhone: '555-0200', preferredChannel: 'email', isArchived: false,
        communicationNotes: 'Prefers afternoon appointments. Gate code is 1234.',
        originatingLeadId: 'lead-1',
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders customer details', async () => {
    renderCustomerDetail();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Contact Information')).toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/locations?customerId=1');
    });
  });

  it('surfaces persisted customer notes without drilling', async () => {
    renderCustomerDetail();

    expect(screen.getByText('Customer Notes')).toBeInTheDocument();
    expect(screen.getAllByText('Prefers afternoon appointments. Gate code is 1234.').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/locations?customerId=1');
    });
  });

  it('shows the originating lead link in activity', async () => {
    renderCustomerDetail();

    expect(screen.getByText(/Converted from lead/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'lead-1' })).toHaveAttribute('href', '/leads/lead-1');
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/locations?customerId=1');
    });
  });

  it('sends an explicit empty string when clearing customer notes', async () => {
    renderCustomerDetail();

    fireEvent.change(screen.getByLabelText('Customer notes'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      const putCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.communicationNotes).toBe('');
    });
  });

  it('lists service locations and labels the primary address', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'loc-1',
          label: 'Home',
          street1: '100 Main St',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          isPrimary: true,
        },
        {
          id: 'loc-2',
          label: 'Rental',
          street1: '200 Rental Rd',
          city: 'Austin',
          state: 'TX',
          postalCode: '78702',
          isPrimary: false,
        },
      ],
    } as unknown as Response);

    renderCustomerDetail();

    await waitFor(() => {
      expect(screen.getByText('Service Locations')).toBeInTheDocument();
      expect(screen.getByText(/100 Main St/)).toBeInTheDocument();
      expect(screen.getByText(/200 Rental Rd/)).toBeInTheDocument();
      expect(screen.getByText('Primary')).toBeInTheDocument();
    });
  });

  it('marks a service location as the billing address (U3)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/locations?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'loc-1',
              label: 'Home',
              street1: '100 Main St',
              city: 'Austin',
              state: 'TX',
              postalCode: '78701',
              isPrimary: true,
              addressType: 'service',
            },
          ],
        } as unknown as Response;
      }
      if (String(url) === '/api/locations/loc-1' && (init as RequestInit)?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [], total: 0 }) } as unknown as Response;
    });

    renderCustomerDetail();

    const billingBtn = await screen.findByRole('button', { name: 'Set as billing' });
    fireEvent.click(billingBtn);

    await waitFor(() => {
      const putCall = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (call) =>
            String(call[0]) === '/api/locations/loc-1' &&
            (call[1] as RequestInit | undefined)?.method === 'PUT',
        );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.addressType).toBe('billing');
    });
  });

  it('shows loading state when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    renderCustomerDetail();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    renderCustomerDetail();
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
