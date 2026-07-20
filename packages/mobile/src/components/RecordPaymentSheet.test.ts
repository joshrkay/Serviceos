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

function props(visible = true) {
  return {
    visible,
    onClose: h.onClose,
    client,
    invoiceId: 'inv-1',
    amountDueCents: 124000,
    onRecorded: h.onRecorded,
  };
}

function renderSheet() {
  return render(createElement(RecordPaymentSheet, props()));
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

  it('is usable again after a reopen (no lingering saved phase)', async () => {
    // Record a first (partial) payment; the sheet's phase becomes "saved".
    const { getByPlaceholderText, getByRole, rerender } = render(createElement(RecordPaymentSheet, props(true)));
    fireEvent.change(getByPlaceholderText('$1,240.00'), { target: { value: '100' } });
    fireEvent.click(getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(h.recordInvoicePayment).toHaveBeenCalledTimes(1));

    // Parent closes then reopens the still-mounted sheet.
    rerender(createElement(RecordPaymentSheet, props(false)));
    rerender(createElement(RecordPaymentSheet, props(true)));

    // The button is back to "Record payment" (not stuck disabled on "Recorded"),
    // and a second payment goes through.
    fireEvent.change(getByPlaceholderText('$1,240.00'), { target: { value: '200' } });
    fireEvent.click(getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(h.recordInvoicePayment).toHaveBeenCalledTimes(2));
    expect(h.recordInvoicePayment).toHaveBeenLastCalledWith(client, 'inv-1', {
      amountCents: 20000,
      method: 'cash',
    });
  });
});
