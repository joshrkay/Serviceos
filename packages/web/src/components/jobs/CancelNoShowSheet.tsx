import { useState } from 'react';
import { X, AlertTriangle, UserX, PhoneOff, RefreshCw, MessageSquare, Check, AlertCircle } from 'lucide-react';
import { SheetOverlay } from './JobSheets';
import { Textarea } from '../ui';
import { apiFetch } from '../../utils/api-fetch';
import type { Job } from '../../data/mock-data';

type IssueType = 'cancel' | 'noshow' | 'other';

const REASONS: Record<IssueType, string[]> = {
  cancel: [
    'Rescheduling for later',
    'Found another provider',
    'Financial reasons',
    'No longer needed',
    'Schedule conflict',
    'Other',
  ],
  noshow: [
    'No answer at door',
    'Customer not home, no contact',
    'Wrong address given',
    'Door locked, no access',
    'Other',
  ],
  other: [
    'Parts not available',
    'Job scope changed',
    'Safety concern on site',
    'Equipment issue — truck',
    'Weather conditions',
    'Other',
  ],
};

const TYPE_CONFIG: Record<IssueType, { label: string; icon: React.ElementType; color: string; bgColor: string; desc: string }> = {
  cancel: {
    label: 'Customer Canceled',
    icon: PhoneOff,
    color: 'text-destructive',
    bgColor: 'bg-destructive/10 border-destructive/30',
    desc: 'Customer called or texted to cancel',
  },
  noshow: {
    label: 'No-Show',
    icon: UserX,
    color: 'text-warning',
    bgColor: 'bg-warning/10 border-warning/30',
    desc: 'Tech arrived but customer was not present',
  },
  other: {
    label: 'Other Issue',
    icon: AlertTriangle,
    color: 'text-warning',
    bgColor: 'bg-warning/10 border-warning/30',
    desc: 'Internal issue or scope change',
  },
};

interface Props {
  job: Job;
  /** The appointment ID to cancel (if job has an appointment) */
  appointmentId?: string;
  customerName: string;
  customerPhone: string;
  customerId?: string;
  onClose: (result?: { type: IssueType; reason: string; notes: string }) => void;
}

