import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Loader } from 'lucide-react';
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

interface ApiEstimateLineItem {
  id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxable?: boolean;
  sortOrder?: number;
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
  const [estimateLookupStatus, setEstimateLookupStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [estimateInfo, setEstimateInfo] = useState<{ estimateNumber: string; totalCents: number } | null>(null);
  // Tracks fields that the prior successful estimate lookup auto-populated.
  // On a subsequent failed lookup we clear those fields so the form can't be
  // submitted with stale scope from the old estimate.
  const autofilledFromEstimateRef = useRef<{ jobIdFromEstimate: boolean; itemCount: number } | null>(null);

  // Auto-populate line items when a valid estimate ID is entered
  useEffect(() => {
    const id = form.estimateId.trim();
    if (!id || id.length < 10) {
      setEstimateLookupStatus('idle');
      setEstimateInfo(null);
      autofilledFromEstimateRef.current = null;
      return;
    }
    let cancelled = false;
    setEstimateLookupStatus('loading');
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/estimates/${id}`);
        if (!res.ok) {
          if (cancelled) return;
          setEstimateLookupStatus('error');
          setEstimateInfo(null);
          const prior = autofilledFromEstimateRef.current;
          if (prior) {
            setForm((prev) => ({
              ...prev,
              jobId: prior.jobIdFromEstimate ? '' : prev.jobId,
              items: prev.items.length === prior.itemCount ? [emptyDraft()] : prev.items,
            }));
            autofilledFromEstimateRef.current = null;
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const items: LineItemDraft[] = (data.lineItems ?? []).map((li: ApiEstimateLineItem) => ({
          id: li.id,
          description: li.description,
          quantity: String(li.quantity),
          unitPriceDollars: (li.unitPriceCents / 100).toFixed(2),
          taxable: li.taxable ?? false,
        }));
        let jobIdFromEstimate = false;
        setForm((prev) => {
          const nextJobId = prev.jobId || data.jobId || '';
          jobIdFromEstimate = !prev.jobId && !!data.jobId;
          return {
            ...prev,
            jobId: nextJobId,
            items: items.length > 0 ? items : prev.items,
          };
        });
        autofilledFromEstimateRef.current = { jobIdFromEstimate, itemCount: items.length };
        setEstimateInfo({
          estimateNumber: data.estimateNumber,
          totalCents: data.totals?.totalCents ?? data.totalCents ?? 0,
        });
        setEstimateLookupStatus('loaded');
      } catch {
        if (!cancelled) setEstimateLookupStatus('error');
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.estimateId]);

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
          <div className="relative">
            <input
              value={form.estimateId}
              onChange={(e) =>
                setForm((p) => ({ ...p, estimateId: e.target.value }))
              }
              className={inputCls}
              placeholder="estimate-uuid (auto-fills line items)"
            />
            {estimateLookupStatus === 'loading' && (
              <Loader size={13} className="absolute right-2.5 top-2.5 animate-spin text-slate-400" />
            )}
          </div>
          {estimateLookupStatus === 'loaded' && estimateInfo && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">
              <FileText size={11} />
              {estimateInfo.estimateNumber} — ${(estimateInfo.totalCents / 100).toFixed(2)} loaded
            </div>
          )}
          {estimateLookupStatus === 'error' && (
            <span className="text-xs text-red-500 mt-0.5 block">Estimate not found</span>
          )}
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
