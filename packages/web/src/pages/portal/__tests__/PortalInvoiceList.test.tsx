import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalInvoiceList } from '../PortalInvoiceList';
import { formatDateInTenantTz } from '../../../utils/formatInTenantTz';

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
  collectOnSite?: boolean;
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
    collectOnSite: overrides.collectOnSite ?? false,
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

  // S5a-2 (U8) — the business collects in person (or the API could not read
  // its choice): the API sends payNowUrl: null + collectOnSite: true and the
  // row says how to pay instead of offering a link.
  it('collectOnSite: no Pay now link, a "Pay in person" label instead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ invoices: [invoice({ payNowUrl: null, collectOnSite: true })] }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" />);

    const label = await screen.findByTestId('portal-invoice-pay-in-person');
    expect(label.textContent).toBe('Pay in person');
    expect(screen.queryByRole('link', { name: 'Pay now' })).not.toBeInTheDocument();
    // Never an anchor without an href on this row.
    expect(document.querySelectorAll('a:not([href])')).toHaveLength(0);
    expect(screen.getByText('$100.00 due')).toBeInTheDocument();
  });

  it('collectOnSite on a settled invoice: Paid, and no in-person label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          invoices: [
            invoice({
              status: 'paid',
              amountPaidCents: 10000,
              amountDueCents: 0,
              payNowUrl: null,
              collectOnSite: true,
            }),
          ],
        }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" />);

    await waitFor(() => expect(screen.getByText('Paid')).toBeInTheDocument());
    expect(screen.queryByTestId('portal-invoice-pay-in-person')).not.toBeInTheDocument();
  });

  it('a pay-link row with no link yet shows neither the CTA nor the in-person label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ invoices: [invoice({ payNowUrl: null, collectOnSite: false })] }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" />);

    await waitFor(() => expect(screen.getByText('$100.00 due')).toBeInTheDocument());
    expect(screen.queryByTestId('portal-invoice-pay-in-person')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('renders the issued date in the tenant timezone, not the viewer locale (WS6)', async () => {
    // 2026-06-01T12:00:00Z is still May 31 in Los Angeles — the tenant-tz
    // formatter must key off the passed timezone, not the process TZ.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ invoices: [invoice({ payNowUrl: null })] }),
      ),
    );

    render(<PortalInvoiceList token="tok-1" timezone="America/Los_Angeles" />);

    const expected = `Issued ${formatDateInTenantTz(
      '2026-06-01T12:00:00Z',
      'America/Los_Angeles',
      { withYear: true },
    )}`;
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    // In LA, 2026-06-01T12:00Z is Jun 1, 5:00 AM — still Jun 1; but an instant
    // near midnight would differ. Assert the label is the tenant-tz string.
    expect(expected).toContain('Jun 1');
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
