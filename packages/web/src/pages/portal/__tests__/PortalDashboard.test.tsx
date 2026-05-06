import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalDashboard } from '../PortalDashboard';
import type { PortalCustomer } from '../../../api/portal';

const customer: PortalCustomer = {
  id: 'cust-1',
  displayName: 'Pat Customer',
  firstName: 'Pat',
  lastName: 'Customer',
  email: 'pat@example.com',
  preferredChannel: 'email',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('Portal — PortalDashboard (P10-001)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders amount-due, open-estimate, and next-appointment summary', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/invoices')) {
        return Promise.resolve(
          jsonResponse({
            invoices: [
              {
                id: 'inv-1',
                invoiceNumber: 'INV-2000',
                status: 'open',
                totalCents: 10000,
                amountPaidCents: 0,
                amountDueCents: 10000,
                issuedAt: null,
                dueDate: null,
                createdAt: new Date().toISOString(),
                payNowUrl: null,
              },
            ],
          }),
        );
      }
      if (url.includes('/estimates')) {
        return Promise.resolve(
          jsonResponse({
            estimates: [
              {
                id: 'est-1',
                estimateNumber: 'EST-1',
                status: 'sent',
                totalCents: 5000,
                createdAt: new Date().toISOString(),
                validUntil: null,
                publicViewToken: null,
              },
            ],
          }),
        );
      }
      if (url.includes('/appointments')) {
        return Promise.resolve(jsonResponse({ appointments: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalDashboard token="tok-1" customer={customer} />);

    await waitFor(() => {
      expect(screen.getByText(/Amount due/)).toBeInTheDocument();
    });
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText(/Open estimates/)).toBeInTheDocument();
    expect(screen.getByText(/Next appointment/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing scheduled/)).toBeInTheDocument();
  });

  it('shows an error state when the API fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
      statusText: 'Server Error',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalDashboard token="tok-1" customer={customer} />);
    await waitFor(() => {
      expect(screen.getByText(/Portal request failed/)).toBeInTheDocument();
    });
  });
});
