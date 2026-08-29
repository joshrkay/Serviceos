/**
 * #873 (web half) — a failed POST /api/billing/portal-session renders
 * the server's actionable reason as a persistent alert with a retry,
 * instead of discarding it into a transient generic toast. Tolerates
 * both the structured envelope ({ message, details.stripeCode }) and
 * older message-only bodies so the web and api halves land
 * independently.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const fetchLanguageMock = vi.fn();
vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: () => fetchLanguageMock(),
  updateLanguageSettings: vi.fn(),
}));

vi.mock('../../api/integrations', () => ({
  fetchIntegrations: vi.fn(async () => []),
}));

vi.mock('../../hooks/useMe', () => ({ useMe: () => ({ me: null }) }));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (msg: string) => toastErrorMock(msg),
  },
}));

import { SettingsPage } from './SettingsPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const RESOURCE_MISSING_BODY = {
  error: 'BILLING_PORTAL_FAILED',
  message:
    "Stripe couldn't open the billing portal: No such customer: 'cus_UswJPdKUh7f1eg' The saved Stripe customer for this account no longer exists — contact support to re-link billing.",
  details: { stripeStatus: 404, stripeCode: 'resource_missing' },
};

function renderPage(portalResponse: () => Response) {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/settings') return jsonResponse({});
    if (url === '/api/onboarding/status') return jsonResponse({ voiceAgentLive: false });
    if (url === '/api/billing/portal-session') return portalResponse();
    return jsonResponse({}, { ok: false, status: 404 });
  });
  fetchLanguageMock.mockResolvedValue({ defaultLanguage: 'en' });
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

async function openPortalViaRow() {
  const row = (await screen.findByText('Rivet subscription')).closest('button')!;
  fireEvent.click(row);
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
}

describe('SettingsPage billing portal failure UI (#873)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('renders the structured resource_missing reason as a persistent alert', async () => {
    renderPage(() => jsonResponse(RESOURCE_MISSING_BODY, { ok: false, status: 502 }));
    await openPortalViaRow();
    const alert = await screen.findByTestId('billing-portal-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('contact support to re-link billing');
    expect(alert).toHaveTextContent("cus_UswJPdKUh7f1eg");
    // Not a toast — the actionable state persists on the page.
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('falls back gracefully to an old message-only body', async () => {
    renderPage(() =>
      jsonResponse(
        { error: 'BILLING_PORTAL_FAILED', message: 'Stripe rejected the request' },
        { ok: false, status: 502 },
      ),
    );
    await openPortalViaRow();
    expect(await screen.findByTestId('billing-portal-error')).toHaveTextContent(
      'Stripe rejected the request',
    );
  });

  it('crafts the re-link copy when resource_missing arrives without a message', async () => {
    renderPage(() =>
      jsonResponse({ details: { stripeCode: 'resource_missing' } }, { ok: false, status: 502 }),
    );
    await openPortalViaRow();
    const alert = await screen.findByTestId('billing-portal-error');
    expect(alert).toHaveTextContent('no longer exists');
    expect(alert).toHaveTextContent('contact support');
  });

  it('falls back to an HTTP-status line for a non-JSON failure body', async () => {
    renderPage(
      () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
    );
    await openPortalViaRow();
    expect(await screen.findByTestId('billing-portal-error')).toHaveTextContent(
      "Couldn't open the billing portal (HTTP 502)",
    );
  });

  it('Try again retries the portal POST and clears the alert while pending', async () => {
    renderPage(() => jsonResponse(RESOURCE_MISSING_BODY, { ok: false, status: 502 }));
    await openPortalViaRow();
    await screen.findByTestId('billing-portal-error');
    fireEvent.click(screen.getByTestId('billing-portal-retry'));
    await waitFor(() => {
      const portalCalls = apiFetchMock.mock.calls.filter(
        (c) => c[0] === '/api/billing/portal-session',
      );
      expect(portalCalls).toHaveLength(2);
    });
    // Still failing — the alert re-renders with the reason.
    expect(await screen.findByTestId('billing-portal-error')).toHaveTextContent(
      'contact support to re-link billing',
    );
  });

  it('keeps the 503 not-configured toast behavior', async () => {
    renderPage(() => jsonResponse({}, { ok: false, status: 503 }));
    await openPortalViaRow();
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Subscription billing is not configured for this tenant',
      ),
    );
    expect(screen.queryByTestId('billing-portal-error')).toBeNull();
  });

  // Class-contract (CLAUDE.md): the retry affordance meets the 44px floor.
  it('the retry button clears the 44px tap-target floor', async () => {
    renderPage(() => jsonResponse(RESOURCE_MISSING_BODY, { ok: false, status: 502 }));
    await openPortalViaRow();
    await screen.findByTestId('billing-portal-error');
    expect(screen.getByTestId('billing-portal-retry').className).toContain('min-h-11');
  });

  // #873 review — details.reason marks the stale-customer case as
  // unrecoverable: retrying can never succeed, so the banner renders
  // re-link guidance (with the stale id, monospaced) and NO "Try again".
  it('renders re-link guidance without a retry when the saved customer is gone', async () => {
    renderPage(() =>
      jsonResponse(
        {
          ...RESOURCE_MISSING_BODY,
          details: {
            ...RESOURCE_MISSING_BODY.details,
            reason: 'stripe_customer_missing',
            stripeCustomerId: 'cus_UswJPdKUh7f1eg',
          },
        },
        { ok: false, status: 502 },
      ),
    );
    await openPortalViaRow();
    const alert = await screen.findByTestId('billing-portal-error');
    expect(alert).toHaveTextContent('no longer exists');
    expect(alert).toHaveTextContent('contact support to re-link billing');
    // The stale id is shown monospaced for the support conversation.
    const staleId = screen.getByTestId('billing-portal-stale-id');
    expect(staleId).toHaveTextContent('cus_UswJPdKUh7f1eg');
    expect(staleId.tagName).toBe('CODE');
    expect(staleId.className).toContain('font-mono');
    // A retry cannot succeed — the affordance is gone for this reason.
    expect(screen.queryByTestId('billing-portal-retry')).toBeNull();
  });

  it('re-link guidance still renders when the stale id is absent', async () => {
    renderPage(() =>
      jsonResponse(
        {
          error: 'BILLING_PORTAL_FAILED',
          message: 'No such customer',
          details: { stripeCode: 'resource_missing', reason: 'stripe_customer_missing' },
        },
        { ok: false, status: 502 },
      ),
    );
    await openPortalViaRow();
    const alert = await screen.findByTestId('billing-portal-error');
    expect(alert).toHaveTextContent('re-link billing');
    expect(screen.queryByTestId('billing-portal-stale-id')).toBeNull();
    expect(screen.queryByTestId('billing-portal-retry')).toBeNull();
  });
});
