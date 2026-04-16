import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { InvoicePaymentPage } from './InvoicePaymentPage';

describe('InvoicePaymentPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/pay/i2']}>
        <Routes>
          <Route path="/pay/:id" element={<InvoicePaymentPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('shows success screen when payment request succeeds', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    renderPage();

    fireEvent.change(screen.getByPlaceholderText('1234 5678 9012 3456'), { target: { value: '4111111111111111' } });
    fireEvent.change(screen.getByPlaceholderText('MM/YY'), { target: { value: '12/29' } });
    fireEvent.change(screen.getByPlaceholderText('123'), { target: { value: '123' } });
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Jane Customer' } });
    fireEvent.change(screen.getByPlaceholderText('78701'), { target: { value: '78701' } });

    fireEvent.click(screen.getByRole('button', { name: /pay \$425 securely/i }));

    await waitFor(() => {
      expect(screen.getByText('Payment received!')).toBeInTheDocument();
    });
  });

  it('shows inline error when payment request fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Payment service unavailable' }),
    } as Response);

    renderPage();

    fireEvent.change(screen.getByPlaceholderText('1234 5678 9012 3456'), { target: { value: '4111111111111111' } });
    fireEvent.change(screen.getByPlaceholderText('MM/YY'), { target: { value: '12/29' } });
    fireEvent.change(screen.getByPlaceholderText('123'), { target: { value: '123' } });
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Jane Customer' } });
    fireEvent.change(screen.getByPlaceholderText('78701'), { target: { value: '78701' } });

    fireEvent.click(screen.getByRole('button', { name: /pay \$425 securely/i }));

    await waitFor(() => {
      expect(screen.getByText('Payment service unavailable')).toBeInTheDocument();
    });
  });
});
