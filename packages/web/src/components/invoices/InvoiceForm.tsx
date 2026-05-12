import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Loader } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import {
  LineItemEditor,
  LineItemDraft,
  emptyDraft,
  toLineItemPayload,
  totalCents,
} from '../forms/LineItemEditor';
import { useListQuery } from '../../hooks/useListQuery';

export interface InvoiceFormProps {
  onCreated?: (invoiceId: string) => void;
  onCancel?: () => void;
}

interface ApiJob {
  id: string;
  jobNumber: string;
  summary: string;
  customerId?: string;
  customer?: {
    id: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
  };
  location?: {
    street1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    isPrimary?: boolean;
    label?: string;
  };
}

interface ApiEstimate {
  id: string;
  estimateNumber: string;
  status: string;
  jobId: string;
  lineItems?: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    taxable: boolean;
    category?: string;
  }>;
  totals?: { totalCents: number };
}

interface State {
  jobId: string;
  estimateId: string;
  dueDate: string;
  customerMessage: string;
  discountDollars: string;
  taxRatePercent: string;
  items: LineItemDraft[];
}

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

function makeId() {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

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
  const [selectedJob, setSelectedJob] = useState<ApiJob | null>(null);

  const { data: jobs } = useListQuery<ApiJob>('/api/jobs');
  const { data: estimates } = useListQuery<ApiEstimate>('/api/estimates');

  // Estimates that can be used for invoicing (any status)
  const eligibleEstimates = estimates.filter(
    e => ['draft', 'sent', 'accepted', 'approved'].includes(e.status)
  );

  // When a job is selected, fetch enriched job data (customer + location)
  useEffect(() => {
    if (!form.jobId) { setSelectedJob(null); return; }
    apiFetch(`/api/jobs/${form.jobId}`)
      .then(r => r.ok ? r.json() as Promise<ApiJob> : null)
      .then((j: ApiJob | null) => j ? setSelectedJob(j) : null)
      .catch(() => null);
  }, [form.jobId]);

  // When an estimate is selected, auto-populate job and line items
  const handleEstimateChange = async (estimateId: string) => {
    setForm(p => ({ ...p, estimateId }));
    if (!estimateId) return;

    // Find estimate in list first (has basic data)
    const est = estimates.find(e => e.id === estimateId);
    if (est?.jobId) {
      setForm(p => ({ ...p, jobId: est.jobId }));
    }

    // Fetch full estimate details for line items
    try {
      const res = await apiFetch(`/api/estimates/${estimateId}`);
      if (!res.ok) return;
      const full: ApiEstimate = await res.json();
      if (full.lineItems && full.lineItems.length > 0) {
        const mapped: LineItemDraft[] = full.lineItems.map(li => ({
          id: makeId(),
          description: li.description,
          quantity: String(li.quantity),
          unitPriceDollars: (li.unitPriceCents / 100).toFixed(2),
          taxable: li.taxable,
          category: li.category as LineItemDraft['category'],
        }));
        setForm(p => ({ ...p, items: mapped }));
      }
      if (full.jobId) {
        setForm(p => ({ ...p, jobId: full.jobId }));
      }
    } catch { /* non-fatal */ }
  };

  const serviceAddress = selectedJob?.location
    ? [selectedJob.location.street1, selectedJob.location.city, selectedJob.location.state, selectedJob.location.postalCode]
        .filter(Boolean).join(', ')
    : '';

  const customerName = selectedJob?.customer
    ? (selectedJob.customer.displayName || [selectedJob.customer.firstName, selectedJob.customer.lastName].filter(Boolean).join(' '))
    : '';

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!form.jobId.trim()) {
        setError('Job is required.');
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

      const body = {
        jobId: form.jobId.trim(),
        estimateId: form.estimateId.trim() || undefined,
        lineItems,
        discountCents,
        taxRateBps,
        customerMessage: form.customerMessage.trim() || undefined,
      };

      setSubmitting(true);
      try {
        const res = await apiFetch('/api/invoices', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
        }
        const created = await res.json() as { id: string };
        onCreated?.(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create invoice');
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  const total = totalCents(form.items);
  const totalDisplay = `$${(total / 100).toFixed(2)}`;

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
        {/* Estimate picker (optional — auto-populates job and line items) */}
        <div className="md:col-span-2">
          <label className="text-xs text-slate-500">
            From estimate (optional — auto-populates job &amp; line items)
          </label>
          <select
            value={form.estimateId}
            onChange={(e) => handleEstimateChange(e.target.value)}
            className={inputCls}
          >
            <option value="">— create from scratch —</option>
            {eligibleEstimates.map(e => (
              <option key={e.id} value={e.id}>
                {e.estimateNumber} (${e.totals ? (e.totals.totalCents / 100).toFixed(2) : '—'}) — {e.status}
              </option>
            ))}
          </select>
        </div>

        {/* Job picker */}
        <div className="md:col-span-2">
          <label className="text-xs text-slate-500">Job *</label>
          <select
            value={form.jobId}
            onChange={(e) => setForm(p => ({ ...p, jobId: e.target.value }))}
            className={inputCls}
            required
          >
            <option value="">— select a job —</option>
            {jobs.map(j => (
              <option key={j.id} value={j.id}>
                {j.jobNumber} — {j.summary}
              </option>
            ))}
          </select>
        </div>

        {/* Customer & service location (auto-populated) */}
        {selectedJob && (
          <div className="md:col-span-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm text-slate-700 space-y-0.5">
            {customerName && (
              <p><span className="text-xs text-slate-500">Customer:</span> {customerName}</p>
            )}
            {serviceAddress && (
              <p><span className="text-xs text-slate-500">Service address:</span> {serviceAddress}</p>
            )}
          </div>
        )}

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
            onChange={(e) => setForm((p) => ({ ...p, taxRatePercent: e.target.value }))}
            inputMode="decimal"
            placeholder="0"
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Discount ($)
          <input
            value={form.discountDollars}
            onChange={(e) => setForm((p) => ({ ...p, discountDollars: e.target.value }))}
            inputMode="decimal"
            placeholder="0.00"
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-xs text-slate-500 font-medium mb-2">Line items</p>
        <LineItemEditor
          items={form.items}
          onChange={(items) => setForm((p) => ({ ...p, items }))}
        />
        {total > 0 && (
          <div className="mt-3 flex justify-end">
            <p className="text-sm font-medium text-slate-900">
              Total: <span className="text-lg">{totalDisplay}</span>
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 mt-4">
        <label className="text-xs text-slate-500">
          Customer message
          <textarea
            value={form.customerMessage}
            onChange={(e) => setForm((p) => ({ ...p, customerMessage: e.target.value }))}
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
