/**
 * #873 (web half) — PastDueBanner previously DISCARDED the server's
 * portal-failure message ("Couldn't open billing (HTTP 502)…"), which
 * turned an actionable "contact support to re-link billing" into a
 * misleading try-again-later. It now renders the server's reason.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));

const statusState: { data: { subscriptionStatus: string | null } | null } = { data: null };
vi.mock('../../hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => ({ data: statusState.data }),
}));

import { PastDueBanner } from './PastDueBanner';

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

describe('PastDueBanner (#873)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    statusState.data = { subscriptionStatus: 'past_due' };
  });

  it('renders nothing unless the subscription is past_due', () => {
    statusState.data = { subscriptionStatus: 'active' };
    render(<PastDueBanner />);
    expect(screen.queryByText(/last payment failed/i)).toBeNull();
  });

  it('renders the banner with the update CTA when past_due', () => {
    render(<PastDueBanner />);
    expect(screen.getByText(/last payment failed/i)).toBeInTheDocument();
    expect(screen.getByText('Update payment method')).toBeInTheDocument();
  });

  it('renders the server reason when the portal POST fails (no more generic HTTP line)', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'BILLING_PORTAL_FAILED',
          message:
            'The saved Stripe customer for this account no longer exists — contact support to re-link billing.',
          details: { stripeStatus: 404, stripeCode: 'resource_missing' },
        },
        { ok: false, status: 502 },
      ),
    );
    render(<PastDueBanner />);
    fireEvent.click(screen.getByText('Update payment method'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('contact support to re-link billing');
    expect(alert).not.toHaveTextContent("Couldn't open billing (HTTP 502)");
  });

  it('falls back to the HTTP line only when the body carries no reason', async () => {
    apiFetchMock.mockResolvedValueOnce(
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }) as unknown as Response,
    );
    render(<PastDueBanner />);
    fireEvent.click(screen.getByText('Update payment method'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't open the billing portal (HTTP 502)",
    );
  });

  // #873 review — details.reason marks the stale-customer case as
  // unrecoverable. The banner drops the portal CTA (it can never succeed)
  // and renders re-link guidance with the stale id, monospaced.
  it('hides the portal CTA and renders re-link guidance when the saved customer is gone', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'BILLING_PORTAL_FAILED',
          message: 'No such customer',
          details: {
            stripeStatus: 404,
            stripeCode: 'resource_missing',
            reason: 'stripe_customer_missing',
            stripeCustomerId: 'cus_UswJPdKUh7f1eg',
          },
        },
        { ok: false, status: 502 },
      ),
    );
    render(<PastDueBanner />);
    fireEvent.click(screen.getByText('Update payment method'));

    const alert = await screen.findByTestId('past-due-relink');
    expect(alert).toHaveTextContent('no longer exists');
    expect(alert).toHaveTextContent('re-link billing');
    const staleId = screen.getByTestId('past-due-stale-id');
    expect(staleId).toHaveTextContent('cus_UswJPdKUh7f1eg');
    expect(staleId.tagName).toBe('CODE');
    expect(staleId.className).toContain('font-mono');
    // The futile CTA is gone for this reason.
    expect(screen.queryByText('Update payment method')).toBeNull();
  });

  it('reports a missing portal URL on an OK response', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<PastDueBanner />);
    fireEvent.click(screen.getByText('Update payment method'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('no portal URL returned'),
    );
  });
});
