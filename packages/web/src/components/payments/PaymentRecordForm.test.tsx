import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaymentRecordForm, validatePaymentForm, PaymentFormData } from './PaymentRecordForm';

describe('P5-011A PaymentRecordForm', () => {
  it('renders form with balance due display', () => {
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={10000}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId('payment-record-form')).toBeDefined();
    expect(screen.getByTestId('amount-due-display').textContent).toContain('$100.00');
  });

  it('defaults amount to amountDueCents', () => {
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={5000}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const amountInput = screen.getByTestId('amount-input') as HTMLInputElement;
    expect(amountInput.value).toBe('5000');
  });

  it('method selector has all payment method options', () => {
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={5000}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const select = screen.getByTestId('method-select') as HTMLSelectElement;
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(5);
    const values = Array.from(options).map((o) => o.value);
    expect(values).toContain('cash');
    expect(values).toContain('check');
    expect(values).toContain('credit_card');
    expect(values).toContain('bank_transfer');
    expect(values).toContain('other');
  });

  it('submit calls onSubmit with form data', () => {
    const onSubmit = vi.fn();
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={10000}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId('method-select'), {
      target: { value: 'check' },
    });
    fireEvent.change(screen.getByTestId('note-input'), {
      target: { value: 'Check #1234' },
    });
    fireEvent.click(screen.getByTestId('submit-button'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data = onSubmit.mock.calls[0][0];
    expect(data.invoiceId).toBe('inv-1');
    expect(data.amountCents).toBe(10000);
    expect(data.method).toBe('check');
    expect(data.note).toBe('Check #1234');
  });

  it('shows errors for zero amount', () => {
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={10000}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('submit-button'));
    expect(screen.getByTestId('form-errors')).toBeDefined();
    expect(screen.getByTestId('form-errors').textContent).toContain('Amount must be positive');
  });

  it('shows errors when amount exceeds due', () => {
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={10000}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '20000' } });
    fireEvent.click(screen.getByTestId('submit-button'));
    expect(screen.getByTestId('form-errors').textContent).toContain('Amount exceeds balance due');
  });

  it('cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(
      <PaymentRecordForm
        invoiceId="inv-1"
        amountDueCents={10000}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId('cancel-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('validatePaymentForm function works correctly', () => {
    const validData: PaymentFormData = {
      invoiceId: 'inv-1',
      amountCents: 5000,
      method: 'cash',
      note: '',
      receivedDate: '2026-03-13',
    };
    expect(validatePaymentForm(validData, 10000)).toEqual([]);

    const zeroAmount: PaymentFormData = { ...validData, amountCents: 0 };
    const zeroErrors = validatePaymentForm(zeroAmount, 10000);
    expect(zeroErrors).toContain('Amount must be positive');

    const overAmount: PaymentFormData = { ...validData, amountCents: 20000 };
    const overErrors = validatePaymentForm(overAmount, 10000);
    expect(overErrors).toContain('Amount exceeds balance due');

    const noDate: PaymentFormData = { ...validData, receivedDate: '' };
    const dateErrors = validatePaymentForm(noDate, 10000);
    expect(dateErrors).toContain('Received date is required');
  });
});
