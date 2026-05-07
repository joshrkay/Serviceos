import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import {
  LineItemEditor,
  LineItemDraft,
  toLineItemPayload,
} from '../../components/forms/LineItemEditor';
import { apiFetch } from '../../utils/api-fetch';

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxable: boolean;
}

interface Estimate {
  id: string;
  estimateNumber: string;
  status: string;
  jobId: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  lineItems: LineItem[];
  sourceType?: string;
  sourceReference?: string;
  approvalStatus?: string;
  rejectionReason?: string;
  createdAt: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface EstimateDetailProps {
  estimateId: string;
  onBack?: () => void;
}

export function EstimateDetail({ estimateId, onBack }: EstimateDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Estimate>('/api/estimates', estimateId);

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
      const res = await apiFetch(`/api/estimates/${data.id}`, {
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

  if (!data) {
    return <DetailPage title="Estimate" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  return (
    <DetailPage
      title={`Estimate ${data.estimateNumber}`}
      subtitle={`Status: ${data.status}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Edit', onClick: () => {}, variant: 'primary' },
        { label: 'Send', onClick: () => {}, variant: 'secondary' },
      ]}
      sections={[
        {
          title: 'Estimate Info',
          content: (
            <div>
              <p>Job: {data.jobId}</p>
              <p>Created: {new Date(data.createdAt).toLocaleDateString()}</p>
              {data.sourceType && <p>Source: {data.sourceType}</p>}
              {data.approvalStatus && <p>Approval: {data.approvalStatus}</p>}
              {data.rejectionReason && <p>Rejection Reason: {data.rejectionReason}</p>}
            </div>
          ),
        },
        {
          title: 'Line Items',
          content: editingLineItems ? (
            <div data-testid="estimate-line-items-edit">
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
          ),
        },
        {
          title: 'Totals',
          content: (
            <div>
              <p>Subtotal: {formatCents(data.subtotalCents)}</p>
              <p>Discount: {formatCents(data.discountCents)}</p>
              <p>Tax: {formatCents(data.taxCents)}</p>
              <p><strong>Total: {formatCents(data.totalCents)}</strong></p>
            </div>
          ),
        },
      ]}
    />
  );
}
