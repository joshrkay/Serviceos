import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';
import { LanguageBadge } from '../../components/customers/LanguageBadge';
import { formatCurrency } from '../../utils/currency';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Select,
  Spinner,
  Textarea,
  type BadgeVariant,
} from '../../components/ui';

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

const STAGE_VARIANT: Record<string, BadgeVariant> = {
  new: 'neutral',
  contacted: 'info',
  qualified: 'info',
  quoted: 'warning',
  won: 'success',
  lost: 'danger',
};

export function LeadDetail({ leadId, onConverted, onBack }: LeadDetailProps) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [loseReason, setLoseReason] = useState('');
  const [showLose, setShowLose] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [language, setLanguage] = useState('');
  const [languageSaving, setLanguageSaving] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${leadId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setLead(json);
      setNoteText(json.notes ?? '');
      setLanguage(json.preferredLanguage ?? '');
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
      toast.success('Lead converted to customer');
      onConverted?.(json.customer.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to convert';
      setError(message);
      toast.error(message);
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
      toast.success('Lead marked lost');
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to mark lost';
      setError(message);
      toast.error(message);
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
      toast.success('Lead note saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save note';
      setError(message);
      toast.error(message);
    } finally {
      setSavingNote(false);
    }
  }, [leadId, noteText]);

  // P11-002: persist the spoken-language preference (previously a dead
  // control). The leads update schema now accepts `preferredLanguage`.
  const handleLanguageChange = useCallback(
    async (next: string) => {
      const previous = language;
      setLanguage(next);
      setLanguageSaving(true);
      try {
        const res = await apiFetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ preferredLanguage: next || null }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success('Language preference saved');
        await refetch();
      } catch (err) {
        setLanguage(previous);
        toast.error(err instanceof Error ? err.message : 'Failed to save language');
      } finally {
        setLanguageSaving(false);
      }
    },
    [leadId, language, refetch],
  );

  if (isLoading && !lead)
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-slate-500">
        <Spinner size="sm" className="text-slate-400" /> Loading...
      </p>
    );
  if (!lead && error)
    return (
      <div className="p-6">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  if (!lead) return null;

  const displayName = `${lead.firstName} ${lead.lastName}`.trim() || lead.companyName || 'Unnamed lead';
  const alreadyConverted = Boolean(lead.convertedCustomerId);

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        leftIcon={<ArrowLeft size={14} />}
        className="mb-3 px-2"
      >
        Back
      </Button>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-slate-900">{displayName}</h1>
        <Badge variant={STAGE_VARIANT[lead.stage] ?? 'neutral'} className="capitalize">
          {lead.stage}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-slate-500">Source: {lead.source}</p>

      {error && (
        <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            <p className="text-sm text-slate-700">Email: {lead.email ?? '—'}</p>
            <p className="text-sm text-slate-700">Phone: {lead.primaryPhone ?? '—'}</p>
            {lead.companyName && (
              <p className="text-sm text-slate-700">Company: {lead.companyName}</p>
            )}
            {/* P11-002: preferred-language signal, now persisted on change. */}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-sm text-slate-700">Language:</span>
              <LanguageBadge language={(language || null) as 'en' | 'es' | null} />
              <div className="w-32">
                <Select
                  aria-label="Preferred language"
                  value={language}
                  disabled={languageSaving}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                >
                  <option value="">—</option>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            <p className="text-sm text-slate-700">Source detail: {lead.sourceDetail ?? '—'}</p>
            <p className="text-sm text-slate-700">
              Est. value:{' '}
              {lead.estimatedValueCents !== undefined
                ? formatCurrency(lead.estimatedValueCents)
                : '—'}
            </p>
            <p className="text-sm text-slate-700">Assigned user: {lead.assignedUserId ?? '—'}</p>
            {lead.lostReason && (
              <p className="mt-2 text-sm text-red-700">Lost reason: {lead.lostReason}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {lead.notes ? (
              <p className="whitespace-pre-wrap text-sm text-slate-700">{lead.notes}</p>
            ) : (
              <p className="text-sm text-slate-400">No notes yet.</p>
            )}
            <Field label="Lead notes">
              <Textarea
                aria-label="Lead notes"
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                rows={3}
              />
            </Field>
            <div>
              <Button size="sm" loading={savingNote} onClick={handleSaveNote}>
                Save note
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {alreadyConverted && lead.convertedCustomerId && (
          <a
            href={`/customers/${lead.convertedCustomerId}`}
            className="inline-flex h-8 items-center rounded-lg border border-blue-200 px-3 text-xs font-medium text-blue-600 hover:bg-blue-50"
          >
            View customer
          </a>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={alreadyConverted}
          onClick={() => setConfirmOpen(true)}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {alreadyConverted ? 'Converted' : 'Convert to Customer'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={lead.stage === 'lost' || alreadyConverted}
          onClick={() => setShowLose(true)}
          className="border-red-200 text-red-600 hover:bg-red-50"
        >
          Mark as Lost
        </Button>
      </div>

      {confirmOpen && (
        <Card
          role="dialog"
          aria-label="Confirm conversion"
          className="mt-4"
        >
          <CardContent className="py-4">
            <p className="text-sm text-slate-700">
              Convert <strong>{displayName}</strong> into a customer? This will create a customer record,
              mark the lead as Won, and write audit events on both.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                loading={converting}
                onClick={handleConvert}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={converting}
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showLose && (
        <Card role="dialog" aria-label="Mark lead lost" className="mt-4">
          <CardContent className="py-4">
            <Field label="Reason (required)">
              <Textarea
                aria-label="Lost reason"
                value={loseReason}
                onChange={(e) => setLoseReason(e.target.value)}
                rows={3}
              />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="danger"
                onClick={handleLose}
              >
                Mark Lost
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowLose(false);
                  setLoseReason('');
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
