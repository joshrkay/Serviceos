import { useState } from 'react';
import {
  Sparkles, Check, X, Pencil, Brain, ChevronDown, ChevronUp,
  AlertTriangle, Zap, User, Eye, Clock, CheckCircle2,
} from 'lucide-react';
import { AILabel, ConfBar } from '../shared';

// ── 1 · Propose action ─────────────────────────────────────────────────────
export function ProposeDemo() {
  const [state, setState] = useState<'idle' | 'done'>('idle');
  const [action, setAction] = useState<'approved' | 'rejected' | null>(null);

  function reset() { setState('idle'); setAction(null); }
  if (state === 'done' && action === 'approved') return (
    <div className="flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-3.5">
      <span className="flex size-7 items-center justify-center rounded-full bg-green-500 shrink-0">
        <Check size={13} className="text-white" />
      </span>
      <div className="flex-1">
        <AILabel text="✦ Applied" />
        <p className="text-sm text-green-900">Invoice drafted for Rodriguez · $425</p>
      </div>
      <button onClick={reset} className="text-xs text-green-600 hover:underline">Undo</button>
    </div>
  );
  if (state === 'done' && action === 'rejected') return (
    <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 opacity-70">
      <p className="text-xs text-slate-400 italic">Suggestion dismissed — won't resurface this</p>
      <button onClick={reset} className="text-xs text-blue-500 mt-1 hover:underline">Show again</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-blue-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-blue-50">
        <div className="flex items-center gap-1.5">
          <Zap size={11} className="text-blue-600" />
          <span className="text-xs text-blue-700">Invoice</span>
        </div>
        <ConfBar level="high" />
      </div>
      <div className="px-4 py-3 bg-white">
        <AILabel />
        <p className="text-sm text-slate-900">Auto-create invoice for Rodriguez</p>
        <p className="text-sm text-slate-500 mt-1">Job #1042 was marked complete. Ready to invoice for <strong>$425</strong>.</p>
        <span className="inline-flex items-center gap-1 mt-2 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
          Saves ~1.5 days to invoice
        </span>
      </div>
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50/60">
        <button onClick={() => { setAction('approved'); setState('done'); }}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs text-white hover:bg-blue-700 transition-colors">
          <Check size={12} /> Approve
        </button>
        <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-700 hover:bg-slate-50 transition-colors">
          <Pencil size={12} /> Edit
        </button>
        <button onClick={() => { setAction('rejected'); setState('done'); }}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-slate-600 transition-colors">
          <X size={12} /> Dismiss
        </button>
      </div>
    </div>
  );
}

// ── 2 · Approve → undo window ──────────────────────────────────────────────
export function ApproveDemo() {
  const [state, setState] = useState<'pending' | 'approved' | 'undone'>('pending');

  return (
    <>
      {state === 'pending' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
          <AILabel text="✦ Ready to apply" />
          <p className="text-sm text-slate-800 mt-0.5">Send appointment reminder to Davis</p>
          <p className="text-xs text-slate-500 mt-1">SMS · Tomorrow 9 AM · Carlos Reyes</p>
          <button onClick={() => setState('approved')}
            className="mt-3 flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors active:scale-[0.98]">
            <Check size={14} /> Approve action
          </button>
        </div>
      )}
      {state === 'approved' && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5" style={{ animation: 'stepIn 0.25s ease' }}>
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 size={15} className="text-green-500" />
            <p className="text-sm text-green-900">Reminder scheduled · SMS queued for tomorrow 7 AM</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-600">Applied just now</span>
            <button onClick={() => setState('undone')} className="text-xs text-green-700 underline hover:no-underline">Undo</button>
          </div>
        </div>
      )}
      {state === 'undone' && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-sm text-slate-600">Reminder cancelled. Returning to previous state.</p>
          <button onClick={() => setState('pending')} className="text-xs text-blue-600 mt-1.5 hover:underline">Re-approve</button>
        </div>
      )}
    </>
  );
}

