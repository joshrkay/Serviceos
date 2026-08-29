import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
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
  /**
   * #876: pre-select this job (from /estimates/new?jobId=…). The existing
   * enrichment effect then fetches the job's customer + location for display.
   */
  initialJobId?: string;
  /**
   * #876: scope the job dropdown to this customer's jobs (from
   * /estimates/new?customerId=…) and show an honest empty state when the
   * customer has none — estimates scope by job, so a job must exist first.
   */
  initialCustomerId?: string;
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

// Line item returned by POST /api/estimates/suggest (estimate task contract,
// packages/api/src/ai/tasks/estimate-task.ts — same shape NewEstimateFlow
// consumes). `unitPrice` is INTEGER CENTS; `category` is a free string.
interface SuggestedLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  category?: string;
}

const DRAFT_CATEGORIES: ReadonlyArray<NonNullable<LineItemDraft['category']>> = [
  'labor',
  'material',
  'equipment',
  'other',
];

/** Map the suggest contract's free-string category onto the editor's union. */
function toDraftCategory(category?: string): LineItemDraft['category'] {
  const normalized = category?.toLowerCase();
  return DRAFT_CATEGORIES.find((c) => c === normalized);
}

function makeId() {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export function EstimateForm({
  onCreated,
  onCancel,
  initialJobId,
  initialCustomerId,
}: EstimateFormProps) {
  const [form, setForm] = useState<State>(() => ({
    jobId: initialJobId ?? '',
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
  const [aiError, setAiError] = useState<string | null>(null);

  // #876: a ?customerId= deep link narrows the dropdown to that customer's
  // jobs (the endpoint already supports the filter — no API change).
  const { data: jobs, isLoading: jobsLoading } = useListQuery<ApiJob>('/api/jobs', {
    filters: initialCustomerId ? { customerId: initialCustomerId } : {},
  });

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
    setAiError(null);
  }

  // POST to the real /api/estimates/suggest endpoint (same authenticated
  // client + request/response contract as NewEstimateFlow.suggestEstimate).
  // The server invokes EstimateTaskHandler with catalog-grounded pricing and
  // persists the proposal as a forced DRAFT — previewing a suggestion never
  // writes a real estimate. On ANY failure we surface a visible error; there
  // is no canned fallback list (fail closed, no invented prices).
  async function handleAiSuggest() {
    const description = [selectedJob?.summary, form.customerMessage, form.internalNotes]
      .map(s => s?.trim())
      .filter(Boolean)
      .join('\n');
    if (!description) {
      setAiError('Select a job or add a customer message / internal notes so AI has context to suggest from.');
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await apiFetch('/api/estimates/suggest', {
        method: 'POST',
        body: JSON.stringify({
          description,
          // The suggest schema accepts jobId for grounding (ownership-checked
          // server-side); the selected job is this form's context.
          ...(form.jobId.trim() ? { jobId: form.jobId.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `AI suggestion failed (${res.status})`);
      }
      const data = await res.json() as { lineItems?: SuggestedLineItem[] };
      const suggested: LineItemDraft[] = (data.lineItems ?? []).map(li => ({
        id: makeId(),
        description: li.description,
        quantity: String(li.quantity),
        // unitPrice is INTEGER CENTS (estimate task contract) — the editor
        // holds a dollars string and re-converts to cents on submit.
        unitPriceDollars: (li.unitPrice / 100).toFixed(2),
        taxable: false,
        category: toDraftCategory(li.category),
      }));
      if (suggested.length === 0) {
        throw new Error('AI returned no line items. Add more detail and try again, or build the estimate manually.');
      }
      setForm(p => {
        // Drop untouched blank rows (the fresh form's sole empty draft) so
        // suggestions aren't trailed by a row that fails submit validation.
        const kept = p.items.filter(it => it.description.trim() !== '');
        return { ...p, items: [...kept, ...suggested] };
      });
      setAiUsed(true);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI suggestion failed. Try again or build the estimate manually.');
    } finally {
      setAiLoading(false);
    }
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
      <h1 className="text-foreground mb-4">New Estimate</h1>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {activeContract && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3">
          <p className="text-sm text-primary">
            <strong>Active maintenance contract:</strong> {activeContract.name}
            {activeContract.recurrenceRule && (
              <span className="text-primary ml-1">
                ({activeContract.recurrenceRule.includes('MONTHLY') ? 'Monthly' :
                  activeContract.recurrenceRule.includes('QUARTERLY') ? 'Quarterly' :
                  activeContract.recurrenceRule.includes('YEARLY') ? 'Yearly' : activeContract.recurrenceRule})
              </span>
            )}
          </p>
          <p className="text-xs text-primary mt-1">
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

        {/* #876: a customer-scoped deep link with zero jobs used to render a
            silent empty dropdown — say so, and offer the next step. */}
        {initialCustomerId && !jobsLoading && jobs.length === 0 && (
          <div
            data-testid="no-jobs-empty-state"
            className="md:col-span-2 rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
          >
            This customer has no jobs yet — an estimate needs a job to scope to.{' '}
            <Link
              to={`/jobs/new?customerId=${encodeURIComponent(initialCustomerId)}`}
              className="inline-flex min-h-11 items-center text-primary underline"
            >
              Create a job for this customer
            </Link>
          </div>
        )}

        {/* Customer & service location (auto-populated) */}
        {selectedJob && (
          <div className="md:col-span-2 rounded-lg bg-secondary border border-border px-3 py-2.5 text-sm text-foreground space-y-0.5">
            {customerName && (
              <p><span className="text-xs text-muted-foreground">Customer:</span> {customerName}</p>
            )}
            {serviceAddress && (
              <p><span className="text-xs text-muted-foreground">Service address:</span> {serviceAddress}</p>
            )}
            {!serviceAddress && (
              <p className="text-xs text-warning">⚠ No service location linked to this job</p>
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
          <span className="text-xs text-muted-foreground font-medium">Line items</span>
          <Button
            type="button"
            size="sm"
            onClick={handleAiSuggest}
            loading={aiLoading}
            disabled={aiLoading || aiUsed}
            leftIcon={<Sparkles size={12} />}
            className="bg-primary hover:bg-primary"
          >
            {aiLoading ? 'Generating...' : aiUsed ? 'Suggestions added' : 'AI Suggestions'}
          </Button>
        </div>
        {aiError && (
          <div
            role="alert"
            className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {aiError}
          </div>
        )}
        <LineItemEditor
          items={form.items}
          onChange={(items) => setForm((p) => ({ ...p, items }))}
          enableOptions
          enableCatalog
        />
        {total > 0 && (
          <div className="mt-3 flex justify-end">
            <p className="text-sm font-medium text-foreground">
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
