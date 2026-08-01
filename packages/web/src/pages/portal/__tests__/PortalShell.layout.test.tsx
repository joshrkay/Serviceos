/**
 * WS6 (QUALITY-2026-07-12) — the portal tab nav is the customer's primary
 * navigation on a phone. Every tab must meet the 44px glove target (min-h-11).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PortalShell } from '../PortalShell';
import { portalApi, type PortalCustomer } from '../../../api/portal';

const customer: PortalCustomer = {
  id: 'cust-1',
  displayName: 'Pat Customer',
  firstName: 'Pat',
  lastName: 'Customer',
  email: 'pat@example.com',
  preferredChannel: 'email',
  timezone: 'America/New_York',
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('PortalShell — WS6 nav tap targets', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('every nav tab is a 44px tap target (min-h-11)', async () => {
    vi.spyOn(portalApi, 'customer').mockResolvedValue(customer);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/invoices')) return Promise.resolve(jsonResponse({ invoices: [] }));
      if (url.includes('/estimates')) return Promise.resolve(jsonResponse({ estimates: [] }));
      if (url.includes('/appointments')) return Promise.resolve(jsonResponse({ appointments: [] }));
      return Promise.resolve(jsonResponse({}));
    }));

    render(
      <MemoryRouter initialEntries={['/p/tok-1']}>
        <Routes>
          <Route path="/p/:token" element={<PortalShell />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => screen.getByText(/Welcome, Pat/));

    for (const label of ['Overview', 'Estimates', 'Invoices', 'Jobs', 'Agreements', 'Book appointment', 'Payment methods', 'Request service']) {
      const tab = screen.getByRole('button', { name: label });
      expect(tab.className).toContain('min-h-11');
    }
  });
});
