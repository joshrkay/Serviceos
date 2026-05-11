import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import {
  LineItemEditor,
  LineItemDraft,
  emptyDraft,
  toLineItemPayload,
} from '../forms/LineItemEditor';

export interface EstimateFormProps {
  onCreated?: (estimateId: string) => void;
  onCancel?: () => void;
}

interface State {
  jobId: string;
  validUntil: string;
  customerMessage: string;
  internalNotes: string;
  discountDollars: string;
  taxRatePercent: string;
  items: LineItemDraft[];
}

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

export function EstimateForm({ onCreated, onCancel }: EstimateFormProps) {
  const [form, setForm] = useState<State>(() => ({
    jobId: '',
    validUntil: '',
    customerMessage: '',
    internalNotes: '',
    discountDollars: '',
    taxRatePercent: '',
    items: [emptyDraft()],
  }));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeContract, setActiveContract] = useState<{ id: string; name: string; recurrenceRule?: string } | null>(null);
  const jobIdLookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When job ID is entered, look up active agreements for the associated customer.
  // `cancelled` guards against state updates after unmount or a newer jobId.
  useEffect(() => {
    if (jobIdLookupTimer.current) clearTimeout(jobIdLookupTimer.current);
    const jobId = form.jobId.trim();
    if (!jobId) { setActiveContract(null); return; }
    let cancelled = false;
    jobIdLookupTimer.current = setTimeout(async () => {
      try {
        const jobRes = await apiFetch(`/api/jobs/${jobId}`);
        if (cancelled || !jobRes.ok) return;
        const job = await jobRes.json() as { customerId?: string };
        if (cancelled || !job.customerId) return;
        const agRes = await apiFetch(`/api/agreements?customerId=${job.customerId}&status=active`);
        if (cancelled || !agRes.ok) return;
        const data = await agRes.json() as { data?: Array<{ id: string; name: string; recurrenceRule?: string }> };
        const contracts = data.data ?? [];
        if (!cancelled) setActiveContract(contracts.length > 0 ? contracts[0] : null);
      } catch {
        if (!cancelled) setActiveContract(null);
      }
    }, 600);
    return () => {
      cancelled = true;
      if (jobIdLookupTimer.current) clearTimeout(jobIdLookupTimer.current);
    };
  }, [form.jobId]);

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

      let validUntilIso: string | undefined;
      if (form.validUntil) {
        const d = new Date(form.validUntil);
        if (Number.isNaN(d.getTime())) {
          setError('Invalid valid-until date.');
          return;
        }
        validUntilIso = d.toISOString();
      }

      const body = {
        jobId: form.jobId.trim(),
        lineItems,
        discountCents,
        taxRateBps,
        validUntil: validUntilIso,
        customerMessage: form.customerMessage.trim() || undefined,
        internalNotes: form.internalNotes.trim() || undefined,
      };

      setSubmitting(true);
      try {
        const res = await apiFetch('/api/estimates', {
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
        setError(err instanceof Error ? err.message : 'Failed to create estimate');
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-lg text-slate-900 mb-4">New Estimate</h1>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {activeContract && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-sm text-blue-800">
            <strong>Active maintenance contract:</strong> {activeContract.name}
            {activeContract.recurrenceRule && (
              <span className="text-blue-600 ml-1">
                ({activeContract.recurrenceRule.includes('MONTHLY') ? 'Monthly' :
                  activeContract.recurrenceRule.includes('QUARTERLY') ? 'Quarterly' :
                  activeContract.recurrenceRule.includes('YEARLY') ? 'Yearly' : activeContract.recurrenceRule})
              </span>
            )}
          </p>
          <p className="text-xs text-blue-600 mt-1">
            Service call fee may be waived under this plan. Consider adding a plan-specific line item.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-500 md:col-span-2">
          Job ID *
          <input
            value={form.jobId}
            onChange={(e) => setForm((p) => ({ ...p, jobId: e.target.value }))}
            className={inputCls}
            placeholder="job-id-uuid"
          />
        </label>
        <label className="text-xs text-slate-500">
          Valid until
          <input
            type="date"
            value={form.validUntil}
            onChange={(e) =>
              setForm((p) => ({ ...p, validUntil: e.target.value }))
            }
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
        <label className="text-xs text-slate-500">
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
        <label className="text-xs text-slate-500">
          Internal notes
          <textarea
            value={form.internalNotes}
            onChange={(e) =>
              setForm((p) => ({ ...p, internalNotes: e.target.value }))
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
          {submitting ? 'Creating...' : 'Create estimate'}
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
