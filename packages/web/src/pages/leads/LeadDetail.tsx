import React, { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { LanguageBadge } from '../../components/customers/LanguageBadge';
import { formatCurrency } from '../../utils/currency';

interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source: string;
  sourceDetail?: string;
  stage: string;
  estimatedValueCents?: number;
  notes?: string;
  assignedUserId?: string;
  convertedCustomerId?: string;
  lostReason?: string;
  /** P11-002: optional spoken-language preference. */
  preferredLanguage?: 'en' | 'es' | null;
}

interface ConvertResponse {
  lead: Lead;
  customer: { id: string };
}

export interface LeadDetailProps {
  leadId: string;
  /** Called after successful conversion with the new customer id. */
  onConverted?: (customerId: string) => void;
  onBack?: () => void;
}

export function LeadDetail({ leadId, onConverted, onBack }: LeadDetailProps) {
  const apiFetch = useApiClient();
  const [lead, setLead] = useState<Lead | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [loseReason, setLoseReason] = useState('');
  const [showLose, setShowLose] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${leadId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setLead(json);
      setNoteText(json.notes ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lead');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const handleConvert = useCallback(async () => {
    setConverting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${leadId}/convert`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ConvertResponse;
      setConfirmOpen(false);
      onConverted?.(json.customer.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to convert');
    } finally {
      setConverting(false);
    }
  }, [leadId, onConverted]);

  const handleLose = useCallback(async () => {
    if (!loseReason.trim()) {
      setError('A reason is required.');
      return;
    }
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${leadId}/lose`, {
        method: 'POST',
        body: JSON.stringify({ reason: loseReason.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShowLose(false);
      setLoseReason('');
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark lost');
    }
  }, [leadId, loseReason, refetch]);

  const handleSaveNote = useCallback(async () => {
    setSavingNote(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: noteText.trim() || '' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      setLead(updated);
      setNoteText(updated.notes ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setSavingNote(false);
    }
  }, [leadId, noteText]);

  if (isLoading && !lead) return <p className="p-6 text-sm text-slate-500">Loading...</p>;
  if (!lead && error) return (
    <div className="p-6">
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
    </div>
  );
  if (!lead) return null;

  const displayName = `${lead.firstName} ${lead.lastName}`.trim() || lead.companyName || 'Unnamed lead';
  const alreadyConverted = Boolean(lead.convertedCustomerId);

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-slate-500 hover:text-slate-700 mb-3"
      >
        ← Back
      </button>

      <h1 className="text-lg text-slate-900">{displayName}</h1>
      <p className="text-xs text-slate-500 mt-1">Stage: <span className="text-slate-700">{lead.stage}</span> · Source: {lead.source}</p>

      {error && (
        <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500 mb-2">Contact</p>
        <p className="text-sm text-slate-700">Email: {lead.email ?? '—'}</p>
        <p className="text-sm text-slate-700">Phone: {lead.primaryPhone ?? '—'}</p>
        {lead.companyName && <p className="text-sm text-slate-700">Company: {lead.companyName}</p>}
        {/* P11-002: surface preferred-language signal alongside contact info. */}
        <p className="text-sm text-slate-700 flex items-center gap-2">
          <span>Language:</span>
          <LanguageBadge language={lead.preferredLanguage ?? null} />
          <select
            aria-label="Preferred language"
            defaultValue={lead.preferredLanguage ?? ''}
            className="rounded border px-1 py-0.5 text-xs"
          >
            <option value="">—</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </p>
      </section>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500 mb-2">Pipeline</p>
        <p className="text-sm text-slate-700">Source detail: {lead.sourceDetail ?? '—'}</p>
        <p className="text-sm text-slate-700">
          Est. value: {lead.estimatedValueCents !== undefined
            ? formatCurrency(lead.estimatedValueCents)
            : '—'}
        </p>
        <p className="text-sm text-slate-700">Assigned user: {lead.assignedUserId ?? '—'}</p>
        {lead.lostReason && (
          <p className="text-sm text-red-700 mt-2">Lost reason: {lead.lostReason}</p>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500 mb-2">Notes</p>
        {lead.notes ? (
          <p className="mb-3 text-sm text-slate-700 whitespace-pre-wrap">{lead.notes}</p>
        ) : (
          <p className="mb-3 text-sm text-slate-500">No notes yet.</p>
        )}
        <label className="block text-xs text-slate-500">
          Lead notes
          <textarea
            aria-label="Lead notes"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={savingNote}
          onClick={handleSaveNote}
          className="mt-2 rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {savingNote ? 'Saving...' : 'Save note'}
        </button>
      </section>

      <div className="mt-5 flex flex-wrap gap-2">
        {alreadyConverted && lead.convertedCustomerId && (
          <a
            href={`/customers/${lead.convertedCustomerId}`}
            className="rounded-lg border border-blue-200 text-blue-600 text-sm px-4 py-2 hover:bg-blue-50"
          >
            View customer
          </a>
        )}
        <button
          type="button"
          disabled={alreadyConverted}
          onClick={() => setConfirmOpen(true)}
          className="rounded-lg bg-blue-600 text-white text-sm px-4 py-2 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {alreadyConverted ? 'Converted' : 'Convert to Customer'}
        </button>
        <button
          type="button"
          disabled={lead.stage === 'lost' || alreadyConverted}
          onClick={() => setShowLose(true)}
          className="rounded-lg border border-red-200 text-red-600 text-sm px-4 py-2 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Mark as Lost
        </button>
      </div>

      {confirmOpen && (
        <div role="dialog" aria-label="Confirm conversion" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">
            Convert <strong>{displayName}</strong> into a customer? This will create a customer record,
            mark the lead as Won, and write audit events on both.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={converting}
              onClick={handleConvert}
              className="rounded-lg bg-blue-600 text-white text-sm px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
            >
              {converting ? 'Converting...' : 'Confirm'}
            </button>
            <button
              type="button"
              disabled={converting}
              onClick={() => setConfirmOpen(false)}
              className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showLose && (
        <div role="dialog" aria-label="Mark lead lost" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500 mb-2">Reason (required)</p>
          <textarea
            aria-label="Lost reason"
            value={loseReason}
            onChange={(e) => setLoseReason(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleLose}
              className="rounded-lg bg-red-600 text-white text-sm px-4 py-2 hover:bg-red-700"
            >
              Mark Lost
            </button>
            <button
              type="button"
              onClick={() => { setShowLose(false); setLoseReason(''); }}
              className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
