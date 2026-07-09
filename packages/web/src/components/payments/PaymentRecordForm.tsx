import { useState, useCallback } from 'react';
import { formatCurrency as formatCents } from '../../utils/currency';

export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'bank_transfer' | 'other';

export interface PaymentRecordFormProps {
  invoiceId: string;
  amountDueCents: number;
  /** May return a promise (the consumer's POST) — the form disables its
   *  submit button until it settles so a double-click can't record twice. */
  onSubmit: (data: PaymentFormData) => void | Promise<void>;
  onCancel: () => void;
}

export interface PaymentFormData {
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  note: string;
  receivedDate: string;
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
  // Money invariant: integer cents only — 100.5 cents is not a payable amount.
  if (!Number.isInteger(data.amountCents)) errors.push('Amount must be a whole number of cents');
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
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    // Re-entry guard: a second click while the POST is in flight would
    // record the payment twice.
    if (submitting) return;
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
    setSubmitting(true);
    try {
      await onSubmit(formData);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Failed to record payment']);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, invoiceId, amountCents, method, note, receivedDate, amountDueCents, onSubmit]);

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
        <button
          data-testid="submit-button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? 'Recording…' : 'Record Payment'}
        </button>
        <button data-testid="cancel-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
