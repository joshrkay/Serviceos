import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';

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
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  dueDate?: string;
  lineItems: LineItem[];
  payments: Payment[];
  createdAt: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
  return labels[normalized] ?? method.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPaymentStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
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
        { label: 'Record Payment', onClick: () => {}, variant: 'secondary' },
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
          content: (
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
          ),
        },
        {
          title: 'Balance',
          content: (
            <div>
              <p>Subtotal: {formatCents(data.subtotalCents)}</p>
              <p>Discount: {formatCents(data.discountCents)}</p>
              <p>Tax: {formatCents(data.taxCents)}</p>
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
          ),
        },
      ]}
    />
  );
}
