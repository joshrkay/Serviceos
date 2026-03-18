import { useState } from 'react';
import { X, AlertTriangle, UserX, PhoneOff, RefreshCw, MessageSquare, Check } from 'lucide-react';
import { SheetOverlay } from './JobSheets';
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
    color: 'text-red-600',
    bgColor: 'bg-red-50 border-red-200',
    desc: 'Customer called or texted to cancel',
  },
  noshow: {
    label: 'No-Show',
    icon: UserX,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50 border-orange-200',
    desc: 'Tech arrived but customer was not present',
  },
  other: {
    label: 'Other Issue',
    icon: AlertTriangle,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50 border-amber-200',
    desc: 'Internal issue or scope change',
  },
};

interface Props {
  job: Job;
  customerName: string;
  customerPhone: string;
  onClose: (result?: { type: IssueType; reason: string; notes: string }) => void;
}

export function CancelNoShowSheet({ job, customerName, customerPhone, onClose }: Props) {
  const [step, setStep]           = useState<'type' | 'reason' | 'done'>('type');
  const [issueType, setIssueType] = useState<IssueType | null>(null);
  const [reason, setReason]       = useState('');
  const [notes, setNotes]         = useState('');
  const [action, setAction]       = useState<'close' | 'reschedule' | 'text'>('close');

  function handleTypeSelect(t: IssueType) {
    setIssueType(t);
    setStep('reason');
  }

  function handleSubmit() {
    if (!issueType || !reason) return;
    onClose({ type: issueType, reason, notes });
    setStep('done');
    setTimeout(() => onClose({ type: issueType, reason, notes }), 1800);
  }

  if (step === 'done') {
    return (
      <SheetOverlay onClose={() => onClose()}>
        <div className="flex flex-col items-center gap-3 py-10">
          <span className="flex size-14 items-center justify-center rounded-full bg-green-100">
            <Check size={26} className="text-green-600" />
          </span>
          <p className="text-sm text-slate-900">Job marked as {issueType === 'noshow' ? 'No-Show' : issueType === 'cancel' ? 'Canceled' : 'closed'}</p>
          {action === 'reschedule' && <p className="text-xs text-slate-400">Added to reschedule queue</p>}
          {action === 'text' && <p className="text-xs text-slate-400">Message sent to {customerName.split(' ')[0]}</p>}
        </div>
      </SheetOverlay>
    );
  }

  return (
    <SheetOverlay onClose={() => onClose()}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-slate-900">Report Issue</p>
        <button onClick={() => onClose()} className="p-1.5 rounded-lg hover:bg-slate-100">
          <X size={16} className="text-slate-400" />
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-5">Job #{job.jobNumber} · {customerName}</p>

      {/* Step 1: Type selection */}
      {step === 'type' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-slate-500 mb-1">What happened?</p>
          {(Object.entries(TYPE_CONFIG) as [IssueType, typeof TYPE_CONFIG[IssueType]][]).map(([key, cfg]) => {
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => handleTypeSelect(key)}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left hover:shadow-sm transition-all ${cfg.bgColor}`}
              >
                <span className={`flex size-9 items-center justify-center rounded-full bg-white shrink-0 mt-0.5`}>
                  <Icon size={18} className={cfg.color} />
                </span>
                <div>
                  <p className="text-sm text-slate-900">{cfg.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{cfg.desc}</p>
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
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors mb-1"
          >
            ← Back
          </button>

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
            <p className="text-xs text-slate-500 mb-2">Select reason</p>
            <div className="flex flex-wrap gap-1.5">
              {REASONS[issueType].map(r => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                    reason === r
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <p className="text-xs text-slate-500 mb-2">Additional notes (optional)</p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={
                issueType === 'noshow'
                  ? 'How long did you wait? Any contact attempts?'
                  : 'Any context that helps with rescheduling or follow-up…'
              }
              rows={3}
              className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400 resize-none"
            />
          </div>

          {/* Action selection */}
          <div>
            <p className="text-xs text-slate-500 mb-2">After marking</p>
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
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <Icon size={14} className={action === key ? 'text-white' : 'text-slate-400'} />
                  <span className="text-sm">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!reason}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-red-600 text-white text-sm hover:bg-red-700 transition-colors disabled:opacity-40"
          >
            <AlertTriangle size={14} /> Mark job
          </button>
        </div>
      )}
    </SheetOverlay>
  );
}