// ── 3 · Edit action ────────────────────────────────────────────────────────
export function EditDemo() {
  const [amount,  setAmount]  = useState('425.00');
  const [dueDate, setDueDate] = useState('Mar 17, 2026');
  const [state,   setState]   = useState<'editing' | 'done'>('editing');

  if (state === 'done') return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <AILabel text="✦ Applied with edits" />
      <p className="text-sm text-green-900">Invoice created · <strong>${amount}</strong> · Due {dueDate}</p>
      <button onClick={() => setState('editing')} className="text-xs text-green-600 mt-1.5 hover:underline">Edit again</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-indigo-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-indigo-50 flex items-center gap-1.5">
        <Pencil size={11} className="text-indigo-600" />
        <span className="text-xs text-indigo-700">Edit before applying · Invoice</span>
      </div>
      <div className="px-4 py-3 bg-white flex flex-col gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Invoice amount</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
            <input value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full rounded-xl border border-slate-200 pl-6 pr-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Due date</label>
          <input value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors" />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button onClick={() => setState('done')}
            className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-xs text-white hover:bg-blue-700 transition-colors">
            <Check size={12} /> Save & apply
          </button>
          <button className="px-4 py-2.5 rounded-xl border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 4 · Reject action ──────────────────────────────────────────────────────
export function RejectDemo() {
  const [state, setState] = useState<'pending' | 'feedback' | 'done'>('pending');
  const [reason, setReason] = useState('');

  const reasons = ['Wrong customer', 'Amount is incorrect', 'Already handled', 'Not relevant'];

  if (state === 'pending') return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3">
        <AILabel />
        <p className="text-sm text-slate-900">Follow up on Davis estimate (3 days no response)</p>
        <p className="text-sm text-slate-400 mt-1">EST-0046 · $4,220 · Sent Mar 7</p>
      </div>
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-100">
        <button className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs text-white hover:bg-blue-700">
          <Check size={12} /> Approve
        </button>
        <button onClick={() => setState('feedback')}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-red-500 transition-colors">
          <X size={12} /> Dismiss
        </button>
      </div>
    </div>
  );

  if (state === 'feedback') return (
    <div className="rounded-xl border border-slate-200 overflow-hidden" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="px-4 py-3">
        <p className="text-sm text-slate-700 mb-2.5">Why isn't this useful? <span className="text-slate-400">(optional)</span></p>
        <div className="flex flex-wrap gap-1.5">
          {reasons.map(r => (
            <button key={r} onClick={() => setReason(r)}
              className={`rounded-full border px-3 py-1 text-xs transition-all ${
                reason === r ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-400'
              }`}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="px-4 pb-3">
        <button onClick={() => setState('done')}
          className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-xs hover:bg-slate-700 transition-colors">
          <X size={11} /> Confirm dismissal
        </button>
      </div>
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <p className="text-xs text-slate-400 italic">Dismissed{reason ? ` — "${reason}"` : ''}</p>
      <p className="text-xs text-slate-400 mt-0.5">Got it. I'll learn from this to improve future suggestions.</p>
      <button onClick={() => { setState('pending'); setReason(''); }} className="text-xs text-blue-500 mt-1.5 hover:underline">Undo</button>
    </div>
  );
}

// ── 5 · Explanation ───────────────────────────────────────────────────────
export function ExplanationDemo() {
  const [open, setOpen] = useState(false);
  const reasoning = [
    'Job #1042 marked complete at 2:34 PM by Carlos Reyes',
    'Customer Roberto Rodriguez has Net-15 terms — invoice due Mar 25',
    'Average time-to-invoice for similar jobs: 2.1 days — this would be same-day',
    'No existing draft invoice found for this job',
  ];
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3">
        <AILabel />
        <p className="text-sm text-slate-900">Auto-create invoice for Rodriguez · $425</p>
        <button onClick={() => setOpen(v => !v)}
          className="flex items-center gap-1.5 mt-2.5 text-xs text-slate-400 hover:text-slate-600 transition-colors">
          <Brain size={11} /> {open ? 'Hide reasoning' : 'Why this suggestion?'}
          {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
        {open && (
          <div className="mt-2 rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
            <ul className="flex flex-col gap-1.5">
              {reasoning.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-500">
                  <span className="size-1 rounded-full bg-slate-400 shrink-0 mt-1.5" />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 6 · Confidence / ambiguity cue ────────────────────────────────────────
export function ConfidenceDemo() {
  const levels: { level: 'high' | 'medium' | 'low'; title: string; sub: string; cta: string }[] = [
    { level: 'high',   title: 'Draft invoice for Rodriguez · $425', sub: 'All signals match — invoice amount derived from approved estimate', cta: 'Apply now' },
    { level: 'medium', title: 'Mark Davis job as Complete', sub: 'Notes say "done" but no tech sign-off photo attached — review before applying', cta: 'Review & apply' },
    { level: 'low',    title: 'Unknown: schedule or reschedule?', sub: 'Ambiguous request — I detected two possible intents. Clarifying before acting.', cta: 'Clarify first' },
  ];
  const [chosen, setChosen] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-2.5">
      {levels.map((l, i) => (
        <div key={i} className={`rounded-xl border px-4 py-3.5 cursor-pointer transition-all ${
          chosen === i ? 'border-slate-400 shadow-sm' : 'border-slate-200 hover:border-slate-300'
        } ${l.level === 'low' ? 'bg-red-50/40' : l.level === 'medium' ? 'bg-amber-50/40' : 'bg-white'}`}
          onClick={() => setChosen(i === chosen ? null : i)}>
          <ConfBar level={l.level} />
          <p className="text-sm text-slate-800 mt-2">{l.title}</p>
          <p className="text-xs text-slate-500 mt-0.5">{l.sub}</p>
          {l.level === 'low' && (
            <div className="flex items-center gap-1.5 mt-2">
              <AlertTriangle size={11} className="text-red-500" />
              <span className="text-xs text-red-600">Not acting until clarified</span>
            </div>
          )}
          {chosen === i && (
            <button className={`mt-3 rounded-xl px-3.5 py-2 text-xs text-white transition-colors ${
              l.level === 'high' ? 'bg-blue-600 hover:bg-blue-700' :
              l.level === 'medium' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-slate-700 hover:bg-slate-900'
            }`}>
              {l.cta} →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── 7 · Clarification question ─────────────────────────────────────────────
export function ClarificationDemo() {
  const [answer, setAnswer]   = useState<string | null>(null);
  const [done,   setDone]     = useState(false);
  const options = ['Carlos Reyes (available)', 'Marcus Webb (available)', 'Sarah Lin (on another job)', 'I\'ll pick later'];

  if (done) return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <AILabel text="✦ Got it" />
      <p className="text-sm text-green-900">
        {answer === 'I\'ll pick later' ? 'Job #1044 scheduled for Thu Mar 12 — tech unassigned' : `Job #1044 scheduled for Thu Mar 12 · ${answer?.split(' (')[0]}`}
      </p>
      <button onClick={() => { setAnswer(null); setDone(false); }} className="text-xs text-green-600 mt-1.5 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 overflow-hidden">
      <div className="px-4 py-3">
        <AILabel text="✦ One quick question before I proceed" />
        <p className="text-sm text-slate-800 mt-1">You asked me to schedule the Davis HVAC job for Thursday. Which tech should I assign?</p>
      </div>
      <div className="flex flex-col gap-1.5 px-4 pb-4">
        {options.map(o => (
          <button key={o} onClick={() => setAnswer(o)}
            className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-left text-sm transition-all ${
              answer === o ? 'border-violet-500 bg-violet-100 text-violet-900' : 'border-slate-200 bg-white hover:border-slate-300 text-slate-800'
            }`}>
            <User size={13} className={answer === o ? 'text-violet-500' : 'text-slate-400'} />
            {o}
            {answer === o && <Check size={12} className="text-violet-500 ml-auto" />}
          </button>
        ))}
        {answer && (
          <button onClick={() => setDone(true)}
            className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-violet-600 text-white py-2.5 text-sm hover:bg-violet-700 transition-colors"
            style={{ animation: 'stepIn 0.2s ease' }}>
            <Check size={14} /> Confirm — proceed with this
          </button>
        )}
      </div>
    </div>
  );
}

// ── 8 · Auto-applied update confirmation ──────────────────────────────────
export function AutoAppliedDemo() {
  const updates = [
    { id: 'a', icon: Eye,      title: 'EST-0046 status → Viewed',    sub: 'Davis opened the estimate at 2:14 PM', color: 'text-violet-500 bg-violet-100' },
    { id: 'b', icon: Clock,    title: 'Job #1043 time updated',       sub: '2:00 PM → 2:30 PM (traffic adjustment)', color: 'text-amber-500 bg-amber-100' },
    { id: 'c', icon: CheckCircle2, title: 'Invoice INV-0087 marked Sent', sub: 'Auto-sent via customer payment link', color: 'text-green-500 bg-green-100' },
  ];
  const [dismissed, setDismiss] = useState<Set<string>>(new Set());

  return (
    <div className="flex flex-col gap-2">
      {updates.map(u => {
        const Icon = u.icon;
        if (dismissed.has(u.id)) return null;
        return (
          <div key={u.id} className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-3.5 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
            <span className={`flex size-7 items-center justify-center rounded-xl shrink-0 ${u.color}`}>
              <Icon size={13} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <Sparkles size={9} className="text-indigo-500" />
                <p className="text-xs text-indigo-600">Auto-applied</p>
              </div>
              <p className="text-sm text-slate-800">{u.title}</p>
              <p className="text-xs text-slate-400">{u.sub}</p>
            </div>
            <button onClick={() => setDismiss(s => new Set([...s, u.id]))}
              className="text-xs text-blue-600 hover:underline shrink-0">Undo</button>
          </div>
        );
      })}
      {dismissed.size === updates.length && (
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-center">
          <p className="text-xs text-slate-400">All updates undone</p>
          <button onClick={() => setDismiss(new Set())} className="text-xs text-blue-500 mt-1 hover:underline">Restore all</button>
        </div>
      )}
    </div>
  );
}
