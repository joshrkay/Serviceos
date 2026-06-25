import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { PortalDashboard } from '../PortalDashboard';
import type { PortalCustomer } from '../../../api/portal';
import { expectTenantNeutral } from '../../../components/customer/tenantNeutralContract';

/**
 * Tenant-neutral class contract for the authenticated portal dashboard (U13g).
 * Populated so the amount-due (destructive) and summary (success) tints render.
 */
const customer: PortalCustomer = {
  id: 'cust-1',
  displayName: 'Pat Customer',
  firstName: 'Pat',
  lastName: 'Customer',
  email: 'pat@example.com',
  preferredChannel: 'email',
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('PortalDashboard — tenant-neutral class contract', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('renders no raw palette and no ServiceOS brand blue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/invoices')) {
        return Promise.resolve(jsonResponse({
          invoices: [{
            id: 'inv-1', invoiceNumber: 'INV-2000', status: 'open',
            totalCents: 10000, amountPaidCents: 0, amountDueCents: 10000,
            issuedAt: null, dueDate: null, createdAt: new Date().toISOString(), payNowUrl: null,
          }],
        }));
      }
      if (url.includes('/estimates')) {
        return Promise.resolve(jsonResponse({
          estimates: [{
            id: 'est-1', estimateNumber: 'EST-1', status: 'sent', totalCents: 5000,
            createdAt: new Date().toISOString(), validUntil: null, publicViewToken: null,
          }],
        }));
      }
      if (url.includes('/appointments')) return Promise.resolve(jsonResponse({ appointments: [] }));
      return Promise.resolve(jsonResponse({}));
    }));

    const { container } = render(<PortalDashboard token="tok-1" customer={customer} />);
    await waitFor(() => screen.getByText(/Amount due/));
    expectTenantNeutral(container.innerHTML);
  });
});
