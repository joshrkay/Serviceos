import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { InvoicePaymentPage } from './InvoicePaymentPage';

const mockInvoice = {
  id: 'inv_1',
  invoiceNumber: 'INV-001',
  status: 'open',
  customerName: 'Jane Customer',
  businessName: 'HVAC Pro',
  lineItems: [{ description: 'AC Repair', quantity: 1, unitPriceCents: 42500, totalCents: 42500 }],
  totalCents: 42500,
  subtotalCents: 42500,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 42500,
  isPaid: false,
  viewCount: 1,
};

describe('InvoicePaymentPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage(path = '/pay/i2') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/pay/:id" element={<InvoicePaymentPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('shows paid screen when invoice is already paid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockInvoice, isPaid: true, amountPaidCents: 42500, amountDueCents: 0 }),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Payment received!')).toBeInTheDocument();
    });
  });

  it('shows paid screen when Stripe redirects back with ?success=true', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockInvoice,
    } as Response);

    renderPage('/pay/i2?success=true');

    await waitFor(() => {
      expect(screen.getByText('Payment received!')).toBeInTheDocument();
    });
  });

  it('shows Pay button after invoice loads', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockInvoice,
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pay.*securely/i })).toBeInTheDocument();
    });
  });

  it('shows inline error when checkout request fails', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockInvoice,
      } as Response) // GET invoice
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response) // POST view (pingView)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Payment service unavailable' }),
      } as Response); // POST checkout

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pay.*securely/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(screen.getByText('Payment service unavailable')).toBeInTheDocument();
    });
  });
});
