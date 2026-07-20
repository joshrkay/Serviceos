// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recordInvoicePayment: vi.fn(),
  onRecorded: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../api/invoices', () => ({
  recordInvoicePayment: (...args: unknown[]) => h.recordInvoicePayment(...args),
}));

// eslint-disable-next-line import/first
import { RecordPaymentSheet } from './RecordPaymentSheet';

const client = vi.fn();

function renderSheet() {
  return render(
    createElement(RecordPaymentSheet, {
      visible: true,
      onClose: h.onClose,
      client,
      invoiceId: 'inv-1',
      amountDueCents: 124000,
      onRecorded: h.onRecorded,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recordInvoicePayment.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('RecordPaymentSheet', () => {
  it('records the entered amount as integer cents with the chosen method', async () => {
    const { getByPlaceholderText, getByText, getByRole } = renderSheet();

    fireEvent.change(getByPlaceholderText('$1,240.00'), { target: { value: '500.50' } });
    fireEvent.click(getByText('Card'));
    fireEvent.click(getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(h.recordInvoicePayment).toHaveBeenCalled());
    expect(h.recordInvoicePayment).toHaveBeenCalledWith(client, 'inv-1', {
      amountCents: 50050,
      method: 'credit_card',
    });
    expect(h.onRecorded).toHaveBeenCalled();
  });

  it('blocks a payment above the outstanding balance', async () => {
    const { getByPlaceholderText, getByText, getByRole } = renderSheet();

    fireEvent.change(getByPlaceholderText('$1,240.00'), { target: { value: '2000' } });
    expect(getByText(/Can't exceed/)).toBeTruthy();

    // The record button is disabled, so a press does nothing.
    fireEvent.click(getByRole('button', { name: 'Record payment' }));
    expect(h.recordInvoicePayment).not.toHaveBeenCalled();
  });

  it('defaults the method to cash when none is chosen', async () => {
    const { getByPlaceholderText, getByRole } = renderSheet();

    fireEvent.change(getByPlaceholderText('$1,240.00'), { target: { value: '100' } });
    fireEvent.click(getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(h.recordInvoicePayment).toHaveBeenCalled());
    expect(h.recordInvoicePayment).toHaveBeenCalledWith(client, 'inv-1', {
      amountCents: 10000,
      method: 'cash',
    });
  });
});
