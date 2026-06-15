import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalInvoiceList } from '../PortalInvoiceList';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

interface InvoiceOverrides {
  status?: string;
  amountPaidCents?: number;
  amountDueCents?: number;
  payNowUrl?: string | null;
}

function invoice(overrides: InvoiceOverrides = {}) {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-2000',
    status: overrides.status ?? 'open',
    totalCents: 10000,
    amountPaidCents: overrides.amountPaidCents ?? 0,
    amountDueCents: overrides.amountDueCents ?? 10000,
    issuedAt: new Date('2026-06-01T12:00:00Z').toISOString(),
    dueDate: null,
    createdAt: new Date('2026-06-01T12:00:00Z').toISOString(),
    payNowUrl:
      overrides.payNowUrl === undefined
        ? 'https://checkout.stripe.com/pay/plink_1'
        : overrides.payNowUrl,
  };
}

describe('Portal — PortalInvoiceList (P10-001)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a Pay now CTA + amount due when the invoice is payable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ invoices: [invoice()] })),
    );

    render(<PortalInvoiceList token="tok-1" />);

    const cta = await screen.findByRole('link', { name: 'Pay now' });
    expect(cta).toHaveAttribute('href', 'https://checkout.stripe.com/pay/plink_1');
    // Mobile tap-target contract (CLAUDE.md ≥44px → min-h-11).
    expect(cta.className).toContain('min-h-11');
    expect(screen.getByText('$100.00 due')).toBeInTheDocument();
  });

  it('shows Paid and no CTA once the balance is settled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          invoices: [
            invoice({ status: 'paid', amountPaidCents: 10000, amountDueCents: 0 }),
          ],
        }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('Paid')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('omits the CTA when there is a balance due but no payment link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ invoices: [invoice({ payNowUrl: null })] }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('$100.00 due')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no invoices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ invoices: [] })),
    );

    render(<PortalInvoiceList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('No invoices yet.')).toBeInTheDocument();
    });
  });
});
