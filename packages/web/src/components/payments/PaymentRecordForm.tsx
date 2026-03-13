import React, { useState, useCallback } from 'react';

export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'bank_transfer' | 'other';

export interface PaymentRecordFormProps {
  invoiceId: string;
  amountDueCents: number;
  onSubmit: (data: PaymentFormData) => void;
  onCancel: () => void;
}

export interface PaymentFormData {
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  note: string;
  receivedDate: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'other', label: 'Other' },
];

export function validatePaymentForm(data: PaymentFormData, amountDueCents: number): string[] {
  const errors: string[] = [];
  if (!data.amountCents || data.amountCents <= 0) errors.push('Amount must be positive');
  if (data.amountCents > amountDueCents) errors.push('Amount exceeds balance due');
  if (!data.method) errors.push('Payment method is required');
  if (!data.receivedDate) errors.push('Received date is required');
  return errors;
}

export function PaymentRecordForm({
  invoiceId,
  amountDueCents,
  onSubmit,
  onCancel,
}: PaymentRecordFormProps) {
  const [amountCents, setAmountCents] = useState(amountDueCents);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().split('T')[0]);
  const [errors, setErrors] = useState<string[]>([]);

  const handleSubmit = useCallback(() => {
    const formData: PaymentFormData = {
      invoiceId,
      amountCents,
      method,
      note,
      receivedDate,
    };
    const validationErrors = validatePaymentForm(formData, amountDueCents);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors([]);
    onSubmit(formData);
  }, [invoiceId, amountCents, method, note, receivedDate, amountDueCents, onSubmit]);

  return (
    <div className="payment-record-form" data-testid="payment-record-form">
      <h3>Record Payment</h3>
      <div data-testid="amount-due-display">
        Balance Due: {formatCents(amountDueCents)}
      </div>

      {errors.length > 0 && (
        <div className="form-errors" data-testid="form-errors">
          {errors.map((error, i) => (
            <div key={i} className="error">{error}</div>
          ))}
        </div>
      )}

      <div className="form-field">
        <label htmlFor="amount">Amount (cents):</label>
        <input
          id="amount"
          data-testid="amount-input"
          type="number"
          value={amountCents}
          onChange={(e) => setAmountCents(Number(e.target.value))}
          min={1}
          max={amountDueCents}
        />
      </div>

      <div className="form-field">
        <label htmlFor="method">Payment Method:</label>
        <select
          id="method"
          data-testid="method-select"
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod)}
        >
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label htmlFor="received-date">Received Date:</label>
        <input
          id="received-date"
          data-testid="received-date-input"
          type="date"
          value={receivedDate}
          onChange={(e) => setReceivedDate(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label htmlFor="note">Note:</label>
        <textarea
          id="note"
          data-testid="note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional payment note"
        />
      </div>

      <div className="form-actions">
        <button data-testid="submit-button" onClick={handleSubmit}>
          Record Payment
        </button>
        <button data-testid="cancel-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
