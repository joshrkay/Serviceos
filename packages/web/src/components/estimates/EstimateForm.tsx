import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';
import { formatCurrency } from '../../utils/currency';
import {
  LineItemEditor,
  LineItemDraft,
  emptyDraft,
  toLineItemPayload,
  totalCents,
} from '../forms/LineItemEditor';
import { useListQuery } from '../../hooks/useListQuery';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';

export interface EstimateFormProps {
  onCreated?: (estimateId: string) => void;
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
    label?: string;
    isPrimary?: boolean;
  };
}

interface ApiAgreement {
  id: string;
  customerId: string;
  name: string;
  recurrenceRule?: string;
  status: string;
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

const AI_SUGGESTIONS: Record<string, { description: string; qty: string; price: string }[]> = {
  HVAC: [
    { description: 'Labor – 2 hrs at $95/hr', qty: '2', price: '95.00' },
    { description: 'Service call fee', qty: '1', price: '85.00' },
    { description: 'R-410A refrigerant (1 lb)', qty: '1', price: '85.00' },
  ],
  default: [
    { description: 'Labor – 2 hrs', qty: '2', price: '95.00' },
    { description: 'Service call fee', qty: '1', price: '85.00' },
  ],
};

function makeId() {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

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
  const [selectedJob, setSelectedJob] = useState<ApiJob | null>(null);
  const [activeContract, setActiveContract] = useState<ApiAgreement | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);

  const { data: jobs } = useListQuery<ApiJob>('/api/jobs');

  // When the user picks a job, fetch the enriched job detail (customer + location)
  // and look up any active maintenance agreement for that customer.
  useEffect(() => {
    if (!form.jobId) { setSelectedJob(null); setActiveContract(null); return; }
    let cancelled = false;
    apiFetch(`/api/jobs/${form.jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then(async (j: ApiJob | null) => {
        if (cancelled) return;
        setSelectedJob(j);
        const customerId = j?.customerId ?? j?.customer?.id;
        if (!customerId) { setActiveContract(null); return; }
        const r = await apiFetch(`/api/agreements?customerId=${encodeURIComponent(customerId)}&status=active`);
        if (!r.ok) { if (!cancelled) setActiveContract(null); return; }
        const body = await r.json().catch(() => null) as ApiAgreement[] | { data?: ApiAgreement[] } | null;
        const list: ApiAgreement[] = Array.isArray(body) ? body : (body?.data ?? []);
        if (!cancelled) setActiveContract(list[0] ?? null);
      })
      .catch(() => { if (!cancelled) { setSelectedJob(null); setActiveContract(null); } });
    return () => { cancelled = true; };
  }, [form.jobId]);

  const serviceAddress = selectedJob?.location
    ? [selectedJob.location.street1, selectedJob.location.city, selectedJob.location.state, selectedJob.location.postalCode]
        .filter(Boolean).join(', ')
    : '';

  const customerName = selectedJob?.customer
    ? (selectedJob.customer.displayName || [selectedJob.customer.firstName, selectedJob.customer.lastName].filter(Boolean).join(' '))
    : '';

  function handleJobChange(jobId: string) {
    setForm(p => ({ ...p, jobId }));
    setAiUsed(false);
  }

  function handleAiSuggest() {
    setAiLoading(true);
    setTimeout(() => {
      const suggestions = AI_SUGGESTIONS.HVAC;
      const newItems = suggestions.map(s => ({
        id: makeId(),
        description: s.description,
        quantity: s.qty,
        unitPriceDollars: s.price,
        taxable: false,
        category: 'labor' as const,
      }));
      setForm(p => ({ ...p, items: [...p.items, ...newItems] }));
      setAiLoading(false);
      setAiUsed(true);
    }, 1200);
  }

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
          throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
        }
        const created = await res.json() as { id: string };
        toast.success('Estimate created');
        onCreated?.(created.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create estimate';
        setError(message);
        toast.error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  const total = totalCents(form.items);
  const totalDisplay = formatCurrency(total);

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900 mb-4">New Estimate</h1>
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
        {/* Job picker */}
        <Field label="Job *" className="md:col-span-2">
          <Select
            value={form.jobId}
            onChange={(e) => handleJobChange(e.target.value)}
            required
          >
            <option value="">— select a job —</option>
            {jobs.map(j => (
              <option key={j.id} value={j.id}>
                {j.jobNumber} — {j.summary}
              </option>
            ))}
          </Select>
        </Field>

        {/* Customer & service location (auto-populated) */}
        {selectedJob && (
          <div className="md:col-span-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm text-slate-700 space-y-0.5">
            {customerName && (
              <p><span className="text-xs text-slate-500">Customer:</span> {customerName}</p>
            )}
            {serviceAddress && (
              <p><span className="text-xs text-slate-500">Service address:</span> {serviceAddress}</p>
            )}
            {!serviceAddress && (
              <p className="text-xs text-amber-600">⚠ No service location linked to this job</p>
            )}
          </div>
        )}

        <Field label="Valid until">
          <Input
            type="date"
            value={form.validUntil}
            onChange={(e) => setForm((p) => ({ ...p, validUntil: e.target.value }))}
          />
        </Field>
        <Field label="Tax rate (%)">
          <Input
            value={form.taxRatePercent}
            onChange={(e) => setForm((p) => ({ ...p, taxRatePercent: e.target.value }))}
            inputMode="decimal"
            placeholder="0"
          />
        </Field>
        <Field label="Discount ($)">
          <Input
            value={form.discountDollars}
            onChange={(e) => setForm((p) => ({ ...p, discountDollars: e.target.value }))}
            inputMode="decimal"
            placeholder="0.00"
          />
        </Field>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500 font-medium">Line items</span>
          <Button
            type="button"
            size="sm"
            onClick={handleAiSuggest}
            loading={aiLoading}
            disabled={aiLoading || aiUsed}
            leftIcon={<Sparkles size={12} />}
            className="bg-violet-600 hover:bg-violet-700"
          >
            {aiLoading ? 'Generating...' : aiUsed ? 'Suggestions added' : 'AI Suggestions'}
          </Button>
        </div>
        <LineItemEditor
          items={form.items}
          onChange={(items) => setForm((p) => ({ ...p, items }))}
          enableOptions
          enableCatalog
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
        <Field label="Customer message">
          <Textarea
            value={form.customerMessage}
            onChange={(e) => setForm((p) => ({ ...p, customerMessage: e.target.value }))}
            rows={3}
          />
        </Field>
        <Field label="Internal notes">
          <Textarea
            value={form.internalNotes}
            onChange={(e) => setForm((p) => ({ ...p, internalNotes: e.target.value }))}
            rows={3}
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="submit" loading={submitting}>
          Create estimate
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
