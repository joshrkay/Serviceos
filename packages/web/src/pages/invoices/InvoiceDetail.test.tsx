import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvoiceDetail } from './InvoiceDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('InvoiceDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', invoiceNumber: 'INV-001', status: 'sent', jobId: 'j1',
        subtotalCents: 20000, discountCents: 0, taxCents: 1600, totalCents: 21600,
        amountPaidCents: 10000, amountDueCents: 11600,
        dueDate: '2026-02-01T00:00:00Z', createdAt: '2026-01-15T00:00:00Z',
        lineItems: [
          { id: 'li1', description: 'Labor', quantity: 4, unitPriceCents: 5000, totalCents: 20000, taxable: true },
        ],
        payments: [
          { id: 'p1', amountCents: 10000, method: 'credit_card', status: 'completed', createdAt: '2026-01-20T00:00:00Z' },
        ],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders invoice details', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Invoice INV-001')).toBeInTheDocument();
    expect(screen.getByText('Invoice Info')).toBeInTheDocument();
    expect(screen.getByText('Line Items')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
  });

  it('renders line item and payment data', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Labor')).toBeInTheDocument();
    expect(screen.getByText('Credit Card')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('renders payment audit status in invoice info', () => {
    render(<InvoiceDetail invoiceId="1" />);
    const paidTimestamp = new Date('2026-01-20T00:00:00Z').toLocaleString();
    expect(screen.getByText('Invoice Status:')).toBeInTheDocument();
    expect(screen.getByText('Payment Status:')).toBeInTheDocument();
    expect(screen.getByText('Paid via Credit Card')).toBeInTheDocument();
    expect(screen.getByText('Last Paid At:')).toBeInTheDocument();
    expect(screen.getAllByText(paidTimestamp).length).toBeGreaterThanOrEqual(1);
  });

  it('renders payment row with timestamp (date + time)', () => {
    render(<InvoiceDetail invoiceId="1" />);
    const paidTimestamp = new Date('2026-01-20T00:00:00Z').toLocaleString();
    expect(screen.getAllByText(paidTimestamp).length).toBeGreaterThanOrEqual(2);
  });

  it('renders balance details', () => {
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Amount Paid: $100.00')).toBeInTheDocument();
    expect(screen.getByText('Amount Due: $116.00')).toBeInTheDocument();
  });

  it('shows no payments message when empty', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', invoiceNumber: 'INV-002', status: 'draft', jobId: 'j2',
        subtotalCents: 5000, discountCents: 0, taxCents: 0, totalCents: 5000,
        amountPaidCents: 0, amountDueCents: 5000,
        createdAt: '2026-01-15T00:00:00Z',
        lineItems: [], payments: [],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('No payments recorded.')).toBeInTheDocument();
  });

  it('shows loading when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    render(<InvoiceDetail invoiceId="1" />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });

  describe('P5-011A — manual payment recording UI', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('hides the payment form by default', () => {
      render(<InvoiceDetail invoiceId="1" />);
      expect(screen.queryByTestId('payment-record-form')).toBeNull();
    });

    it('opens the payment form when Record Payment is clicked', () => {
      render(<InvoiceDetail invoiceId="1" />);
      fireEvent.click(screen.getByText('Record Payment'));
      expect(screen.getByTestId('payment-record-form')).toBeInTheDocument();
      expect(screen.getByTestId('amount-due-display')).toHaveTextContent('$116.00');
    });

    it('closes the form when Cancel is clicked', () => {
      render(<InvoiceDetail invoiceId="1" />);
      fireEvent.click(screen.getByText('Record Payment'));
      fireEvent.click(screen.getByTestId('cancel-button'));
      expect(screen.queryByTestId('payment-record-form')).toBeNull();
    });

    it('POSTs to /api/payments and refetches on submit', async () => {
      const refetch = vi.fn();
      vi.mocked(useDetailQuery).mockReturnValue({
        data: {
          id: 'inv-1', invoiceNumber: 'INV-001', status: 'sent', jobId: 'j1',
          subtotalCents: 20000, discountCents: 0, taxCents: 0, totalCents: 20000,
          amountPaidCents: 0, amountDueCents: 20000,
          createdAt: '2026-01-15T00:00:00Z', lineItems: [], payments: [],
        },
        isLoading: false, error: null, refetch,
      });

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'pay-1' }), { status: 201 })
      );
      global.fetch = fetchMock;

      render(<InvoiceDetail invoiceId="inv-1" />);
      fireEvent.click(screen.getByText('Record Payment'));
      fireEvent.click(screen.getByTestId('submit-button'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/payments');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.invoiceId).toBe('inv-1');
      expect(body.amountCents).toBe(20000);
      expect(body.method).toBe('cash');

      await waitFor(() => {
        expect(refetch).toHaveBeenCalled();
      });
    });

    it('surfaces a submit error when the API rejects', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('balance mismatch', { status: 400 })
      );
      global.fetch = fetchMock;

      render(<InvoiceDetail invoiceId="1" />);
      fireEvent.click(screen.getByText('Record Payment'));
      fireEvent.click(screen.getByTestId('submit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('payment-submit-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('payment-submit-error').textContent).toContain('400');
    });
  });

  describe('P5-018 InvoiceDetail — payment history & partial balance', () => {
    it('renders a row for each historical payment with amount, date, and method', () => {
      vi.mocked(useDetailQuery).mockReturnValue({
        data: {
          id: 'inv-history', invoiceNumber: 'INV-100', status: 'partially_paid', jobId: 'j1',
          subtotalCents: 30000, discountCents: 0, taxCents: 0, totalCents: 30000,
          amountPaidCents: 15000, amountDueCents: 15000,
          createdAt: '2026-01-10T00:00:00Z',
          lineItems: [],
          payments: [
            { id: 'p1', amountCents: 5000,  method: 'credit_card', status: 'completed', createdAt: '2026-01-15T10:00:00Z' },
            { id: 'p2', amountCents: 10000, method: 'bank_transfer', status: 'completed', createdAt: '2026-01-20T14:30:00Z' },
          ],
        },
        isLoading: false, error: null, refetch: vi.fn(),
      });

      render(<InvoiceDetail invoiceId="inv-history" />);

      // Both payment rows render with their formatted amounts.
      expect(screen.getByText('$50.00')).toBeInTheDocument();
      expect(screen.getByText('$100.00')).toBeInTheDocument();
      // Methods rendered with friendly labels.
      expect(screen.getByText('Credit Card')).toBeInTheDocument();
      expect(screen.getByText('ACH / Bank Transfer')).toBeInTheDocument();
      // Dates rendered as full timestamps.
      const ts1 = new Date('2026-01-15T10:00:00Z').toLocaleString();
      const ts2 = new Date('2026-01-20T14:30:00Z').toLocaleString();
      expect(screen.getAllByText(ts1).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(ts2).length).toBeGreaterThanOrEqual(1);
    });

    it('partial payment — Amount Due reflects the remaining balance', () => {
      vi.mocked(useDetailQuery).mockReturnValue({
        data: {
          id: 'inv-partial', invoiceNumber: 'INV-200', status: 'partially_paid', jobId: 'j1',
          subtotalCents: 50000, discountCents: 0, taxCents: 0, totalCents: 50000,
          amountPaidCents: 20000, amountDueCents: 30000,
          createdAt: '2026-02-01T00:00:00Z',
          lineItems: [],
          payments: [
            { id: 'p1', amountCents: 20000, method: 'cash', status: 'completed', createdAt: '2026-02-05T12:00:00Z' },
          ],
        },
        isLoading: false, error: null, refetch: vi.fn(),
      });

      render(<InvoiceDetail invoiceId="inv-partial" />);
      expect(screen.getByText('Amount Paid: $200.00')).toBeInTheDocument();
      expect(screen.getByText('Amount Due: $300.00')).toBeInTheDocument();
    });
  });
});
