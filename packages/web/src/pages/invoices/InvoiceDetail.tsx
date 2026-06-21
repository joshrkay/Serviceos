import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import {
  PaymentRecordForm,
  PaymentFormData,
} from '../../components/payments/PaymentRecordForm';
import {
  LineItemEditor,
  LineItemDraft,
  toLineItemPayload,
} from '../../components/forms/LineItemEditor';
import { apiFetch } from '../../utils/api-fetch';
import { formatCurrency as formatCents } from '../../utils/currency';
import { toTitleCase } from '../../utils/string';

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxable: boolean;
}

interface Payment {
  id: string;
  amountCents: number;
  method: string;
  status: string;
  createdAt: string;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  jobId: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents?: number;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  dueDate?: string;
  lineItems: LineItem[];
  payments: Payment[];
  createdAt: string;
}

function formatDateTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

function formatPaymentMethod(method: string): string {
  const normalized = method.trim().toLowerCase();
  const labels: Record<string, string> = {
    cash: 'Cash',
    check: 'Check',
    credit_card: 'Credit Card',
    card: 'Credit Card',
    ach: 'ACH',
    bank_transfer: 'ACH / Bank Transfer',
    zelle: 'Zelle',
    other: 'Other',
  };
  return labels[normalized] ?? toTitleCase(method);
}

function formatPaymentStatus(status: string): string {
  return toTitleCase(status);
}

function isSettledPayment(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'completed' || normalized === 'succeeded' || normalized === 'paid';
}

interface InvoiceDetailProps {
  invoiceId: string;
  onBack?: () => void;
}

