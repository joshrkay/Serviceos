import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { CustomerPicker, CustomerOption } from '../forms/CustomerPicker';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export interface JobFormProps {
  onCreated?: (jobId: string) => void;
  onCancel?: () => void;
}

interface State {
  customer: CustomerOption | null;
  locationId: string;
  summary: string;
  problemDescription: string;
  priority: typeof PRIORITIES[number];
}

interface ServiceLocationOption {
  id: string;
  label?: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
}

const initial: State = {
  customer: null,
  locationId: '',
  summary: '',
  problemDescription: '',
  priority: 'normal',
};

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

export function JobForm({ onCreated, onCancel }: JobFormProps) {
  const [form, setForm] = useState<State>(initial);
  const [locations, setLocations] = useState<ServiceLocationOption[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!form.customer) {
      setLocations([]);
      setForm((previous) => ({ ...previous, locationId: '' }));
      return;
    }
    setLocationsLoading(true);
    (async () => {
      try {
        const res = await apiFetch(`/api/locations?customerId=${encodeURIComponent(form.customer!.id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ServiceLocationOption[];
        if (cancelled) return;
        setLocations(data);
        const primary = data.find((location) => location.isPrimary) ?? data[0];
        setForm((previous) => ({
          ...previous,
          locationId: primary?.id ?? '',
        }));
      } catch {
        if (!cancelled) {
          setLocations([]);
          setForm((previous) => ({ ...previous, locationId: '' }));
        }
      } finally {
        if (!cancelled) setLocationsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.customer]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!form.customer) {
        setError('Customer is required.');
        return;
      }
      if (!form.locationId.trim()) {
        setError('Service location is required.');
        return;
      }
      if (!form.summary.trim()) {
        setError('Summary is required.');
        return;
      }

      const body = {
        customerId: form.customer.id,
        locationId: form.locationId.trim(),
        summary: form.summary.trim(),
        problemDescription: form.problemDescription.trim() || undefined,
        priority: form.priority,
      };

      setSubmitting(true);
      try {
        const res = await apiFetch('/api/jobs', {
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
        setError(err instanceof Error ? err.message : 'Failed to create job');
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-2xl mx-auto">
      <h1 className="text-lg text-slate-900 mb-4">New Job</h1>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="text-xs text-slate-500">Customer *</label>
          <CustomerPicker
            value={form.customer}
            onChange={(c) => setForm((p) => ({ ...p, customer: c, locationId: '' }))}
            required
          />
        </div>
        <label className="text-xs text-slate-500">
          Service location *
          <select
            value={form.locationId}
            onChange={(e) =>
              setForm((p) => ({ ...p, locationId: e.target.value }))
            }
            disabled={!form.customer || locationsLoading}
            className={inputCls}
          >
            <option value="">
              {locationsLoading ? 'Loading locations...' : 'Select a service location'}
            </option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label || location.street1}
                {location.isPrimary ? ' (Primary)' : ''} - {location.street1}, {location.city}, {location.state} {location.postalCode}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Summary *
          <input
            value={form.summary}
            onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Problem description
          <textarea
            value={form.problemDescription}
            onChange={(e) =>
              setForm((p) => ({ ...p, problemDescription: e.target.value }))
            }
            rows={4}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Priority
          <select
            value={form.priority}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                priority: e.target.value as State['priority'],
              }))
            }
            className={inputCls}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create job'}
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
