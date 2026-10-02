/**
 * #1563 — Settings → Phone: the business number, its state, and "change
 * number". Public seam: the page, with GET /api/onboarding/phone and the
 * picker's POSTs answered by a mocked client.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));
// #1564 — the texting-registration panel on this page uses the shared apiFetch.
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { PhoneSettingsPage } from './PhoneSettingsPage';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const ACTIVE = {
  state: 'active',
  phoneNumber: '+15125550123',
  pendingNumber: null,
  changingTo: null,
  changeError: null,
  lastError: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <PhoneSettingsPage />
    </MemoryRouter>,
  );
}

describe('PhoneSettingsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows the business number and that it is active', async () => {
    apiFetchMock.mockResolvedValue(json(ACTIVE));
    renderPage();
    expect(await screen.findByText('(512) 555-0123')).toBeInTheDocument();
    expect(screen.getByText(/^active$/i)).toBeInTheDocument();
  });

  it('change number: reveals the picker and switches via /phone/change', async () => {
    let line: Record<string, unknown> = ACTIVE;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/onboarding/phone') return json(line);
      if (path === '/api/onboarding/phone/available') {
        return json({ numbers: [{ phoneNumber: '+17375550111', locality: 'Austin', region: 'TX' }] });
      }
      if (path === '/api/onboarding/phone/change') {
        line = { ...ACTIVE, changingTo: '+17375550111' };
        return json({ ok: true, enqueued: true, phoneNumber: '+17375550111' });
      }
      return json({}, 404);
    });
    renderPage();

    const change = await screen.findByRole('button', { name: /change number/i });
    expect(change.className).toContain('min-h-11');
    fireEvent.click(change);

    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '737' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /\(737\) 555-0111/ }));
    fireEvent.click(screen.getByRole('button', { name: /switch to \(737\) 555-0111/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/onboarding/phone/change',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ phoneNumber: '+17375550111' }) }),
      ),
    );
    expect(await screen.findByText(/switching to \(737\) 555-0111/i)).toBeInTheDocument();
  });

  it('tells the owner when a change did not happen and they kept their number', async () => {
    apiFetchMock.mockResolvedValue(
      json({ ...ACTIVE, changeError: '+17375550111 is no longer available, so we kept your current number. Pick another one.' }),
    );
    renderPage();
    expect(await screen.findByText(/kept your current number/i)).toBeInTheDocument();
  });

  it('awaiting a pick: the owner can pick their number from Settings too', async () => {
    apiFetchMock.mockResolvedValue(
      json({ ...ACTIVE, state: 'awaiting_pick', phoneNumber: null }),
    );
    renderPage();
    expect(await screen.findByLabelText('Area code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pick one for me/i }).className).toContain('min-h-11');
  });

  it('mobile class contract: single column, no fixed widths (no 320px overflow)', async () => {
    apiFetchMock.mockResolvedValue(json(ACTIVE));
    renderPage();
    const section = await screen.findByTestId('phone-settings');
    expect(section.className).toContain('min-w-0');
    expect(section.className).toContain('w-full');
    expect(section.className).not.toMatch(/\bw-\[\d+px\]/);
  });

  it('#1564 — shows the A2P 10DLC texting registration below the number', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/onboarding/phone') return json(ACTIVE);
      if (path === '/api/settings/texting-registration') {
        return json({
          status: 'brand_pending',
          readiness: 'partial_readiness',
          details: {
            legalBusinessName: 'Acme Plumbing LLC',
            einLast4: '6789',
            businessType: 'Limited Liability Corporation',
            businessIndustry: 'CONSTRUCTION',
            websiteUrl: null,
            address: { street: '1 Main St', street2: null, city: 'Austin', region: 'TX', postalCode: '78701' },
            contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+15125550100', title: 'Owner', jobPosition: 'CEO' },
          },
          failureReasons: [],
          submittedAt: '2026-10-01T00:00:00Z',
          approvedAt: null,
          updatedAt: '2026-10-01T00:00:00Z',
        });
      }
      return json({}, 404);
    });
    renderPage();

    const section = await screen.findByTestId('phone-settings');
    expect(await screen.findByRole('heading', { name: /texting registration/i })).toBeInTheDocument();
    expect(screen.getByText(/business under carrier review/i)).toBeInTheDocument();
    expect(section.contains(screen.getByRole('heading', { name: /texting registration/i }))).toBe(true);
  });
});