export function InvoiceDetail({ invoiceId, onBack }: InvoiceDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Invoice>('/api/invoices', invoiceId);
  const [showPaymentForm, setShowPaymentForm] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // P11-007 — line-item edit toggle.
  const [editingLineItems, setEditingLineItems] = React.useState(false);
  const [draft, setDraft] = React.useState<LineItemDraft[]>([]);
  const [lineItemSaving, setLineItemSaving] = React.useState(false);
  const [lineItemError, setLineItemError] = React.useState<string | null>(null);

  const startEditLineItems = React.useCallback(() => {
    if (!data) return;
    setDraft(
      (data.lineItems ?? []).map((li) => ({
        id: li.id,
        description: li.description,
        quantity: String(li.quantity),
        unitPriceDollars: (li.unitPriceCents / 100).toFixed(2),
        taxable: li.taxable,
      }))
    );
    setLineItemError(null);
    setEditingLineItems(true);
  }, [data]);

  const cancelEditLineItems = React.useCallback(() => {
    setEditingLineItems(false);
    setLineItemError(null);
  }, []);

  const saveLineItems = React.useCallback(async () => {
    if (!data) return;
    setLineItemSaving(true);
    setLineItemError(null);
    try {
      const payload = draft.map((d, i) => toLineItemPayload(d, i));
      const res = await apiFetch(`/api/invoices/${data.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ lineItems: payload }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      setEditingLineItems(false);
      refetch();
    } catch (err) {
      setLineItemError(err instanceof Error ? err.message : 'Failed to save line items');
    } finally {
      setLineItemSaving(false);
    }
  }, [data, draft, refetch]);

  const submitPayment = React.useCallback(
    async (form: PaymentFormData) => {
      setSubmitError(null);
      try {
        const res = await fetch('/api/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoiceId: form.invoiceId,
            amountCents: form.amountCents,
            method: form.method,
            note: form.note || undefined,
            receivedDate: form.receivedDate,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Payment request failed (${res.status}): ${body}`);
        }
        setShowPaymentForm(false);
        refetch();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    },
    [refetch]
  );

  if (!data) {
    return <DetailPage title="Invoice" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  const recordedPayments = data.payments ?? [];
  const settledPayments = recordedPayments.filter((payment) => isSettledPayment(payment.status));
  const paymentMethodLabels = Array.from(new Set(settledPayments.map((payment) => formatPaymentMethod(payment.method))));
  const mostRecentSettledPayment = settledPayments
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const paymentAuditSummary = settledPayments.length === 0
    ? 'Not paid yet'
    : `Paid via ${paymentMethodLabels.join(', ')}`;

  return (
    <DetailPage
      title={`Invoice ${data.invoiceNumber}`}
      subtitle={`Status: ${data.status}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Edit', onClick: () => {}, variant: 'primary' },
        {
          label: 'Record Payment',
          onClick: () => setShowPaymentForm(true),
          variant: 'secondary',
        },
      ]}
      sections={[
        {
          title: 'Invoice Info',
          content: (
            <div>
              <p>Job: {data.jobId}</p>
              <p><strong>Invoice Status:</strong> {formatPaymentStatus(data.status)}</p>
              <p><strong>Payment Status:</strong> {paymentAuditSummary}</p>
              {mostRecentSettledPayment && (
                <p><strong>Last Paid At:</strong> {formatDateTime(mostRecentSettledPayment.createdAt)}</p>
              )}
              {data.dueDate && <p>Due Date: {formatDateTime(data.dueDate)}</p>}
              <p>Created: {formatDateTime(data.createdAt)}</p>
            </div>
          ),
        },
        {
          title: 'Line Items',
          content: editingLineItems ? (
            <div data-testid="invoice-line-items-edit">
              {lineItemError && (
                <div role="alert" className="error" data-testid="line-items-error">
                  {lineItemError}
                </div>
              )}
              <LineItemEditor items={draft} onChange={setDraft} />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="line-items-save"
                  onClick={saveLineItems}
                  disabled={lineItemSaving}
                  className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
                >
                  {lineItemSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  data-testid="line-items-cancel"
                  onClick={cancelEditLineItems}
                  className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  data-testid="line-items-edit-toggle"
                  onClick={startEditLineItems}
                  className="rounded-md border border-slate-200 text-xs px-2 py-1 hover:bg-slate-50"
                >
                  Edit
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="list-table">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Unit Price</th>
                      <th>Total</th>
                      <th>Taxable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.lineItems ?? []).map((item) => (
                      <tr key={item.id}>
                        <td>{item.description}</td>
                        <td>{item.quantity}</td>
                        <td>{formatCents(item.unitPriceCents)}</td>
                        <td>{formatCents(item.totalCents)}</td>
                        <td>{item.taxable ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ),
        },
        {
          title: 'Balance',
          content: (
            <div>
              <p>Subtotal: {formatCents(data.subtotalCents)}</p>
              <p>Discount: {formatCents(data.discountCents)}</p>
              <p>Tax: {formatCents(data.taxCents)}</p>
              {data.processingFeeCents != null && data.processingFeeCents > 0 && (
                <p>Processing fee: {formatCents(data.processingFeeCents)}</p>
              )}
              <p><strong>Total: {formatCents(data.totalCents)}</strong></p>
              <p>Amount Paid: {formatCents(data.amountPaidCents)}</p>
              <p><strong>Amount Due: {formatCents(data.amountDueCents)}</strong></p>
            </div>
          ),
        },
        {
          title: 'Payments',
          content: recordedPayments.length === 0 ? (
            <p>No payments recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="list-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Method</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recordedPayments.map((p) => (
                    <tr key={p.id}>
                      <td>{formatDateTime(p.createdAt)}</td>
                      <td>{formatCents(p.amountCents)}</td>
                      <td>{formatPaymentMethod(p.method)}</td>
                      <td>{formatPaymentStatus(p.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        },
        ...(showPaymentForm
          ? [
              {
                title: 'Record a Payment',
                content: (
                  <>
                    {submitError && (
                      <div className="error" data-testid="payment-submit-error">
                        {submitError}
                      </div>
                    )}
                    <PaymentRecordForm
                      invoiceId={data.id}
                      amountDueCents={data.amountDueCents}
                      onSubmit={submitPayment}
                      onCancel={() => {
                        setSubmitError(null);
                        setShowPaymentForm(false);
                      }}
                    />
                  </>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
