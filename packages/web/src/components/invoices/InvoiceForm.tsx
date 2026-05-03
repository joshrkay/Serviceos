import React, { useCallback, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import {
  LineItemEditor,
  LineItemDraft,
  emptyDraft,
  toLineItemPayload,
} from '../forms/LineItemEditor';

export interface InvoiceFormProps {
  onCreated?: (invoiceId: string) => void;
  onCancel?: () => void;
}

interface State {
  jobId: string;
  estimateId: string;
  /**
   * Picker UI is shown for due-date even though `createInvoiceSchema`
   * does not accept it (P11-006 spec). The field is sent in the payload
   * regardless; server zod will strip unknown keys.
   */
  dueDate: string;
  customerMessage: string;
  discountDollars: string;
  taxRatePercent: string;
  items: LineItemDraft[];
}

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

export function InvoiceForm({ onCreated, onCancel }: InvoiceFormProps) {
  const [form, setForm] = useState<State>(() => ({
    jobId: '',
    estimateId: '',
    dueDate: '',
    customerMessage: '',
    discountDollars: '',
    taxRatePercent: '',
    items: [emptyDraft()],
  }));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!form.jobId.trim()) {
        setError('Job ID is required.');
        return;
      }
      if (form.items.length === 0) {
        setError('At least one line item is required.');
        return;
      }
      const lineItems = form.items.map((it, i) => toLineItemPayload(it, i));
      if (lineItems.some((li) => !li.description)) {
        setError('Every line item needs a description.');
        return;
      }

      let discountCents: number | undefined;
      if (form.discountDollars.trim()) {
        const num = Number(form.discountDollars);
        if (!Number.isFinite(num) || num < 0) {
          setError('Discount must be non-negative.');
          return;
        }
        discountCents = Math.round(num * 100);
      }

      let taxRateBps: number | undefined;
      if (form.taxRatePercent.trim()) {
        const num = Number(form.taxRatePercent);
        if (!Number.isFinite(num) || num < 0 || num > 100) {
          setError('Tax rate must be 0-100%.');
          return;
        }
        taxRateBps = Math.round(num * 100);
      }

      // dueDate sent even though createInvoiceSchema doesn't accept it;
      // zod will strip. Tracked in commit message.
      const body = {
        jobId: form.jobId.trim(),
        estimateId: form.estimateId.trim() || undefined,
        lineItems,
        discountCents,
        taxRateBps,
        customerMessage: form.customerMessage.trim() || undefined,
        dueDate: form.dueDate || undefined,
      };

      setSubmitting(true);
      try {
        const res = await apiFetch('/api/invoices', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        const created = await res.json();
        onCreated?.(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create invoice');
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-lg text-slate-900 mb-4">New Invoice</h1>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-500">
          Job ID *
          <input
            value={form.jobId}
            onChange={(e) => setForm((p) => ({ ...p, jobId: e.target.value }))}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Estimate ID
          <input
            value={form.estimateId}
            onChange={(e) =>
              setForm((p) => ({ ...p, estimateId: e.target.value }))
            }
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Due date
          <input
            type="date"
            value={form.dueDate}
            onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Tax rate (%)
          <input
            value={form.taxRatePercent}
            onChange={(e) =>
              setForm((p) => ({ ...p, taxRatePercent: e.target.value }))
            }
            inputMode="decimal"
            placeholder="0"
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Discount ($)
          <input
            value={form.discountDollars}
            onChange={(e) =>
              setForm((p) => ({ ...p, discountDollars: e.target.value }))
            }
            inputMode="decimal"
            placeholder="0.00"
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-4">
        <LineItemEditor
          items={form.items}
          onChange={(items) => setForm((p) => ({ ...p, items }))}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 mt-4">
        <label className="text-xs text-slate-500">
          Customer message
          <textarea
            value={form.customerMessage}
            onChange={(e) =>
              setForm((p) => ({ ...p, customerMessage: e.target.value }))
            }
            rows={3}
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create invoice'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
