/**
 * P9-003 — AgreementCreate page.
 *
 * Form: customer picker, RecurrenceBuilder, price (cents), start/end dates.
 */
import React, { useState } from 'react';
import {
  RecurrenceBuilder,
  RecurrenceBuilderValue,
  buildRule,
} from '../../components/agreements/RecurrenceBuilder';
import { useApiClient } from '../../lib/apiClient';
import { agreementsApi } from '../../api/agreements';

export interface AgreementCreateProps {
  customerId?: string;
  onCreated?: (id: string) => void;
}

export function AgreementCreate({
  customerId: initialCustomerId,
  onCreated,
}: AgreementCreateProps = {}): JSX.Element {
  const apiFetch = useApiClient();
  const [customerId, setCustomerId] = useState(initialCustomerId ?? '');
  const [name, setName] = useState('');
  const [priceDollars, setPriceDollars] = useState('0');
  const [startsOn, setStartsOn] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [endsOn, setEndsOn] = useState('');
  const [recurrence, setRecurrence] = useState<RecurrenceBuilderValue>({
    frequency: 'quarterly',
    interval: 1,
    dayOfMonth: new Date().getUTCDate(),
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const priceCents = Math.round(parseFloat(priceDollars || '0') * 100);
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        throw new Error('Price must be a non-negative number');
      }
      const created = await agreementsApi.create(apiFetch, {
        customerId,
        name,
        recurrenceRule: buildRule(recurrence),
        priceCents,
        startsOn,
        endsOn: endsOn || undefined,
      });
      onCreated?.(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agreement');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">New Service Agreement</h1>
      {error && <div className="text-red-600 text-sm">{error}</div>}
      <label className="flex flex-col text-sm">
        Customer
        <input
          required
          aria-label="Customer ID"
          className="border rounded px-2 py-1"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          placeholder="Customer UUID"
        />
      </label>
      <label className="flex flex-col text-sm">
        Name
        <input
          required
          aria-label="Agreement name"
          className="border rounded px-2 py-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="flex flex-col text-sm">
        Price ($)
        <input
          required
          type="number"
          step="0.01"
          min="0"
          aria-label="Price"
          className="border rounded px-2 py-1"
          value={priceDollars}
          onChange={(e) => setPriceDollars(e.target.value)}
        />
      </label>
      <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />
      <label className="flex flex-col text-sm">
        Starts on
        <input
          required
          type="date"
          aria-label="Starts on"
          className="border rounded px-2 py-1"
          value={startsOn}
          onChange={(e) => setStartsOn(e.target.value)}
        />
      </label>
      <label className="flex flex-col text-sm">
        Ends on (optional)
        <input
          type="date"
          aria-label="Ends on"
          className="border rounded px-2 py-1"
          value={endsOn}
          onChange={(e) => setEndsOn(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create Agreement'}
      </button>
    </form>
  );
}
