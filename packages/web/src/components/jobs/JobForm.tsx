import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { CustomerPicker, CustomerOption } from '../forms/CustomerPicker';
import { Input, Textarea, Select, Field, Button } from '../ui';

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
      <h1 className="text-lg text-foreground mb-4">New Job</h1>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {/* Customer is a composite control, so it carries its own label
            rather than a Field-injected id. */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Customer *</label>
          <CustomerPicker
            value={form.customer}
            onChange={(c) => setForm((p) => ({ ...p, customer: c, locationId: '' }))}
            required
          />
        </div>

        <Field label="Service location *">
          <Select
            value={form.locationId}
            onChange={(e) => setForm((p) => ({ ...p, locationId: e.target.value }))}
            disabled={!form.customer || locationsLoading}
            className="min-h-11"
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
          </Select>
        </Field>

        <Field label="Summary *">
          <Input
            value={form.summary}
            onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))}
            className="min-h-11"
          />
        </Field>

        <Field label="Problem description">
          <Textarea
            value={form.problemDescription}
            onChange={(e) =>
              setForm((p) => ({ ...p, problemDescription: e.target.value }))
            }
            rows={4}
            className="min-h-11"
          />
        </Field>

        <Field label="Priority">
          <Select
            value={form.priority}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                priority: e.target.value as State['priority'],
              }))
            }
            className="min-h-11"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={submitting} className="min-h-11">
          {submitting ? 'Creating...' : 'Create job'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11">
          Cancel
        </Button>
      </div>
    </form>
  );
}
