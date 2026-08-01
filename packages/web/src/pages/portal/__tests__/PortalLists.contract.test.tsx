import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { PortalInvoiceList } from '../PortalInvoiceList';
import { PortalEstimateList } from '../PortalEstimateList';
import { PortalAgreementList } from '../PortalAgreementList';
import { PortalJobList } from '../PortalJobList';
import { portalApi } from '../../../api/portal';
import { expectNoRawPalette } from '../../../components/customer/rawPaletteContract';

/**
 * Tenant-neutral class contract for the four portal list pages (U13h).
 * Each is rendered with one populated row so the status pills (destructive)
 * and amounts (success) render, not just the empty state. PortalJobList has
 * no other test, so this is its only coverage.
 */
const ISO = '2026-06-01T12:00:00.000Z';

describe('Portal list pages — no-raw-palette class contract', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('PortalInvoiceList renders no raw palette', async () => {
    vi.spyOn(portalApi, 'invoices').mockResolvedValue({
      invoices: [{
        id: 'inv-1', invoiceNumber: 'INV-2000', status: 'open', totalCents: 10000,
        amountPaidCents: 0, amountDueCents: 10000, issuedAt: ISO, dueDate: null,
        createdAt: ISO, payNowUrl: 'https://checkout.stripe.com/pay/plink_1',
      }],
    });
    const { container } = render(<PortalInvoiceList token="tok-1" />);
    await waitFor(() => screen.getByText('INV-2000'));
    expectNoRawPalette(container.innerHTML);
  });

  it('PortalEstimateList renders no raw palette', async () => {
    vi.spyOn(portalApi, 'estimates').mockResolvedValue({
      estimates: [{
        id: 'est-1', estimateNumber: 'EST-1', status: 'sent', totalCents: 5000,
        createdAt: ISO, validUntil: null, depositRequiredCents: 0, depositPaidCents: 0,
        depositStatus: 'not_required', depositPayable: false, publicViewToken: null,
      }],
    });
    const { container } = render(<PortalEstimateList token="tok-1" />);
    await waitFor(() => screen.getByText('EST-1'));
    expectNoRawPalette(container.innerHTML);
  });

  it('PortalAgreementList renders no raw palette', async () => {
    vi.spyOn(portalApi, 'agreements').mockResolvedValue({
      agreements: [{
        id: 'agr-1', name: 'Quarterly HVAC', status: 'active', priceCents: 9900,
        recurrenceRule: 'FREQ=MONTHLY', nextRunAt: ISO, startsOn: '2026-06-01', endsOn: null,
      }],
    });
    const { container } = render(<PortalAgreementList token="tok-1" />);
    await waitFor(() => screen.getByText('Quarterly HVAC'));
    expectNoRawPalette(container.innerHTML);
  });

  it('PortalJobList renders no raw palette', async () => {
    vi.spyOn(portalApi, 'jobs').mockResolvedValue({
      jobs: [{
        id: 'job-1', jobNumber: 'JOB-1', summary: 'AC repair', status: 'scheduled',
        priority: 'normal', createdAt: ISO,
      }],
    });
    const { container } = render(<PortalJobList token="tok-1" />);
    await waitFor(() => screen.getByText(/JOB-1|AC repair/));
    expectNoRawPalette(container.innerHTML);
  });
});
