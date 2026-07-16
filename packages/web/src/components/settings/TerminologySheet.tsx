/**
 * Terminology editor — customize CRM entity labels for the tenant
 * (e.g. "Quote" instead of "Estimate", "Project" instead of "Job").
 *
 * Backend: PUT /api/settings { terminologyPreferences: {...} }. The
 * validator accepts an entity-label allowlist
 * (ENTITY_LABEL_TERMINOLOGY_KEYS in packages/api/src/settings/settings.ts)
 * regardless of which vertical packs are active, so this sheet works
 * for every tenant.
 *
 * Per-vertical equipment terminology (furnace ↔ heater) is a separate
 * concern handled by the vertical pack — not edited here.
 */
import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface TerminologyFields {
  estimateTerm: string;
  invoiceTerm: string;
  jobTerm: string;
  customerTerm: string;
  appointmentTerm: string;
  workerTerm: string;
}

const FIELDS: Array<{
  key: keyof TerminologyFields;
  label: string;
  defaultValue: string;
  hint: string;
}> = [
  { key: 'estimateTerm',    label: 'Estimate',    defaultValue: 'Estimate',    hint: 'Many shops prefer "Quote" or "Bid".' },
  { key: 'invoiceTerm',     label: 'Invoice',     defaultValue: 'Invoice',     hint: 'Some prefer "Bill" or "Statement".' },
  { key: 'jobTerm',         label: 'Job',         defaultValue: 'Job',         hint: 'Construction shops often use "Project".' },
  { key: 'customerTerm',    label: 'Customer',    defaultValue: 'Customer',    hint: '"Client" is common for B2B.' },
  { key: 'appointmentTerm', label: 'Appointment', defaultValue: 'Appointment', hint: '"Visit" or "Service call" both work.' },
  { key: 'workerTerm',      label: 'Technician',  defaultValue: 'Technician',  hint: '"Tech", "Pro", "Plumber" — whatever you call them.' },
];

const EMPTY: TerminologyFields = {
  estimateTerm: '',
  invoiceTerm: '',
  jobTerm: '',
  customerTerm: '',
  appointmentTerm: '',
  workerTerm: '',
};

interface TerminologySheetProps {
  onClose: () => void;
}

export function TerminologySheet({ onClose }: TerminologySheetProps) {
  const [fields, setFields] = useState<TerminologyFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as {
          terminologyPreferences?: Record<string, string>;
        };
        if (cancelled) return;
        const prefs = data.terminologyPreferences ?? {};
        setFields({
          estimateTerm:    prefs.estimateTerm    ?? '',
          invoiceTerm:     prefs.invoiceTerm     ?? '',
          jobTerm:         prefs.jobTerm         ?? '',
          customerTerm:    prefs.customerTerm    ?? '',
          appointmentTerm: prefs.appointmentTerm ?? '',
          workerTerm:      prefs.workerTerm      ?? '',
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load terminology');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setError('');
    setSaving(true);
    // Send only fields the user actually filled in. Empty strings mean
    // "use the default", so we skip them — the backend treats absent
    // keys as no-override.
    const terminologyPreferences: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = fields[f.key].trim();
      if (v.length > 0) terminologyPreferences[f.key] = v;
    }
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminologyPreferences }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      toast.success('Terminology saved');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="terminology-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <FileText size={16} className="text-slate-700" />
          </span>
          <h2 id="terminology-title" className="flex-1 text-base text-slate-900">
            Terminology
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Customize how Rivet refers to common CRM entities. Leave a field
            blank to use the default. Equipment terms (Furnace, AC, etc.) are
            managed by your vertical pack and are not edited here.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            FIELDS.map((f) => (
              <label key={f.key} htmlFor={`term-${f.key}`} className="block">
                <span className="text-sm text-slate-700">
                  {f.label} <span className="text-slate-400">→ default: "{f.defaultValue}"</span>
                </span>
                <input
                  id={`term-${f.key}`}
                  type="text"
                  value={fields[f.key]}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.defaultValue}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
                <span className="block text-xs text-slate-400 mt-1">{f.hint}</span>
              </label>
            ))
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
