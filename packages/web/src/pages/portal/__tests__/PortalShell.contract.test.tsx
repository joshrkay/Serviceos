import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PortalShell } from '../PortalShell';
import { portalApi, type PortalCustomer } from '../../../api/portal';
import { expectTenantNeutral } from '../../../components/customer/tenantNeutralContract';

/**
 * Tenant-neutral class contract for the portal shell chrome (U13g) — the
 * header, tab nav, and active-tab ink underline. PortalShell has no other
 * test, so this guard is its only coverage.
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

describe('PortalShell — tenant-neutral class contract', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders the shell chrome with no raw palette and no ServiceOS brand blue', async () => {
    vi.spyOn(portalApi, 'customer').mockResolvedValue(customer);
    // The default dashboard tab fetches a snapshot — return empty collections
    // (not bare {}) so it settles cleanly instead of throwing on undefined.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/invoices')) return Promise.resolve(jsonResponse({ invoices: [] }));
      if (url.includes('/estimates')) return Promise.resolve(jsonResponse({ estimates: [] }));
      if (url.includes('/appointments')) return Promise.resolve(jsonResponse({ appointments: [] }));
      return Promise.resolve(jsonResponse({}));
    }));

    const { container } = render(
      <MemoryRouter initialEntries={['/p/tok-1']}>
        <Routes>
          <Route path="/p/:token" element={<PortalShell />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => screen.getByText(/Welcome, Pat/));
    expectTenantNeutral(container.innerHTML);
  });
});