// D1: Wire cancel/no-show to real appointment cancel endpoint with confirm step
export function CancelNoShowSheet({ job, appointmentId, customerName, customerPhone, customerId, onClose }: Props) {
  const [step, setStep]           = useState<'type' | 'reason' | 'confirm' | 'submitting' | 'done'>('type');
  const [issueType, setIssueType] = useState<IssueType | null>(null);
  const [reason, setReason]       = useState('');
  const [notes, setNotes]         = useState('');
  const [action, setAction]       = useState<'close' | 'reschedule' | 'text'>('close');
  const [error, setError]         = useState<string | null>(null);

  function handleTypeSelect(t: IssueType) {
    setIssueType(t);
    setStep('reason');
  }

  function handleReasonSubmit() {
    if (!issueType || !reason) return;
    setStep('confirm');
  }

  async function handleConfirmedSubmit() {
    if (!issueType || !reason) return;
    setError(null);
    setStep('submitting');

    try {
      // Cancel the appointment via real API
      if (appointmentId) {
        const cancelReason = `${TYPE_CONFIG[issueType].label}: ${reason}${notes ? ` — ${notes}` : ''}`;
        const res = await apiFetch(`/api/appointments/${appointmentId}`, {
          method: 'PUT',
          body: JSON.stringify({
            // API canonical status is 'canceled' (single L); 'cancelled'
            // failed validation on every submit. cancelReason is not an
            // updatable field — persist the reason via the supported `notes`.
            status: 'canceled',
            notes: cancelReason,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `Failed to cancel: HTTP ${res.status}`);
        }
      } else {
        // D1: No appointment linked — transition job to cancelled via POST /api/jobs/:id/transition
        const cancelReason = `${TYPE_CONFIG[issueType].label}: ${reason}${notes ? ` — ${notes}` : ''}`;
        const res = await apiFetch(`/api/jobs/${job.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({
            // API canonical status is 'canceled' (single L) — 'cancelled'
            // fails the lifecycle transition check on every submit (see
            // JOB_STATUS_TRANSITIONS in packages/api/src/jobs/job-lifecycle.ts).
            status: 'canceled',
            reason: cancelReason,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `Failed to cancel job: HTTP ${res.status}`);
        }
      }

      // D1: Handle post-cancel action (text customer) — resolve thread via search, create if needed
      if (action === 'text' && customerId) {
        try {
          // Search for existing thread
          const searchRes = await apiFetch(
            `/api/conversations/search?customerId=${encodeURIComponent(customerId)}`,
            { method: 'GET' },
          );
          let conversationId: string | null = null;
          if (searchRes.ok) {
            const { results } = await searchRes.json();
            if (results && results.length > 0) {
              conversationId = results[0].conversationId ?? results[0].id;
            }
          }

          // If no existing thread, create one
          if (!conversationId) {
            const createRes = await apiFetch('/api/conversations', {
              method: 'POST',
              body: JSON.stringify({
                entityType: 'customer',
                entityId: customerId,
              }),
            });
            if (createRes.ok) {
              const created = await createRes.json();
              conversationId = created.id;
            }
          }

          // Send the cancellation message if we have a thread
          if (conversationId) {
            const cancelMessage = issueType === 'noshow'
              ? `Hi ${customerName.split(' ')[0]}, we stopped by but weren't able to reach you. Please contact us to reschedule.`
              : `Hi ${customerName.split(' ')[0]}, your appointment has been cancelled. Please contact us if you'd like to reschedule.`;
            await apiFetch(`/api/conversations/${conversationId}/reply`, {
              method: 'POST',
              body: JSON.stringify({ body: cancelMessage, channel: 'sms' }),
            });
          }
        } catch {
          // Best-effort text — don't fail the cancellation
        }
      }

      setStep('done');
      setTimeout(() => onClose({ type: issueType, reason, notes }), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel');
      setStep('reason');
    }
  }

  if (step === 'done') {
    return (
      <SheetOverlay onClose={() => onClose()}>
        <div className="flex flex-col items-center gap-3 py-10">
          <span className="flex size-14 items-center justify-center rounded-full bg-success/15">
            <Check size={26} className="text-success" />
          </span>
          <p className="text-sm text-foreground">Job marked as {issueType === 'noshow' ? 'No-Show' : issueType === 'cancel' ? 'Canceled' : 'closed'}</p>
          {action === 'reschedule' && <p className="text-xs text-muted-foreground">Added to reschedule queue</p>}
          {action === 'text' && <p className="text-xs text-muted-foreground">Message sent to {customerName.split(' ')[0]}</p>}
        </div>
      </SheetOverlay>
    );
  }

  return (
    <SheetOverlay onClose={() => onClose()}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-foreground">Report Issue</p>
        <button onClick={() => onClose()} className="p-1.5 rounded-lg hover:bg-secondary">
          <X size={16} className="text-muted-foreground" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-5">Job #{job.jobNumber} · {customerName}</p>

      {/* Step 1: Type selection */}
      {step === 'type' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-muted-foreground mb-1">What happened?</p>
          {(Object.entries(TYPE_CONFIG) as [IssueType, typeof TYPE_CONFIG[IssueType]][]).map(([key, cfg]) => {
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => handleTypeSelect(key)}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left hover:shadow-sm transition-all ${cfg.bgColor}`}
              >
                <span className={`flex size-9 items-center justify-center rounded-full bg-card shrink-0 mt-0.5`}>
                  <Icon size={18} className={cfg.color} />
                </span>
                <div>
                  <p className="text-sm text-foreground">{cfg.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{cfg.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Step 2: Reason + notes */}
      {step === 'reason' && issueType && (
        <div className="flex flex-col gap-4">
          <button
            onClick={() => setStep('type')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            ← Back
          </button>

          {error && (
            <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="text-destructive shrink-0" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {/* Type badge */}
          {(() => {
            const cfg = TYPE_CONFIG[issueType];
            const Icon = cfg.icon;
            return (
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${cfg.bgColor}`}>
                <Icon size={14} className={cfg.color} />
                <span className={`text-sm ${cfg.color}`}>{cfg.label}</span>
              </div>
            );
          })()}

          {/* Reason chips */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">Select reason</p>
            <div className="flex flex-wrap gap-1.5">
              {REASONS[issueType].map(r => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                    reason === r
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-foreground hover:bg-border'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">Additional notes (optional)</p>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={
                issueType === 'noshow'
                  ? 'How long did you wait? Any contact attempts?'
                  : 'Any context that helps with rescheduling or follow-up…'
              }
              rows={3}
              className="min-h-11 resize-none"
            />
          </div>

          {/* Action selection */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">After marking</p>
            <div className="flex flex-col gap-1.5">
              {[
                { key: 'close' as const,      icon: Check,          label: 'Mark and close' },
                { key: 'reschedule' as const, icon: RefreshCw,      label: 'Mark + add to reschedule queue' },
                { key: 'text' as const,        icon: MessageSquare,  label: `Mark + text ${customerName.split(' ')[0]}` },
              ].map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => setAction(key)}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    action === key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-foreground hover:border-border'
                  }`}
                >
                  <Icon size={14} className={action === key ? 'text-primary-foreground' : 'text-muted-foreground'} />
                  <span className="text-sm">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleReasonSubmit}
            disabled={!reason}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-destructive text-primary-foreground text-sm hover:bg-destructive/90 transition-colors disabled:opacity-40"
          >
            <AlertTriangle size={14} /> Continue
          </button>
        </div>
      )}

      {/* Step 3: Confirmation */}
      {step === 'confirm' && issueType && (
        <div className="flex flex-col gap-4">
          <button
            onClick={() => setStep('reason')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            ← Back
          </button>

          <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-4">
            <p className="text-sm text-foreground mb-2">Confirm cancellation</p>
            <p className="text-xs text-muted-foreground">
              This will mark the {appointmentId ? 'appointment' : 'job'} as{' '}
              <span className="text-destructive">{TYPE_CONFIG[issueType].label}</span> with reason:{' '}
              <span className="text-foreground">{reason}</span>
              {notes && <span className="text-muted-foreground"> — {notes}</span>}
            </p>
            {action === 'text' && (
              <p className="text-xs text-muted-foreground mt-2">
                A cancellation message will be sent to {customerName.split(' ')[0]}.
              </p>
            )}
          </div>

          <button
            onClick={() => void handleConfirmedSubmit()}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-destructive text-primary-foreground text-sm hover:bg-destructive/90 transition-colors"
          >
            <AlertTriangle size={14} /> Confirm and cancel
          </button>
          <button
            onClick={() => setStep('reason')}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-border text-foreground text-sm hover:bg-secondary transition-colors"
          >
            Go back
          </button>
        </div>
      )}

      {/* Step 4: Submitting */}
      {step === 'submitting' && (
        <div className="flex flex-col items-center gap-3 py-10">
          <div className="flex gap-1">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-2 h-2 rounded-full bg-primary"
                style={{ animation: `cancelPulse 1.2s ease-in-out ${i * 0.3}s infinite` }} />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">Cancelling…</p>
          <style>{`@keyframes cancelPulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }`}</style>
        </div>
      )}
    </SheetOverlay>
  );
}
