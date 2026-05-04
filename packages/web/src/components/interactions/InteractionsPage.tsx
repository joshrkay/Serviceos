import { useState } from 'react';
import {
  Sparkles, Check, X, Pencil, Brain, ChevronDown, ChevronUp,
  AlertCircle, AlertTriangle, RotateCcw, ArrowRight, Send,
  Clock, Calendar, User, Zap, MessageSquare, Phone,
  CheckCircle2, XCircle, RefreshCw, CloudOff,
  ChevronRight, Mic, Briefcase, Eye, Bell, Mail,
  Receipt, WifiOff, Signal,
} from 'lucide-react';

// ─── helpers ─────────────────────────────────────────────────────────────
function DemoCard({
  tag, tagColor = 'bg-indigo-100 text-indigo-700',
  title, children, onReset,
}: {
  tag: string; tagColor?: string; title?: string;
  children: React.ReactNode; onReset?: () => void;
}) {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs ${tagColor}`}>{tag}</span>
          {title && <span className="text-xs text-slate-500">{title}</span>}
        </div>
        {onReset && (
          <button
            onClick={onReset}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            <RotateCcw size={10} /> Reset
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function AILabel({ text = '✦ Fieldly AI' }: { text?: string }) {
  return (
    <p className="flex items-center gap-1 text-xs text-indigo-600 mb-1">
      <Sparkles size={10} /> {text}
    </p>
  );
}

function ConfBar({ level }: { level: 'high' | 'medium' | 'low' }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-20 h-1.5 rounded-full overflow-hidden bg-slate-100">
        <div className={`h-full rounded-full transition-all ${
          level === 'high' ? 'w-full bg-green-500' :
          level === 'medium' ? 'w-3/5 bg-amber-400' : 'w-1/4 bg-red-400'
        }`} />
      </div>
      <span className={`text-xs ${
        level === 'high' ? 'text-green-700' :
        level === 'medium' ? 'text-amber-700' : 'text-red-600'
      }`}>
        {level === 'high' ? 'High confidence' : level === 'medium' ? 'Review recommended' : 'Ambiguous'}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AI INTERACTION DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1 · Propose action ─────────────────────────────────────────────────────
function ProposeDemo() {
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
function ApproveDemo() {
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
      <style>{`@keyframes stepIn { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} }`}</style>
    </>
  );
}

// ── 3 · Edit action ────────────────────────────────────────────────────────
function EditDemo() {
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
function RejectDemo() {
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
function ExplanationDemo() {
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
function ConfidenceDemo() {
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
function ClarificationDemo() {
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
function AutoAppliedDemo() {
  const [state, setState] = useState<'shown' | 'undone' | 'hidden'>('shown');

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

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGING DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1+3+4 · Draft SMS + Review + Send feedback ──────────────────────────
function SMSDraftDemo() {
  const [editing, setEditing]   = useState(false);
  const [phase,   setPhase]     = useState<'draft' | 'review' | 'sent' | 'failed'>('draft');
  const [body,    setBody]      = useState("Hi Roberto! Confirming your HVAC appointment tomorrow, Mar 11 at 9:00 AM. Carlos Reyes will be on-site. Reply STOP to opt out. – Austin Pro Services");

  if (phase === 'sent') return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={20} className="text-green-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-green-900">SMS sent to Roberto Rodriguez</p>
        <p className="text-xs text-green-600">+1 (512) 555-0180 · {body.length} chars · Delivered 2:31 PM</p>
      </div>
      <button onClick={() => setPhase('draft')} className="text-xs text-green-700 hover:underline shrink-0">New draft</button>
    </div>
  );
  if (phase === 'failed') return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 flex items-center gap-3">
      <XCircle size={20} className="text-red-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-red-900">Failed to send</p>
        <p className="text-xs text-red-600">Carrier error — tap to retry</p>
      </div>
      <button onClick={() => setPhase('sent')} className="text-xs text-white bg-red-500 rounded-lg px-3 py-1.5 hover:bg-red-600 transition-colors shrink-0">Retry</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* To header */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 shrink-0" style={{ fontSize: 12 }}>RR</span>
        <div>
          <p className="text-sm text-slate-800">Roberto Rodriguez</p>
          <p className="text-xs text-slate-400">+1 (512) 555-0180 · SMS</p>
        </div>
        <span className="ml-auto flex items-center gap-1 text-xs text-indigo-600 bg-indigo-50 rounded-full px-2.5 py-0.5">
          <Sparkles size={9} /> AI drafted
        </span>
      </div>

      {/* Bubble */}
      {editing ? (
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={4}
          className="rounded-2xl border border-indigo-300 bg-indigo-50/30 px-4 py-3 text-sm text-slate-800 resize-none focus:outline-none focus:border-indigo-500 transition-colors"
        />
      ) : (
        <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-3">
          <p className="text-sm text-slate-800 leading-relaxed">{body}</p>
        </div>
      )}

      {/* Meta */}
      <div className="flex items-center justify-between">
        <p className={`text-xs ${body.length > 160 ? 'text-amber-600' : 'text-slate-400'}`}>
          {body.length} chars{body.length > 160 ? ' · 2 segments' : ' · 1 segment'}
        </p>
        <button onClick={() => setEditing(v => !v)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <Pencil size={10} /> {editing ? 'Done editing' : 'Edit'}
        </button>
      </div>

      {/* Review before send */}
      {phase === 'draft' && (
        <div className="rounded-xl bg-amber-50 border border-amber-100 px-3.5 py-3 flex items-start gap-2.5">
          <AlertCircle size={13} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-amber-700">Review before sending</p>
            <p className="text-xs text-amber-600 mt-0.5">Confirm time, name, and opt-out text are correct. Nothing has been sent yet.</p>
          </div>
          <button onClick={() => setPhase('review')} className="text-xs text-amber-700 hover:underline shrink-0">Review →</button>
        </div>
      )}

      {phase === 'review' && (
        <div className="rounded-xl bg-white border border-slate-200 px-4 py-3 flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-xs text-slate-500">Review & send</p>
          <div className="flex gap-2">
            <button onClick={() => setPhase('sent')}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors">
              <Send size={13} /> Send SMS
            </button>
            <button onClick={() => setPhase('failed')}
              className="flex items-center justify-center rounded-xl border border-slate-200 text-slate-600 px-4 py-3 text-xs hover:bg-slate-50 transition-colors">
              Simulate fail
            </button>
          </div>
          <button onClick={() => setPhase('draft')} className="text-center text-xs text-slate-400 hover:text-slate-600">← Go back and edit</button>
        </div>
      )}
    </div>
  );
}

// ── 2 · Draft email ────────────────────────────────────────────────────────
function EmailDraftDemo() {
  const [phase,   setPhase]   = useState<'draft' | 'sent'>('draft');
  const [subject, setSubject] = useState('Your estimate EST-0046 from Fieldly Pro Services — $4,220');
  const [body,    setBody]    = useState(`Hi Sarah,

Following up on the estimate we sent over for your HVAC service — EST-0046 for $4,220.

Let me know if you have any questions or if you'd like to discuss the scope. We can also adjust the quote if anything has changed.

Best,
Mike Ortega
Austin Pro Services | (512) 555-0000`);
  const [editField, setEdit] = useState<string | null>(null);

  if (phase === 'sent') return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5 flex items-center gap-3">
      <Mail size={16} className="text-green-500 shrink-0" />
      <div className="flex-1"><p className="text-sm text-green-900">Email sent to Sarah Davis</p><p className="text-xs text-green-600">sdavis@email.com · Delivered</p></div>
      <button onClick={() => setPhase('draft')} className="text-xs text-green-700 hover:underline">New draft</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="border-b border-slate-100">
        {[
          { label: 'To', value: 'Sarah Davis <sdavis@email.com>', key: 'to' },
          { label: 'Subject', value: subject, key: 'subject', onChange: setSubject },
        ].map(row => (
          <div key={row.key} className="flex items-start gap-3 px-4 py-2.5 border-b border-slate-50">
            <span className="text-xs text-slate-400 pt-0.5 w-12 shrink-0">{row.label}</span>
            {editField === row.key && row.onChange ? (
              <input value={row.value} onChange={e => row.onChange!(e.target.value)} onBlur={() => setEdit(null)}
                autoFocus className="flex-1 text-sm text-slate-800 focus:outline-none" />
            ) : (
              <p className="flex-1 text-sm text-slate-700 cursor-text" onClick={() => row.onChange && setEdit(row.key)}>{row.value}</p>
            )}
          </div>
        ))}
      </div>
      <div className="px-4 py-3">
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={6}
          className="w-full text-sm text-slate-700 resize-none focus:outline-none leading-relaxed" />
        <div className="flex items-center gap-1.5 mt-1">
          <Sparkles size={9} className="text-indigo-500" />
          <span className="text-xs text-indigo-600">AI drafted · review before sending</span>
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-100 bg-slate-50">
        <button onClick={() => setPhase('sent')}
          className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Send size={13} /> Send email
        </button>
        <span className="text-xs text-slate-400">Nothing sent yet</span>
      </div>
    </div>
  );
}

// ── 5 · Follow-up suggestion ──────────────────────────────────────────────
function FollowUpDemo() {
  const [state, setState] = useState<'suggest' | 'draft' | 'scheduled' | 'snoozed'>('suggest');

  if (state === 'draft') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-slate-100 px-4 py-3 rounded-tl-sm">
        <p className="text-sm text-slate-800">Hi Sarah, just wanted to follow up on the estimate we sent for your HVAC system. Happy to answer any questions or adjust the scope. Let us know!</p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setState('scheduled')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Send size={13} /> Send now
        </button>
        <button onClick={() => setState('scheduled')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">
          <Clock size={13} /> Send tomorrow 9 AM
        </button>
      </div>
    </div>
  );
  if (state === 'scheduled') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <p className="text-sm text-green-900">Follow-up scheduled</p>
      <p className="text-xs text-green-600 mt-0.5">SMS to Sarah Davis · Tomorrow, Mar 11 at 9:00 AM</p>
      <button onClick={() => setState('suggest')} className="text-xs text-green-700 mt-1.5 hover:underline">Reset demo</button>
    </div>
  );
  if (state === 'snoozed') return (
    <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3.5">
      <p className="text-sm text-slate-600">Reminder set for 2 days from now</p>
      <button onClick={() => setState('suggest')} className="text-xs text-slate-400 mt-1.5 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-100">
          <Sparkles size={14} className="text-violet-600" />
        </div>
        <div className="flex-1">
          <p className="text-sm text-slate-800">Davis estimate hasn't had a response in <strong>3 days</strong></p>
          <p className="text-xs text-slate-500 mt-0.5">EST-0046 · $4,220 · Sent Mar 7 · Last seen: unread</p>
          <p className="text-sm text-slate-700 mt-2">Want me to draft a follow-up message?</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => setState('draft')} className="flex items-center gap-1.5 rounded-xl bg-violet-600 text-white px-3.5 py-2 text-xs hover:bg-violet-700 transition-colors">
              <MessageSquare size={11} /> Yes, draft one
            </button>
            <button onClick={() => setState('snoozed')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
              <Clock size={11} /> Remind me in 2 days
            </button>
            <button className="px-3.5 py-2 text-xs text-slate-400 hover:text-slate-600 transition-colors">Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 6+7 · Appointment confirm + Reschedule notice ────────────────────────
function AppointmentDemo() {
  const [tab,   setTab]   = useState<'confirm' | 'reschedule'>('confirm');
  const [phase, setPhase] = useState<'draft' | 'sent'>('draft');
  const [reason, setReason] = useState('Tech unavailable');

  function reset() { setPhase('draft'); }

  const reasons = ['Tech unavailable', 'Weather conditions', 'Customer request', 'Equipment delay'];

  if (phase === 'sent') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={18} className="text-green-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-green-900">{tab === 'confirm' ? 'Confirmation sent' : 'Reschedule notice sent'} to Roberto</p>
        <p className="text-xs text-green-600">SMS delivered · 2:33 PM</p>
      </div>
      <button onClick={reset} className="text-xs text-green-700 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Tab toggle */}
      <div className="flex gap-1.5 p-1 rounded-xl bg-slate-100">
        {(['confirm', 'reschedule'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setPhase('draft'); }}
            className={`flex-1 rounded-lg py-2 text-xs transition-all ${
              tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {t === 'confirm' ? '📅 Appointment confirm' : '🔄 Reschedule notice'}
          </button>
        ))}
      </div>

      {tab === 'confirm' ? (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
            <div className="flex items-center gap-1.5">
              <Sparkles size={10} className="text-indigo-500" />
              <p className="text-xs text-indigo-600">AI drafted · Appointment confirmation</p>
            </div>
          </div>
          <div className="px-4 py-3 flex flex-col gap-2.5">
            {[
              { icon: Calendar, label: 'Date', value: 'Wednesday, March 11, 2026' },
              { icon: Clock,    label: 'Time', value: '9:00 AM – 11:00 AM (est.)' },
              { icon: User,     label: 'Tech', value: 'Carlos Reyes · HVAC certified' },
              { icon: Phone,    label: 'Contact', value: '(512) 555-0000 if needed' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-2.5">
                <Icon size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs text-slate-400 w-14 shrink-0">{label}</span>
                <span className="text-sm text-slate-800">{value}</span>
              </div>
            ))}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-3 mt-1">
              <p className="text-xs text-slate-500 leading-relaxed">Preview SMS: "Hi Roberto! Confirming your HVAC service tomorrow Mar 11 at 9AM. Carlos Reyes will be on-site. Questions? (512) 555-0000"</p>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-slate-100">
            <button onClick={() => setPhase('sent')} className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">
              <Send size={13} /> Send confirmation
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-100 bg-amber-50">
            <div className="flex items-center gap-1.5">
              <Sparkles size={10} className="text-amber-600" />
              <p className="text-xs text-amber-700">Reschedule notice</p>
            </div>
          </div>
          <div className="px-4 py-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2.5">
                <p className="text-xs text-red-600 mb-0.5">Was</p>
                <p className="text-sm text-red-800">Wed Mar 11 · 9AM</p>
              </div>
              <div className="rounded-xl bg-green-50 border border-green-100 px-3 py-2.5">
                <p className="text-xs text-green-600 mb-0.5">Now</p>
                <p className="text-sm text-green-800">Thu Mar 12 · 10AM</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1.5">Reason (included in message)</p>
              <div className="flex flex-wrap gap-1.5">
                {reasons.map(r => (
                  <button key={r} onClick={() => setReason(r)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-all ${
                      reason === r ? 'border-amber-500 bg-amber-100 text-amber-800' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}>{r}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5">
              <p className="text-xs text-slate-500 leading-relaxed">Preview: "Hi Roberto, we need to reschedule your Mar 11 9AM appointment to Mar 12 at 10AM due to {reason.toLowerCase()}. Apologies for the inconvenience. – Austin Pro Services"</p>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-amber-100">
            <button onClick={() => setPhase('sent')} className="flex items-center gap-2 rounded-xl bg-amber-600 text-white px-4 py-2.5 text-sm hover:bg-amber-700 transition-colors">
              <Send size={13} /> Send reschedule notice
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULING DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1 · Create schedule from conversation ─────────────────────────────────
function CreateFromConvoDemo() {
  const [input, setInput]   = useState('');
  const [state, setState]   = useState<'idle' | 'parsed' | 'confirmed'>('idle');
  const suggestions = ['Schedule Davis HVAC for Thursday at 2pm', 'Book Martinez plumbing Friday morning', 'Set up Williams painting for next Tuesday'];

  function parse() {
    if (!input.trim()) return;
    setState('parsed');
  }

  if (state === 'confirmed') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3">
        <CheckCircle2 size={18} className="text-green-500 shrink-0" />
        <div><p className="text-sm text-green-900">Job #1044 scheduled</p><p className="text-xs text-green-600">Thu Mar 12 · 2:00 PM · Carlos Reyes</p></div>
      </div>
      <button onClick={() => { setState('idle'); setInput(''); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Try again</button>
    </div>
  );

  if (state === 'parsed') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ I understood" />
        <p className="text-xs text-slate-500 mt-0.5 italic">"{input}"</p>
      </div>
      <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
        {[
          { icon: Briefcase,  label: 'Job',  value: '#1044 Davis HVAC · Mini-split inspection' },
          { icon: Calendar,   label: 'Date', value: 'Thursday, March 12, 2026' },
          { icon: Clock,      label: 'Time', value: '2:00 PM – 4:00 PM (2hr est.)' },
          { icon: User,       label: 'Tech', value: 'Carlos Reyes · available' },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-50 last:border-0">
            <Icon size={13} className="text-slate-400 shrink-0" />
            <span className="text-xs text-slate-400 w-8 shrink-0">{label}</span>
            <span className="text-sm text-slate-800">{value}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setState('confirmed')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Confirm schedule
        </button>
        <button onClick={() => setState('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">Edit</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 focus-within:border-indigo-400 transition-colors">
          <Mic size={14} className="text-slate-400 shrink-0" />
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && parse()}
            placeholder="Schedule a job in plain English…"
            className="flex-1 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
        </div>
        <button onClick={parse} disabled={!input.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all">
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {suggestions.map(s => (
          <button key={s} onClick={() => { setInput(s); setState('parsed'); }}
            className="flex items-center gap-2 text-left rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 hover:bg-slate-100 transition-colors">
            <ChevronRight size={11} className="text-slate-400 shrink-0" />
            <span className="text-sm text-slate-600">{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 2 · Move job from conversation ────────────────────────────────────────
function MoveJobDemo() {
  const [state, setState] = useState<'idle' | 'preview' | 'moved'>('idle');
  const [input, setInput] = useState('');

  if (state === 'moved') return (
    <div className="flex flex-col gap-2" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 flex items-center gap-3">
        <Check size={15} className="text-green-500 shrink-0" />
        <p className="text-sm text-green-900">Job moved — Johnson now on Wed Mar 11 at 9:00 AM</p>
      </div>
      <button onClick={() => { setState('idle'); setInput(''); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Reset</button>
    </div>
  );

  if (state === 'preview') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <AILabel text="✦ Here's what I'll change" />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-slate-100 border border-slate-200 px-3.5 py-3">
          <p className="text-xs text-slate-500 mb-1">Before</p>
          <p className="text-sm text-slate-800">Tue Mar 10</p>
          <p className="text-xs text-slate-500">2:00 PM · Marcus</p>
        </div>
        <div className="rounded-xl bg-green-50 border border-green-200 px-3.5 py-3">
          <p className="text-xs text-green-600 mb-1">After</p>
          <p className="text-sm text-slate-900">Wed Mar 11</p>
          <p className="text-xs text-slate-600">9:00 AM · Marcus</p>
        </div>
      </div>
      <p className="text-xs text-slate-500">Marcus Webb is available Wed 9 AM. Customer has not been notified yet.</p>
      <div className="flex gap-2">
        <button onClick={() => setState('moved')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Confirm move
        </button>
        <button onClick={() => setState('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors">Cancel</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && setState('preview')}
          placeholder="e.g. Move Johnson job to Wednesday morning"
          className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors" />
        <button onClick={() => setState('preview')} className="flex size-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all shrink-0">
          <ArrowRight size={16} />
        </button>
      </div>
      <button onClick={() => { setInput('Move Johnson job to Wednesday morning'); setState('preview'); }}
        className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 transition-colors">
        <ChevronRight size={11} className="text-slate-400" /> Try: "Move Johnson job to Wednesday morning"
      </button>
    </div>
  );
}

// ── 3 · Assign tech from calendar ─────────────────────────────────────────
function AssignTechDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const [assigned, setAssigned] = useState(false);

  const techs = [
    { id: 'carlos', name: 'Carlos Reyes', cert: 'HVAC', jobs: 2, status: 'available', color: '#3B82F6' },
    { id: 'marcus', name: 'Marcus Webb',  cert: 'Plumbing', jobs: 1, status: 'available', color: '#10B981' },
    { id: 'sarah',  name: 'Sarah Lin',    cert: 'Painting', jobs: 3, status: 'busy',      color: '#8B5CF6' },
  ];

  if (assigned) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={18} className="text-green-500 shrink-0" />
      <div>
        <p className="text-sm text-green-900">{techs.find(t => t.id === selected)?.name} assigned</p>
        <p className="text-xs text-green-600">Job #1044 · Thu Mar 12 · 2:00 PM</p>
      </div>
      <button onClick={() => { setAssigned(false); setSelected(null); }} className="ml-auto text-xs text-green-700 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-slate-500">Thu Mar 12 — available technicians</p>
      {techs.map(tech => (
        <button key={tech.id} onClick={() => tech.status === 'available' && setSelected(tech.id)}
          disabled={tech.status === 'busy'}
          className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all ${
            tech.status === 'busy'    ? 'border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed' :
            selected === tech.id     ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
          }`}>
          <span className="flex size-9 items-center justify-center rounded-full text-white shrink-0"
            style={{ backgroundColor: tech.color, fontSize: 12 }}>
            {tech.name.split(' ').map(n => n[0]).join('')}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-800">{tech.name}</p>
            <p className="text-xs text-slate-500">{tech.cert} · {tech.jobs} job{tech.jobs !== 1 ? 's' : ''} this day</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            tech.status === 'available' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}>{tech.status}</span>
          {selected === tech.id && <Check size={14} className="text-blue-500 shrink-0" />}
        </button>
      ))}
      {selected && (
        <button onClick={() => setAssigned(true)}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Assign {techs.find(t => t.id === selected)?.name.split(' ')[0]}
        </button>
      )}
    </div>
  );
}

// ── 4 · Conflict resolution ────────────────────────────────────────────────
function ConflictDemo() {
  const [state,  setState]  = useState<'conflict' | 'resolved'>('conflict');
  const [choice, setChoice] = useState<string | null>(null);

  if (state === 'resolved') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={16} className="text-green-500 mb-1.5" />
      <p className="text-sm text-green-900">Conflict resolved · {choice}</p>
      <button onClick={() => { setState('conflict'); setChoice(null); }} className="text-xs text-green-600 mt-1.5 hover:underline">Reset</button>
    </div>
  );

  const options = [
    { label: 'Move to 4:00 PM Thursday', sub: 'Carlos is free all afternoon', icon: Clock,  color: 'border-blue-200 hover:border-blue-400' },
    { label: 'Assign Marcus Webb instead', sub: 'Marcus available all day Thu', icon: User,  color: 'border-green-200 hover:border-green-400' },
    { label: 'Keep at 2 PM — override',   sub: 'Carlos will have a double booking', icon: AlertTriangle, color: 'border-amber-200 hover:border-amber-400' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={15} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-900">Scheduling conflict detected</p>
            <p className="text-xs text-red-600 mt-0.5">Carlos Reyes already has Job #1043 at 2:00 PM Thursday</p>
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500 px-1">Choose a resolution:</p>
      {options.map(opt => {
        const Icon = opt.icon;
        return (
          <button key={opt.label} onClick={() => { setChoice(opt.label); setState('resolved'); }}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all ${opt.color} bg-white`}>
            <Icon size={14} className="text-slate-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-slate-800">{opt.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{opt.sub}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── 5 · External calendar sync status ─────────────────────────────────────
function SyncStatusDemo() {
  const [states, setStates] = useState({ google: 'synced', icloud: 'synced', outlook: 'error' });
  type SyncState = 'synced' | 'syncing' | 'error';

  function toggle(cal: keyof typeof states) {
    const cycle: Record<SyncState, SyncState> = { synced: 'syncing', syncing: 'error', error: 'synced' };
    setStates(s => ({ ...s, [cal]: cycle[s[cal] as SyncState] }));
  }

  const cals = [
    { key: 'google',  label: 'Google Calendar',     icon: '📅' },
    { key: 'icloud',  label: 'Apple Calendar',      icon: '🍎' },
    { key: 'outlook', label: 'Microsoft Outlook',   icon: '📧' },
  ];

  const STATE_CONFIG = {
    synced:  { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-100', label: 'Synced just now' },
    syncing: { icon: RefreshCw,   color: 'text-blue-500',  bg: 'bg-blue-100',  label: 'Syncing…' },
    error:   { icon: CloudOff,    color: 'text-red-500',   bg: 'bg-red-100',   label: 'Error — reconnect' },
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-slate-400 px-1">Tap any row to cycle through states</p>
      {cals.map(cal => {
        const s = states[cal.key as keyof typeof states] as SyncState;
        const cfg = STATE_CONFIG[s];
        const Icon = cfg.icon;
        return (
          <button key={cal.key} onClick={() => toggle(cal.key as keyof typeof states)}
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-left hover:bg-slate-50 transition-colors group">
            <span className="text-xl">{cal.icon}</span>
            <div className="flex-1">
              <p className="text-sm text-slate-800">{cal.label}</p>
              <p className={`text-xs mt-0.5 ${cfg.color}`}>{cfg.label}</p>
            </div>
            <span className={`flex size-7 items-center justify-center rounded-full ${cfg.bg}`}>
              <Icon size={13} className={`${cfg.color} ${s === 'syncing' ? 'animate-spin' : ''}`} />
            </span>
            {s === 'error' && (
              <span className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 hover:bg-red-100 transition-colors">
                Reconnect
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RECORDS DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1 · Resolve customer match ─────────────────────────────────────────────
function CustomerMatchDemo() {
  const [phase,  setPhase]  = useState<'matches' | 'resolved'>('matches');
  const [chosen, setChosen] = useState<string | null>(null);
  const candidates = [
    { id: 'c1', name: 'Sarah M. Davis', phone: '(512) 555-0192', address: '1847 Cedar Lane, Austin TX', jobs: 3, match: 94 },
    { id: 'c2', name: 'Sarah R. Davis', phone: '(512) 555-0844', address: '203 Oak Street, Austin TX',  jobs: 1, match: 71 },
  ];
  if (phase === 'resolved') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={15} className="text-green-500 mb-1.5" />
      <p className="text-sm text-green-900">{chosen === 'new' ? 'New customer created — Sarah Davis' : `Linked to ${candidates.find(c => c.id === chosen)?.name}`}</p>
      <p className="text-xs text-green-600 mt-0.5">Job will be created under this customer record</p>
      <button onClick={() => { setPhase('matches'); setChosen(null); }} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
        <AILabel text="✦ Customer match check" />
        <p className="text-sm text-slate-800 mt-1">Found <strong>2 existing customers</strong> that might match "Sarah Davis"</p>
        <p className="text-xs text-slate-500 mt-0.5">Review before creating a new contact</p>
      </div>
      {candidates.map(c => (
        <button key={c.id} onClick={() => setChosen(c.id)}
          className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-all ${chosen === c.id ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
          <span className="flex size-9 items-center justify-center rounded-full bg-slate-200 text-slate-700 shrink-0" style={{ fontSize: 12 }}>
            {c.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-slate-900">{c.name}</p>
              <span className={`rounded-full px-2 py-0.5 text-xs ${c.match >= 90 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{c.match}% match</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{c.phone} · {c.jobs} previous job{c.jobs !== 1 ? 's' : ''}</p>
            <p className="text-xs text-slate-400">{c.address}</p>
          </div>
          {chosen === c.id && <Check size={14} className="text-blue-500 shrink-0 mt-1" />}
        </button>
      ))}
      <button onClick={() => setChosen('new')}
        className={`flex items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 text-left transition-all ${chosen === 'new' ? 'border-slate-500 bg-slate-50' : 'border-slate-200 hover:border-slate-400'}`}>
        <span className="flex size-9 items-center justify-center rounded-full bg-slate-100 text-slate-400 text-sm shrink-0">+</span>
        <p className="text-sm text-slate-600">None of these — create new contact</p>
      </button>
      {chosen && (
        <button onClick={() => setPhase('resolved')}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Confirm selection
        </button>
      )}
    </div>
  );
}

// ── 2 · Resolve job match ──────────────────────────────────────────────────
function JobMatchDemo() {
  const [phase,  setPhase]  = useState<'compare' | 'resolved'>('compare');
  const [choice, setChoice] = useState<string | null>(null);
  if (phase === 'resolved') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <p className="text-sm text-green-900">{choice === 'existing' ? 'Linked to existing Job #1040 as follow-up' : 'Created as new separate job'}</p>
      <button onClick={() => { setPhase('compare'); setChoice(null); }} className="text-xs text-green-600 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3">
        <AILabel text="✦ Possible job match" />
        <p className="text-sm text-slate-800 mt-1">This new job is <strong>91% similar</strong> to an existing record</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Existing', num: '#1040', customer: 'P. Johnson', date: 'Feb 18', status: 'Completed', desc: 'Plumbing inspection',  tag: 'bg-slate-100 text-slate-600' },
          { label: 'New',      num: 'Draft', customer: 'P. Johnson', date: 'Mar 10', status: 'Draft',     desc: 'Plumbing check-up',   tag: 'bg-blue-100 text-blue-600' },
        ].map(j => (
          <div key={j.label} className={`rounded-xl border px-3.5 py-3 ${j.label === 'New' ? 'border-blue-200 bg-blue-50/40' : 'border-slate-200'}`}>
            <span className={`rounded-full px-2 py-0.5 text-xs ${j.tag}`}>{j.label}</span>
            <p className="text-sm text-slate-800 mt-2">{j.num}</p>
            <p className="text-xs text-slate-600">{j.customer}</p>
            <p className="text-xs text-slate-400 mt-0.5">{j.date} · {j.status}</p>
            <p className="text-xs text-slate-500 mt-1 italic">{j.desc}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {[
          { key: 'existing', label: 'Follow-up — link to Job #1040', sub: 'Keep history connected' },
          { key: 'new',      label: 'Different scope — create separate job', sub: 'No link to #1040' },
        ].map(opt => (
          <button key={opt.key} onClick={() => setChoice(opt.key)}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all ${choice === opt.key ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
            <div className="flex-1">
              <p className="text-sm text-slate-800">{opt.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{opt.sub}</p>
            </div>
            {choice === opt.key && <Check size={14} className="text-slate-700 shrink-0 mt-0.5" />}
          </button>
        ))}
      </div>
      {choice && (
        <button onClick={() => setPhase('resolved')}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Confirm
        </button>
      )}
    </div>
  );
}

// ── 3 · Create new lead/job from conversation ─────────────────────────────
function CreateLeadDemo() {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'parsed' | 'saved'>('idle');
  const parsed = {
    Customer:    'Tom Bradley',
    Phone:       '(512) 555-0312',
    Service:     'HVAC',
    Description: 'AC not cooling — unit 12+ yrs old, possible replacement',
    Priority:    'Urgent',
    Address:     '2201 Ridgeway Blvd, Austin TX',
  };
  if (phase === 'saved') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={18} className="text-green-500 shrink-0" />
      <div><p className="text-sm text-green-900">Job #1049 created · Tom Bradley · HVAC</p><p className="text-xs text-green-600">Unscheduled · Urgent · New customer added</p></div>
      <button onClick={() => { setPhase('idle'); setInput(''); }} className="ml-auto text-xs text-green-700 hover:underline">Reset</button>
    </div>
  );
  if (phase === 'parsed') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ Parsed from conversation" />
        <p className="text-xs text-slate-500 italic mt-0.5">"{input}"</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-50 overflow-hidden">
        {Object.entries(parsed).map(([k, v]) => (
          <div key={k} className="flex items-start gap-3 px-4 py-2.5">
            <span className="text-xs text-slate-400 w-20 shrink-0 pt-0.5">{k}</span>
            <p className="flex-1 text-sm text-slate-800">{v}</p>
            {k === 'Priority' && <span className="text-xs text-red-600 bg-red-50 rounded-full px-2 py-0.5 shrink-0">Urgent</span>}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setPhase('saved')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Create job
        </button>
        <button onClick={() => setPhase('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors">Edit</button>
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 focus-within:border-indigo-400 transition-colors">
          <Mic size={14} className="text-slate-400 shrink-0" />
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && input.trim() && setPhase('parsed')}
            placeholder="Describe a new lead or customer request…"
            className="flex-1 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
        </div>
        <button onClick={() => input.trim() && setPhase('parsed')} disabled={!input.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all">
          <ArrowRight size={16} />
        </button>
      </div>
      <button onClick={() => { setInput("Tom Bradley called, AC not cooling, urgent, 2201 Ridgeway Blvd, new customer"); setPhase('parsed'); }}
        className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 transition-colors">
        <ChevronRight size={11} className="text-slate-400" /> Try: "Tom Bradley called, AC not cooling, urgent, new customer"
      </button>
    </div>
  );
}

// ── 4 · Surface duplicate warning ─────────────────────────────────────────
function DuplicateWarningDemo() {
  const [dismissed, setDismissed] = useState(false);
  const [reviewed,  setReviewed]  = useState(false);
  if (reviewed) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <p className="text-sm text-green-900">Confirmed as new — different scope than #1040</p>
      <button onClick={() => { setDismissed(false); setReviewed(false); }} className="text-xs text-green-600 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <p className="text-xs text-slate-500 mb-2.5">Creating new job</p>
        <div className="flex flex-col gap-1.5">
          {[['Customer', 'Patricia Johnson'], ['Service', 'Plumbing inspection'], ['Address', '420 Birchwood Dr, Austin']].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-20 shrink-0">{k}</span>
              <span className="text-sm text-slate-800">{v}</span>
            </div>
          ))}
        </div>
      </div>
      {!dismissed && !reviewed && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-100">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-amber-900">Possible duplicate — <strong>91% match</strong> with Job #1040</p>
              <p className="text-xs text-amber-700 mt-0.5">Patricia Johnson · Plumbing inspection · Feb 18 · Completed</p>
              <div className="flex items-center gap-2 mt-2.5">
                <button onClick={() => setReviewed(true)} className="flex items-center gap-1 text-xs text-amber-800 bg-amber-200 hover:bg-amber-300 rounded-lg px-2.5 py-1.5 transition-colors">
                  Review #1040
                </button>
                <button onClick={() => setDismissed(true)} className="text-xs text-amber-600 hover:underline">Not a duplicate</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dismissed && (
        <div className="px-4 py-3 border-t border-slate-100">
          <button className="w-full rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
            Create job
          </button>
        </div>
      )}
    </div>
  );
}

// ── 5 · Review suggested merge candidate ──────────────────────────────────
function MergeCandidateDemo() {
  const [fields, setFields] = useState<Record<string, 'a' | 'b'>>({});
  const [merged, setMerged] = useState(false);
  const conflictFields = [
    { key: 'phone',   label: 'Phone',   a: '(512) 555-0192', b: '(512) 555-0901'     },
    { key: 'email',   label: 'Email',   a: 'sdavis@email.com', b: 'sarah.d@gmail.com' },
    { key: 'address', label: 'Address', a: '1847 Cedar Lane', b: '1847 Cedar Ln TX'   },
  ];
  const resolvedCount = Object.keys(fields).length;
  if (merged) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={15} className="text-green-500 mb-1.5" />
      <p className="text-sm text-green-900">Records merged — Sarah M. Davis (unified)</p>
      <p className="text-xs text-green-600 mt-0.5">3 jobs combined · Duplicate removed</p>
      <button onClick={() => { setMerged(false); setFields({}); }} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-violet-50 border border-violet-200 px-4 py-3">
        <AILabel text="✦ Merge candidate" />
        <p className="text-sm text-slate-800 mt-1">Two records appear to be the same person. Pick which value to keep for each conflict.</p>
      </div>
      <div className="grid grid-cols-[72px_1fr_1fr] gap-2 px-1">
        <div />
        {['Record A', 'Record B'].map((l, i) => (
          <div key={l} className={`rounded-lg text-center py-1.5 text-xs ${i === 0 ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{l}</div>
        ))}
      </div>
      {conflictFields.map(f => (
        <div key={f.key} className="grid grid-cols-[72px_1fr_1fr] gap-2 items-center">
          <p className="text-xs text-slate-400">{f.label}</p>
          {(['a', 'b'] as const).map(side => (
            <button key={side} onClick={() => setFields(prev => ({ ...prev, [f.key]: side }))}
              className={`rounded-xl border px-3 py-2.5 text-left transition-all ${fields[f.key] === side ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm' : 'border-slate-200 bg-white text-slate-700 text-xs hover:border-slate-300'}`}
              style={{ fontSize: 12 }}>
              {side === 'a' ? f.a : f.b}
              {fields[f.key] === side && <Check size={10} className="inline ml-1 text-blue-500" />}
            </button>
          ))}
        </div>
      ))}
      {resolvedCount === conflictFields.length ? (
        <button onClick={() => setMerged(true)}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Merge records
        </button>
      ) : (
        <p className="text-xs text-center text-slate-400">{resolvedCount}/{conflictFields.length} fields resolved — pick a value for each</p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1 · Estimate draft from conversation ─────────────────────────────────
function EstimateDraftDemo() {
  const [input,    setInput]    = useState('');
  const [phase,    setPhase]    = useState<'idle' | 'drafting' | 'done'>('idle');
  const [visLines, setVisLines] = useState(0);
  const lineItems = [
    { desc: 'HVAC tune-up labor',            qty: 1, rate: 195, note: 'Standard 2hr rate'   },
    { desc: 'Filter replacement (2 units)',  qty: 2, rate: 28,  note: 'Based on unit size'  },
    { desc: 'Thermostat calibration',        qty: 1, rate: 45,  note: 'Standard service'    },
    { desc: 'Coolant level check & top-off', qty: 1, rate: 65,  note: 'If needed'           },
  ];
  function draft(q: string) {
    if (!q.trim()) return;
    setInput(q); setPhase('drafting'); setVisLines(0);
    let i = 0;
    const t = setInterval(() => {
      i++; setVisLines(i);
      if (i >= lineItems.length) { clearInterval(t); setPhase('done'); }
    }, 380);
  }
  if (phase !== 'idle') return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ Drafting estimate" />
        <p className="text-xs text-slate-500 mt-0.5 italic">"{input}"</p>
      </div>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="grid grid-cols-[1fr_32px_56px_56px] gap-x-2 px-4 py-2 bg-slate-50 border-b border-slate-100">
          {['Item', 'Qty', 'Rate', 'Total'].map(h => <p key={h} className="text-xs text-slate-400 last:text-right">{h}</p>)}
        </div>
        {lineItems.slice(0, visLines).map((item, i) => (
          <div key={i} className="grid grid-cols-[1fr_32px_56px_56px] gap-x-2 px-4 py-2.5 border-b border-slate-50 items-start" style={{ animation: 'stepIn 0.25s ease' }}>
            <div>
              <p className="text-sm text-slate-800">{item.desc}</p>
              <p className="text-xs text-slate-400">{item.note}</p>
            </div>
            <p className="text-sm text-slate-500 text-right">{item.qty}</p>
            <p className="text-sm text-slate-500 text-right">${item.rate}</p>
            <p className="text-sm text-slate-800 text-right">${item.qty * item.rate}</p>
          </div>
        ))}
        {phase === 'done' && (
          <div className="flex justify-between px-4 py-3 bg-slate-900 rounded-b-xl" style={{ animation: 'stepIn 0.2s ease' }}>
            <p className="text-sm text-slate-300">Estimate total</p>
            <p className="text-white text-sm">${lineItems.reduce((s, i) => s + i.qty * i.rate, 0)}</p>
          </div>
        )}
      </div>
      {phase === 'done' && (
        <div className="flex gap-2" style={{ animation: 'stepIn 0.3s ease' }}>
          <button className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Check size={14} /> Save estimate
          </button>
          <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Edit lines</button>
        </div>
      )}
      <button onClick={() => { setPhase('idle'); setInput(''); setVisLines(0); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 focus-within:border-indigo-400 transition-colors">
          <Mic size={14} className="text-slate-400 shrink-0" />
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && draft(input)}
            placeholder="Describe the work and I'll draft an estimate…"
            className="flex-1 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
        </div>
        <button onClick={() => draft(input)} disabled={!input.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all">
          <ArrowRight size={16} />
        </button>
      </div>
      <button onClick={() => draft("HVAC tune-up, two units, replace filters, thermostat check, coolant top-off if needed")}
        className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 transition-colors">
        <ChevronRight size={11} className="text-slate-400" /> Try: "HVAC tune-up, two units, replace filters, thermostat check"
      </button>
    </div>
  );
}

// ── 2 · Pricing suggestion review ─────────────────────────────────────────
function PricingReviewDemo() {
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'kept'>>({});
  const [applied,   setApplied]   = useState(false);
  const suggestions = [
    { key: 'labor',       desc: 'HVAC labor (per hour)',        current: 85, suggested: 95, reason: '12% below local market avg · Austin avg $96/hr' },
    { key: 'filter',      desc: 'Filter replacement',           current: 28, suggested: 28, reason: 'Competitive — no change needed' },
    { key: 'refrigerant', desc: 'R-410A refrigerant (per lb)',  current: 45, suggested: 58, reason: '23% below market · Wholesale up 18% this quarter' },
  ];
  const allDecided = suggestions.every(s => decisions[s.key] || s.current === s.suggested);
  if (applied) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5">
      <p className="text-sm text-green-900">Prices updated on EST-0047</p>
      <p className="text-xs text-green-600 mt-0.5">{Object.values(decisions).filter(v => v === 'accepted').length} suggestion{Object.values(decisions).filter(v => v === 'accepted').length !== 1 ? 's' : ''} accepted</p>
      <button onClick={() => { setApplied(false); setDecisions({}); }} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ Pricing review · EST-0047" />
        <p className="text-sm text-slate-800 mt-1">Based on local market data and job history — {suggestions.filter(s => s.current !== s.suggested).length} suggestions</p>
      </div>
      {suggestions.map(s => (
        <div key={s.key} className={`rounded-xl border overflow-hidden ${decisions[s.key] === 'accepted' ? 'border-green-200' : decisions[s.key] === 'kept' ? 'border-slate-200' : 'border-indigo-200'}`}>
          <div className="px-4 py-3 bg-white">
            <p className="text-sm text-slate-800">{s.desc}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.reason}</p>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs text-slate-400">Current <span className={`text-sm ${s.current !== s.suggested ? 'text-amber-700' : 'text-slate-700'}`}>${s.current}</span></span>
              {s.current !== s.suggested && (<><ArrowRight size={11} className="text-slate-300" /><span className="text-xs text-slate-400">Suggested <span className="text-sm text-green-700">${s.suggested}</span></span></>)}
            </div>
          </div>
          {s.current !== s.suggested && !decisions[s.key] && (
            <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50">
              <button onClick={() => setDecisions(p => ({ ...p, [s.key]: 'accepted' }))} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3.5 py-2 text-xs text-white hover:bg-green-700 transition-colors">
                <Check size={11} /> Accept ${s.suggested}
              </button>
              <button onClick={() => setDecisions(p => ({ ...p, [s.key]: 'kept' }))} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
                Keep ${s.current}
              </button>
            </div>
          )}
          {decisions[s.key] === 'accepted' && <div className="flex items-center gap-1.5 px-4 py-2 border-t border-green-100 bg-green-50"><Check size={11} className="text-green-500" /><span className="text-xs text-green-700">Updated to ${s.suggested}</span></div>}
          {decisions[s.key] === 'kept' && <div className="px-4 py-2 border-t border-slate-100 bg-slate-50"><span className="text-xs text-slate-400">Keeping ${s.current}</span></div>}
        </div>
      ))}
      {allDecided && (
        <button onClick={() => setApplied(true)}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Apply changes to estimate
        </button>
      )}
    </div>
  );
}

// ── 3 · Estimate approval capture ─────────────────────────────────────────
function ApprovalCaptureDemo() {
  const [phase, setPhase] = useState<'pending' | 'captured'>('pending');
  return phase === 'pending' ? (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
        <AILabel text="✦ Awaiting approval" />
        <p className="text-sm text-slate-800 mt-1">EST-0046 · Davis · $4,220 · Sent 3 days ago</p>
        <p className="text-xs text-slate-500 mt-0.5">Customer link: fieldly.app/e/e2</p>
      </div>
      <button onClick={() => setPhase('captured')}
        className="flex items-center justify-center gap-2 rounded-xl border border-green-300 bg-green-50 text-green-800 py-3 text-sm hover:bg-green-100 transition-colors">
        <Sparkles size={13} /> Simulate: customer just approved →
      </button>
    </div>
  ) : (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.25s ease' }}>
      <div className="rounded-xl border border-green-300 bg-green-50 overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-2 border-b border-green-200">
          <CheckCircle2 size={16} className="text-green-500" />
          <p className="text-sm text-green-900">Estimate approved by customer</p>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2">
          {[['Estimate', 'EST-0046 · $4,220'], ['Customer', 'Sarah Davis'], ['Accepted by', 'Sarah Davis (signed)'], ['Timestamp', 'Mar 10, 2026 · 2:14 PM'], ['Method', 'Signature + name']].map(([l, v]) => (
            <div key={l} className="flex items-center gap-3">
              <span className="text-xs text-slate-400 w-24 shrink-0">{l}</span>
              <span className="text-sm text-slate-800">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl bg-white border border-slate-200 px-4 py-3">
        <p className="text-xs text-slate-500 mb-1.5">Signature on file</p>
        <div className="h-12 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center">
          <span className="text-slate-400 italic" style={{ fontFamily: 'cursive', fontSize: 22 }}>Sarah Davis</span>
        </div>
      </div>
      <div className="flex gap-2">
        <button className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-blue-600 text-white py-2.5 text-sm hover:bg-blue-700 transition-colors">
          <Zap size={13} /> Create invoice now
        </button>
        <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Schedule job</button>
      </div>
      <button onClick={() => setPhase('pending')} className="text-xs text-center text-slate-400 hover:text-slate-600">Reset</button>
    </div>
  );
}

// ── 4 · Invoice draft from job completion ─────────────────────────────────
function InvoiceDraftDemo() {
  const [phase, setPhase] = useState<'active' | 'complete' | 'drafted' | 'sent'>('active');
  const lineItems = [
    { desc: 'HVAC repair labor (3 hrs)', qty: 3, rate: 95 },
    { desc: 'Capacitor replacement',     qty: 1, rate: 85 },
    { desc: 'Refrigerant top-off',       qty: 1, rate: 65 },
  ];
  const total = lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className={`rounded-xl border px-4 py-3.5 transition-all ${phase === 'active' ? 'border-blue-200 bg-blue-50' : 'border-green-200 bg-green-50'}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500">Job #1042 · Rodriguez · HVAC</p>
            <p className="text-sm text-slate-800 mt-0.5">Carlos Reyes · 9:00 AM – 12:00 PM</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs ${phase === 'active' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
            {phase === 'active' ? 'Active' : 'Completed'}
          </span>
        </div>
        {phase === 'active' && (
          <button onClick={() => setPhase('complete')} className="mt-3 flex items-center gap-2 rounded-xl bg-green-600 text-white px-4 py-2.5 text-sm hover:bg-green-700 transition-colors">
            <Check size={14} /> Mark job complete
          </button>
        )}
      </div>
      {phase === 'complete' && (
        <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <AILabel text="✦ Job complete — drafting invoice" />
          <p className="text-sm text-slate-700 mt-1">Pulled materials and labor from Carlos's notes. Review and send when ready.</p>
          <button onClick={() => setPhase('drafted')} className="mt-2 flex items-center gap-1 text-xs text-indigo-700 hover:underline">View draft <ArrowRight size={11} /></button>
        </div>
      )}
      {(phase === 'drafted' || phase === 'sent') && (
        <div className="rounded-xl border border-slate-200 overflow-hidden" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
            <span className="text-xs text-slate-500">Draft · Roberto Rodriguez</span>
            <span className="flex items-center gap-1 text-xs text-indigo-600"><Sparkles size={9} /> AI drafted</span>
          </div>
          <div className="divide-y divide-slate-50">
            {lineItems.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_32px_56px_56px] gap-x-2 px-4 py-2.5 items-center">
                <p className="text-sm text-slate-800">{item.desc}</p>
                <p className="text-sm text-slate-400 text-right">{item.qty}</p>
                <p className="text-sm text-slate-400 text-right">${item.rate}</p>
                <p className="text-sm text-slate-800 text-right">${item.qty * item.rate}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 rounded-b-xl">
            <p className="text-sm text-slate-300">Total due</p>
            <p className="text-white">${total}</p>
          </div>
        </div>
      )}
      {phase === 'drafted' && (
        <div className="flex gap-2" style={{ animation: 'stepIn 0.3s ease' }}>
          <button onClick={() => setPhase('sent')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Send size={13} /> Send invoice
          </button>
          <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Edit</button>
        </div>
      )}
      {phase === 'sent' && (
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-sm text-green-900">Invoice sent · Payment link active for Roberto</p>
          <button onClick={() => setPhase('active')} className="text-xs text-green-700 mt-1.5 hover:underline">Reset demo</button>
        </div>
      )}
    </div>
  );
}

// ── 5 · Hosted payment handoff ────────────────────────────────────────────
function PaymentHandoffDemo() {
  const [copied, setCopied] = useState(false);
  const [sent,   setSent]   = useState<'sms' | 'email' | null>(null);
  const link = 'fieldly.app/pay/inv-0087';
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3">
        <AILabel text="✦ Payment link ready" />
        <p className="text-sm text-slate-800 mt-1">INV-0087 · Roberto Rodriguez · <strong>$425.00</strong></p>
        <p className="text-xs text-slate-500 mt-0.5">Due Mar 17 · Hosted payment page · Card &amp; ACH</p>
      </div>
      <div className="flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-3">
        <p className="flex-1 text-sm text-slate-700 font-mono truncate">{link}</p>
        <button onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className={`shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all ${copied ? 'bg-green-500 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
          {copied ? <><Check size={11} /> Copied</> : 'Copy link'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {([['sms', 'Send via SMS', MessageSquare], ['email', 'Send via email', Mail]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setSent(k)}
            className={`flex items-center justify-center gap-2 rounded-xl border py-3 text-sm transition-all ${sent === k ? 'border-green-400 bg-green-50 text-green-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
            {sent === k ? <><Check size={14} /> Sent</> : <><Icon size={14} /> {label}</>}
          </button>
        ))}
      </div>
      {sent && (
        <div className="rounded-xl bg-white border border-slate-200 px-4 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-xs text-slate-500 mb-1">{sent === 'sms' ? 'SMS preview' : 'Email subject'}</p>
          <p className="text-sm text-slate-700">
            {sent === 'sms' ? `"Hi Roberto, invoice INV-0087 for $425 is ready. Pay: ${link}"` : 'Invoice from Austin Pro Services — $425.00 due Mar 17'}
          </p>
          <p className="text-xs text-green-600 mt-1.5">✓ Delivered · Customer sees card &amp; ACH options</p>
        </div>
      )}
    </div>
  );
}

// ── 6 · Cancellation/no-show fee suggestion ───────────────────────────────
function CancellationFeeDemo() {
  const [phase,  setPhase]  = useState<'suggest' | 'edit' | 'applied' | 'dismissed'>('suggest');
  const [amount, setAmount] = useState('75');
  if (phase === 'applied') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5">
      <p className="text-sm text-green-900">No-show fee of <strong>${amount}</strong> added to next invoice</p>
      <p className="text-xs text-green-600 mt-0.5">Draft INV-0088 created for Johnson · Sends separately</p>
      <button onClick={() => { setPhase('suggest'); setAmount('75'); }} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  if (phase === 'dismissed') return (
    <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3.5 opacity-70">
      <p className="text-xs text-slate-400 italic">Fee waived — noted in customer record</p>
      <button onClick={() => setPhase('suggest')} className="text-xs text-blue-500 mt-1 hover:underline">Reset</button>
    </div>
  );
  if (phase === 'edit') return (
    <div className="rounded-xl border border-amber-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-100"><p className="text-xs text-amber-700">Edit no-show fee</p></div>
      <div className="px-4 py-3 flex flex-col gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Fee amount</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
            <input value={amount} onChange={e => setAmount(e.target.value)} className="w-full rounded-xl border border-slate-200 pl-6 pr-3 py-2.5 text-sm focus:outline-none focus:border-amber-400 transition-colors" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setPhase('applied')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-amber-600 text-white py-2.5 text-sm hover:bg-amber-700 transition-colors">
            <Check size={14} /> Add ${amount} fee
          </button>
          <button onClick={() => setPhase('suggest')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="rounded-xl border border-amber-200 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-slate-800">Job #1043 — no-show recorded</p>
            <p className="text-xs text-slate-500 mt-0.5">Patricia Johnson · Today 2:00 PM · Marcus dispatched</p>
          </div>
        </div>
      </div>
      <div className="px-4 py-3 bg-amber-50 border-t border-amber-100">
        <AILabel text="✦ Fee suggestion" />
        <p className="text-sm text-slate-800 mt-1">Add a <strong>$75 no-show fee</strong> to her next invoice?</p>
        <p className="text-xs text-slate-500 mt-0.5">Matches your standard cancellation policy (under 24hr notice)</p>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => setPhase('applied')} className="flex items-center gap-1.5 rounded-xl bg-amber-600 text-white px-3.5 py-2 text-xs hover:bg-amber-700 transition-colors">
            <Check size={11} /> Add $75 fee
          </button>
          <button onClick={() => setPhase('edit')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
            <Pencil size={11} /> Change amount
          </button>
          <button onClick={() => setPhase('dismissed')} className="px-3 py-2 text-xs text-slate-400 hover:text-slate-600">Waive</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1+2 · Voice capture + text fallback ───────────────────────────────────
function VoiceCaptureDemo() {
  const [mode,   setMode]   = useState<'voice' | 'text'>('voice');
  const [phase,  setPhase]  = useState<'idle' | 'recording' | 'transcribed'>('idle');
  const [transcript, setTranscript] = useState('');
  const ANSWER = "We mostly do HVAC and a little plumbing. About 15 to 20 jobs a week, mostly residential. Two techs — Carlos and Marcus.";

  function startRecord() {
    setPhase('recording'); setTranscript('');
    let i = 0;
    const t = setInterval(() => {
      i += 3; setTranscript(ANSWER.slice(0, i));
      if (i >= ANSWER.length) { clearInterval(t); setPhase('transcribed'); }
    }, 35);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex p-1 rounded-xl bg-slate-100 gap-1">
        {(['voice', 'text'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setPhase('idle'); setTranscript(''); }}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs transition-all ${mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {m === 'voice' ? <><Mic size={12} /> Voice</> : <><Pencil size={12} /> Text fallback</>}
          </button>
        ))}
      </div>
      <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-full bg-slate-900 mb-3">
          <Sparkles size={14} className="text-white" />
        </div>
        <p className="text-sm text-slate-800">What type of work do you do, and roughly how many jobs per week?</p>
      </div>
      {mode === 'voice' ? (
        <div className="flex flex-col items-center gap-3">
          {phase === 'idle' && (
            <>
              <button onClick={startRecord}
                className="flex size-16 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors shadow-lg shadow-red-200 active:scale-95">
                <Mic size={24} />
              </button>
              <p className="text-xs text-slate-400">Tap to start recording</p>
            </>
          )}
          {phase === 'recording' && (
            <div className="flex flex-col items-center gap-3 w-full">
              <button className="flex size-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-200 animate-pulse">
                <Mic size={24} />
              </button>
              <div className="flex items-end gap-0.5 h-10 w-full justify-center">
                {Array.from({ length: 28 }).map((_, i) => (
                  <div key={i} className="w-1 rounded-full bg-red-400"
                    style={{ height: `${14 + Math.abs(Math.sin(i * 1.1)) * 18}px`, opacity: 0.5 + Math.abs(Math.sin(i * 0.7)) * 0.5,
                      animation: `pulse ${0.5 + (i % 4) * 0.15}s ease-in-out infinite alternate` }} />
                ))}
              </div>
              {transcript && (
                <div className="w-full rounded-xl bg-white border border-slate-200 px-4 py-3">
                  <p className="text-xs text-indigo-500 mb-1 flex items-center gap-1"><Sparkles size={9} /> Transcribing…</p>
                  <p className="text-sm text-slate-700">{transcript}<span className="animate-pulse">|</span></p>
                </div>
              )}
            </div>
          )}
          {phase === 'transcribed' && (
            <div className="w-full flex flex-col gap-2" style={{ animation: 'stepIn 0.2s ease' }}>
              <div className="rounded-xl bg-white border border-slate-200 px-4 py-3">
                <p className="text-xs text-indigo-600 mb-1 flex items-center gap-1"><Sparkles size={9} /> Transcribed</p>
                <p className="text-sm text-slate-800">{ANSWER}</p>
              </div>
              <div className="flex gap-2">
                <button className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
                  <Check size={14} /> Use this answer
                </button>
                <button onClick={() => setPhase('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Re-record</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="rounded-xl bg-amber-50 border border-amber-100 px-3.5 py-2.5 flex items-center gap-2">
            <Mic size={12} className="text-amber-500" />
            <p className="text-xs text-amber-700">Switched to text mode — voice is still available above</p>
          </div>
          <textarea rows={3} placeholder="Type your answer here…"
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors resize-none" />
          <button className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Check size={14} /> Submit answer
          </button>
        </div>
      )}
    </div>
  );
}

// ── 3 · Config proposal review ────────────────────────────────────────────
function ConfigProposalDemo() {
  const [settings, setSettings] = useState({ invoice_auto: true, sms_confirm: true, followup_3d: true, trip_fee: false, quickbooks: false });
  const [accepted, setAccepted] = useState(false);
  const items = [
    { key: 'invoice_auto', label: 'Auto-draft invoices on job completion', sub: 'From: "I always invoice right after the job"' },
    { key: 'sms_confirm',  label: 'Send SMS appointment confirmations',    sub: 'From: "I text customers the day before"' },
    { key: 'followup_3d',  label: 'Follow up on estimates after 3 days',   sub: 'From: "I check back if I don\'t hear back"' },
    { key: 'trip_fee',     label: 'Automatic trip fee for jobs under 2hrs', sub: 'Mentioned dispatch fee — needs confirmation' },
    { key: 'quickbooks',   label: 'QuickBooks sync',                       sub: '⚠ Not yet available — noted for your account' },
  ];
  if (accepted) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5">
      <p className="text-sm text-green-900">Configuration saved · {Object.values(settings).filter(Boolean).length} rules active</p>
      <p className="text-xs text-green-600 mt-0.5">Editable anytime in Settings → Automations</p>
      <button onClick={() => setAccepted(false)} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ Based on your answers, here's your suggested setup" />
        <p className="text-sm text-slate-700 mt-1">Toggle anything before we go live</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-50 overflow-hidden">
        {items.map(item => {
          const disabled = item.key === 'quickbooks';
          const checked  = settings[item.key as keyof typeof settings];
          return (
            <div key={item.key} className={`flex items-start gap-3 px-4 py-3.5 ${disabled ? 'opacity-50' : ''}`}>
              <button disabled={disabled}
                onClick={() => !disabled && setSettings(p => ({ ...p, [item.key]: !p[item.key as keyof typeof settings] }))}
                className="relative shrink-0 mt-0.5 rounded-full transition-all"
                style={{ width: 36, height: 20, backgroundColor: checked ? '#4f46e5' : '#cbd5e1' }}>
                <span className="absolute size-4 rounded-full bg-white shadow transition-all top-0.5"
                  style={{ left: checked ? 18 : 2 }} />
              </button>
              <div className="flex-1">
                <p className="text-sm text-slate-800">{item.label}</p>
                <p className="text-xs text-slate-400 mt-0.5">{item.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => setAccepted(true)}
        className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
        <Check size={14} /> Confirm this setup
      </button>
    </div>
  );
}

// ── 4 · Rule confirmation ──────────────────────────────────────────────────
function RuleConfirmationDemo() {
  const [phase, setPhase] = useState<'propose' | 'edit' | 'confirmed' | 'skipped'>('propose');
  const [fee,   setFee]   = useState('35');
  const [hrs,   setHrs]   = useState('2');
  if (phase === 'confirmed') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5">
      <p className="text-sm text-green-900">Rule added · Trip fee <strong>${fee}</strong> for jobs under <strong>{hrs} hrs</strong></p>
      <p className="text-xs text-green-600 mt-0.5">Auto-applies to new invoices · Edit in Settings → Rules</p>
      <button onClick={() => { setPhase('propose'); setFee('35'); setHrs('2'); }} className="text-xs text-green-700 mt-1.5 hover:underline">Reset</button>
    </div>
  );
  if (phase === 'skipped') return (
    <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3.5 opacity-70">
      <p className="text-xs text-slate-400 italic">Skipped — add later in Settings → Rules</p>
      <button onClick={() => setPhase('propose')} className="text-xs text-blue-500 mt-1 hover:underline">Reset</button>
    </div>
  );
  if (phase === 'edit') return (
    <div className="rounded-xl border border-indigo-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-indigo-50 border-b border-indigo-100"><p className="text-xs text-indigo-700">Edit rule parameters</p></div>
      <div className="px-4 py-3 flex flex-col gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Trip fee amount ($)</label>
          <input value={fee} onChange={e => setFee(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400 transition-colors" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Apply when job is under (hours)</label>
          <input value={hrs} onChange={e => setHrs(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400 transition-colors" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => setPhase('confirmed')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 text-white py-2.5 text-sm hover:bg-indigo-700 transition-colors">
            <Check size={13} /> Save rule
          </button>
          <button onClick={() => setPhase('propose')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="rounded-xl border border-violet-200 overflow-hidden">
      <div className="px-4 py-3">
        <AILabel text="✦ Rule to confirm" />
        <p className="text-sm text-slate-800 mt-1">You mentioned charging a trip fee for shorter jobs. Want me to set that as an automatic rule?</p>
      </div>
      <div className="mx-4 mb-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
        <p className="text-xs text-slate-500 mb-2">Proposed rule</p>
        {[['Trigger', `Job duration < ${hrs} hours`], ['Action', `Add $${fee} trip fee to invoice`], ['Scope', 'All future jobs']].map(([l, v]) => (
          <div key={l} className="flex items-center gap-2 mb-1">
            <span className="text-xs text-slate-400 w-16">{l}</span>
            <span className="text-sm text-slate-700">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 px-4 pb-4">
        <button onClick={() => setPhase('confirmed')} className="flex items-center gap-1.5 rounded-xl bg-violet-600 text-white px-3.5 py-2 text-xs hover:bg-violet-700 transition-colors">
          <Check size={11} /> Confirm rule
        </button>
        <button onClick={() => setPhase('edit')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
          <Pencil size={11} /> Edit
        </button>
        <button onClick={() => setPhase('skipped')} className="px-3 py-2 text-xs text-slate-400 hover:text-slate-600">Skip</button>
      </div>
    </div>
  );
}

// ── 5 · Unsupported preference capture ────────────────────────────────────
function UnsupportedPrefDemo() {
  const [notified, setNotified] = useState(false);
  const [active,   setActive]   = useState(0);
  const examples = [
    { pref: 'I use QuickBooks for everything', resp: "QuickBooks integration isn't live yet — noted for your account.", roadmap: true },
    { pref: 'I want a customer-facing portal', resp: "Self-serve portal is on our 2026 roadmap — I've noted this.", roadmap: true },
    { pref: 'I need time tracking for techs',  resp: "Tech time tracking is in beta — I've added you to the waitlist.", roadmap: false },
  ];
  const ex = examples[active];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        {examples.map((_, i) => (
          <button key={i} onClick={() => { setActive(i); setNotified(false); }}
            className={`rounded-full border px-3 py-1.5 text-xs transition-all ${active === i ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
            Example {i + 1}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-slate-900 px-4 py-3">
            <p className="text-sm text-white">{ex.pref}</p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-indigo-100">
            <Sparkles size={12} className="text-indigo-600" />
          </div>
          <div className="flex-1">
            <div className="rounded-2xl rounded-tl-sm bg-white border border-slate-200 px-4 py-3">
              <p className="text-sm text-slate-800">{ex.resp}</p>
              {ex.roadmap && <p className="text-xs text-slate-400 mt-1.5">We'll let you know when it's ready.</p>}
            </div>
            {!notified ? (
              <button onClick={() => setNotified(true)}
                className="mt-2 flex items-center gap-1.5 rounded-xl bg-indigo-50 border border-indigo-200 px-3.5 py-2 text-xs text-indigo-700 hover:bg-indigo-100 transition-colors">
                <Bell size={11} /> Notify me when available
              </button>
            ) : (
              <div className="mt-2 flex items-center gap-1.5 rounded-xl bg-green-50 border border-green-200 px-3.5 py-2 text-xs text-green-700"
                style={{ animation: 'stepIn 0.2s ease' }}>
                <Check size={11} /> Got it — you're on the list
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM STATE DEMOS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1 · Loading ────────────────────────────────────────────────────────────
function LoadingDemo() {
  const [variant, setVariant] = useState<'skeleton' | 'spinner' | 'progress'>('skeleton');
  const [phase,   setPhase]   = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [pct,     setPct]     = useState(0);

  function trigger() {
    setPhase('loading'); setPct(0);
    if (variant === 'progress') {
      let p = 0;
      const t = setInterval(() => {
        p += Math.random() * 18 + 5;
        if (p >= 100) { p = 100; clearInterval(t); setPhase('loaded'); }
        setPct(Math.min(Math.round(p), 100));
      }, 180);
    } else {
      setTimeout(() => setPhase('loaded'), 2000);
    }
  }

  const rows = [
    { init: 'RR', name: 'Roberto Rodriguez', sub: 'HVAC tune-up · #1042', tag: 'Active',    c: 'bg-blue-100 text-blue-700'  },
    { init: 'SD', name: 'Sarah Davis',       sub: 'EST-0046 · $4,220',   tag: 'Pending',   c: 'bg-amber-100 text-amber-700' },
    { init: 'PJ', name: 'P. Johnson',        sub: 'Plumbing · #1040',    tag: 'Scheduled', c: 'bg-green-100 text-green-700' },
    { init: 'TB', name: 'Tom Bradley',       sub: 'AC inspection · Draft', tag: 'Draft',   c: 'bg-slate-100 text-slate-500' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex p-1 gap-1 rounded-xl bg-slate-100">
        {(['skeleton', 'spinner', 'progress'] as const).map(v => (
          <button key={v} onClick={() => { setVariant(v); setPhase('idle'); }}
            className={`flex-1 rounded-lg py-2 text-xs capitalize transition-all ${variant === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {v}
          </button>
        ))}
      </div>

      {phase === 'idle' && (
        <button onClick={trigger}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors">
          Trigger {variant} load
        </button>
      )}

      {phase === 'loading' && variant === 'skeleton' && (
        <div className="flex flex-col gap-2">
          {[78, 55, 90, 67].map((w, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-100 px-4 py-3.5">
              <div className="size-9 rounded-full bg-slate-200 animate-pulse shrink-0" />
              <div className="flex-1 flex flex-col gap-1.5">
                <div className="h-3 rounded-full bg-slate-200 animate-pulse" style={{ width: `${w}%` }} />
                <div className="h-2 rounded-full bg-slate-100 animate-pulse" style={{ width: `${w * 0.55}%` }} />
              </div>
              <div className="h-5 w-14 rounded-full bg-slate-200 animate-pulse shrink-0" />
            </div>
          ))}
        </div>
      )}

      {phase === 'loading' && variant === 'spinner' && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="size-8 rounded-full border-2 border-slate-200 border-t-blue-600 animate-spin" />
          <p className="text-sm text-slate-500">Loading jobs…</p>
        </div>
      )}

      {phase === 'loading' && variant === 'progress' && (
        <div className="flex flex-col gap-2.5 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-700">Fetching job data…</p>
            <p className="text-xs text-slate-400 tabular-nums">{pct}%</p>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-200" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-slate-400">Syncing 4 records · Fieldly cloud</p>
        </div>
      )}

      {phase === 'loaded' && (
        <div className="flex flex-col gap-2" style={{ animation: 'stepIn 0.3s ease' }}>
          <div className="flex items-center gap-1.5 rounded-xl bg-green-50 border border-green-200 px-3.5 py-2">
            <CheckCircle2 size={12} className="text-green-500" />
            <span className="text-xs text-green-700">Loaded · 4 records</span>
          </div>
          {rows.map(r => (
            <div key={r.init} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-slate-800 text-white shrink-0" style={{ fontSize: 10 }}>{r.init}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">{r.name}</p>
                <p className="text-xs text-slate-400">{r.sub}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${r.c}`}>{r.tag}</span>
            </div>
          ))}
          <button onClick={() => setPhase('idle')} className="text-xs text-center text-slate-400 hover:text-slate-600 mt-1">Reset</button>
        </div>
      )}
    </div>
  );
}

// ── 2 · Empty ──────────────────────────────────────────────────────────────
function EmptyDemo() {
  const [ctx,      setCtx]      = useState<'jobs' | 'invoices' | 'schedule'>('jobs');
  const [hasItems, setHasItems] = useState(true);

  const configs = {
    jobs: {
      Icon: Briefcase, cta: 'Create first job',
      title: 'No jobs yet',
      sub: 'Jobs you create will appear here. Add your first job to get started.',
      items: ['#1042 · Rodriguez · HVAC · Active', '#1043 · Johnson · Plumbing · Scheduled', '#1044 · Davis · HVAC · Draft'],
    },
    invoices: {
      Icon: Receipt, cta: 'Create an invoice',
      title: 'All clear — no outstanding invoices',
      sub: 'All invoices are settled. New ones appear here when created.',
      items: ['INV-0087 · Rodriguez · $425 · Unpaid', 'INV-0086 · Johnson · $280 · Overdue'],
    },
    schedule: {
      Icon: Calendar, cta: 'Schedule a job',
      title: 'Nothing scheduled today',
      sub: "Your calendar is clear. Ask Fieldly AI to schedule a job, or add one manually.",
      items: ['9:00 AM · Carlos · Rodriguez HVAC', '2:00 PM · Marcus · Johnson Plumbing', '4:30 PM · Sarah · Williams Painting'],
    },
  };

  const { Icon, cta, title, sub, items } = configs[ctx];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex p-1 gap-1 rounded-xl bg-slate-100">
        {(['jobs', 'invoices', 'schedule'] as const).map(c => (
          <button key={c} onClick={() => { setCtx(c); setHasItems(true); }}
            className={`flex-1 rounded-lg py-2 text-xs capitalize transition-all ${ctx === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {c}
          </button>
        ))}
      </div>

      {hasItems ? (
        <div className="flex flex-col gap-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3">
              <Icon size={14} className="text-slate-400 shrink-0" />
              <p className="flex-1 text-sm text-slate-700">{item}</p>
            </div>
          ))}
          <button onClick={() => setHasItems(false)}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 text-slate-500 py-2.5 text-sm hover:bg-slate-50 transition-colors">
            Clear all → show empty state
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center text-center py-10 gap-3 rounded-2xl bg-white border border-slate-200" style={{ animation: 'stepIn 0.3s ease' }}>
          <div className="flex size-14 items-center justify-center rounded-2xl bg-slate-100">
            <Icon size={22} className="text-slate-400" />
          </div>
          <div className="px-6">
            <p className="text-slate-800">{title}</p>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">{sub}</p>
          </div>
          <button onClick={() => setHasItems(true)}
            className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-5 py-2.5 text-sm hover:bg-slate-700 transition-colors">
            {cta}
          </button>
        </div>
      )}
    </div>
  );
}

// ── 3 · Error ──────────────────────────────────────────────────────────────
function ErrorDemo() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const errors = [
    { id: 'network', type: 'Network error',    Icon: WifiOff,     msg: 'Failed to load jobs — no server response.',                  detail: 'Check your connection and try again.',              ring: 'border-red-200',    bg: 'bg-red-50',    iBg: 'bg-red-100 text-red-500',    action: 'Retry connection' },
    { id: 'data',    type: 'Validation error', Icon: AlertCircle, msg: "INV-0087 couldn't save — line items don't match total.",      detail: 'Subtotal $380 vs stated total $425 — gap of $45.',  ring: 'border-amber-200',  bg: 'bg-amber-50',  iBg: 'bg-amber-100 text-amber-500',action: 'Review invoice'   },
    { id: 'auth',    type: 'Permission error', Icon: Eye,         msg: "You don't have access to edit this customer record.",         detail: 'Contact the account owner to request edit access.', ring: 'border-slate-200',  bg: 'bg-slate-50',  iBg: 'bg-slate-100 text-slate-500',action: 'Request access'   },
  ];
  const visible = errors.filter(e => !dismissed.has(e.id));
  return (
    <div className="flex flex-col gap-2.5">
      {visible.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-sm text-slate-400">All errors dismissed</p>
          <button onClick={() => setDismissed(new Set())} className="text-xs text-blue-500 mt-1.5 hover:underline">Restore all</button>
        </div>
      ) : visible.map(({ id, type, Icon, msg, detail, ring, bg, iBg, action }) => (
        <div key={id} className={`rounded-xl border overflow-hidden ${ring} ${bg}`}>
          <div className="flex items-start gap-3 px-4 py-3.5">
            <span className={`flex size-8 items-center justify-center rounded-xl shrink-0 ${iBg}`}>
              <Icon size={14} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 mb-0.5">{type}</p>
              <p className="text-sm text-slate-800">{msg}</p>
              <p className="text-xs text-slate-500 mt-0.5">{detail}</p>
            </div>
            <button onClick={() => setDismissed(s => new Set([...s, id]))} className="text-slate-400 hover:text-slate-600 shrink-0">
              <X size={14} />
            </button>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/60 bg-white/50">
            <button className="text-xs text-blue-600 hover:underline">{action}</button>
            <span className="text-xs text-slate-400">Just now</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 4 · Retry ──────────────────────────────────────────────────────────────
function RetryDemo() {
  const [phase,   setPhase]   = useState<'idle' | 'failed' | 'spin1' | 'backoff' | 'spin2' | 'success'>('idle');
  const [attempt, setAttempt] = useState(1);

  function startSpin1() {
    setPhase('spin1');
    setTimeout(() => { setAttempt(2); setPhase('backoff'); }, 1400);
  }

  function startSpin2() {
    setPhase('spin2');
    setTimeout(() => setPhase('success'), 1400);
  }

  function reset() { setPhase('idle'); setAttempt(1); }

  return (
    <div className="flex flex-col gap-3">
      {phase === 'idle' && (
        <button onClick={() => setPhase('failed')}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors">
          Simulate failed action
        </button>
      )}

      {phase === 'failed' && (
        <div className="rounded-xl bg-red-50 border border-red-200 overflow-hidden" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="flex items-start gap-3 px-4 py-3.5">
            <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-red-900">Failed to send INV-0087</p>
              <p className="text-xs text-red-600 mt-0.5">SMTP timeout — carrier rejected connection · Attempt {attempt} of 3</p>
            </div>
          </div>
          <div className="flex gap-2 px-4 py-2.5 border-t border-red-100 bg-red-50">
            <button onClick={startSpin1}
              className="flex items-center gap-1.5 rounded-xl bg-red-600 text-white px-3.5 py-2 text-xs hover:bg-red-700 transition-colors">
              <RefreshCw size={11} /> Retry
            </button>
            <button onClick={reset} className="px-3.5 py-2 text-xs text-slate-400 hover:text-slate-600">Dismiss</button>
          </div>
        </div>
      )}

      {(phase === 'spin1' || phase === 'spin2') && (
        <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-4 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="size-7 rounded-full border-2 border-slate-200 border-t-blue-600 animate-spin shrink-0" />
          <div>
            <p className="text-sm text-slate-800">Retrying…</p>
            <p className="text-xs text-slate-400">Attempt {phase === 'spin1' ? 2 : 3} of 3 · SMTP handshake</p>
          </div>
        </div>
      )}

      {phase === 'backoff' && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 overflow-hidden" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm text-amber-900">Attempt {attempt} failed — waiting to retry</p>
                <p className="text-xs text-amber-600 mt-0.5">Exponential backoff · Next retry in 5 s</p>
              </div>
              <div className="flex size-10 items-center justify-center rounded-full border-2 border-amber-300 shrink-0">
                <div className="size-full rounded-full border-2 border-transparent" style={{ background: 'conic-gradient(#f59e0b var(--p,100%),transparent 0)', animation: 'drain 5s linear forwards' }} onAnimationEnd={startSpin2} />
              </div>
            </div>
            <div className="h-1 w-full rounded-full bg-amber-200 overflow-hidden">
              <div className="h-full rounded-full bg-amber-500" style={{ animation: 'drain 5s linear forwards' }} />
            </div>
          </div>
          <div className="px-4 py-2.5 border-t border-amber-100">
            <button onClick={startSpin2} className="text-xs text-amber-700 hover:underline">Retry now instead</button>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <CheckCircle2 size={18} className="text-green-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-green-900">Invoice sent — attempt 3 succeeded</p>
            <p className="text-xs text-green-600 mt-0.5">INV-0087 delivered to Roberto Rodriguez</p>
          </div>
          <button onClick={reset} className="text-xs text-green-700 hover:underline shrink-0">Reset</button>
        </div>
      )}
      <style>{`@keyframes drain { from { width: 100% } to { width: 0% } }`}</style>
    </div>
  );
}

// ── 5 · Pending review ─────────────────────────────────────────────────────
function PendingReviewDemo() {
  type Decision = 'approved' | 'rejected';
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const items = [
    { id: 'a', type: 'Invoice',  desc: 'Auto-create invoice for Rodriguez · $425',    sub: 'Job #1042 marked complete · Ready to send'    },
    { id: 'b', type: 'Estimate', desc: 'Send estimate EST-0047 to Bradley · $1,180',  sub: 'Drafted from voice note · Awaiting your OK'   },
    { id: 'c', type: 'Schedule', desc: 'Schedule Davis HVAC for Thu Mar 12 at 2 PM',  sub: 'Carlos available · No conflicts'              },
    { id: 'd', type: 'Follow-up',desc: 'Follow-up SMS to Johnson — no reply 4 days',  sub: 'EST-0044 · $2,600 · Sent Mar 6 · Unread'     },
  ];
  const done = Object.keys(decisions).length;
  const total = items.length;

  function decide(id: string, d: Decision) {
    setDecisions(p => ({ ...p, [id]: d }));
  }

  return (
    <div className="flex flex-col gap-3">
      {/* queue header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">AI action queue · {total - done} pending</p>
        <div className="flex items-center gap-1.5">
          <div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <span className="text-xs text-slate-400 tabular-nums">{done}/{total}</span>
        </div>
      </div>

      {items.map(item => {
        const d = decisions[item.id];
        return (
          <div key={item.id} className={`rounded-xl border overflow-hidden transition-all ${d === 'approved' ? 'border-green-200 bg-green-50/60' : d === 'rejected' ? 'border-slate-200 opacity-50' : 'border-slate-200 bg-white'}`}>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <span className={`text-xs px-2 py-1 rounded-lg shrink-0 mt-0.5 ${item.type === 'Invoice' ? 'bg-blue-100 text-blue-700' : item.type === 'Estimate' ? 'bg-indigo-100 text-indigo-700' : item.type === 'Schedule' ? 'bg-green-100 text-green-700' : 'bg-violet-100 text-violet-700'}`}>
                {item.type}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">{item.desc}</p>
                <p className="text-xs text-slate-500 mt-0.5">{item.sub}</p>
              </div>
            </div>
            {!d ? (
              <div className="flex gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50/50">
                <button onClick={() => decide(item.id, 'approved')}
                  className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3.5 py-2 text-xs text-white hover:bg-green-700 transition-colors">
                  <Check size={11} /> Approve
                </button>
                <button onClick={() => decide(item.id, 'rejected')}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
                  <X size={11} /> Reject
                </button>
              </div>
            ) : (
              <div className={`flex items-center gap-1.5 px-4 py-2.5 border-t ${d === 'approved' ? 'border-green-100' : 'border-slate-100'}`}>
                {d === 'approved' ? <><CheckCircle2 size={11} className="text-green-500" /><span className="text-xs text-green-700">Approved — applied</span></> : <><X size={11} className="text-slate-400" /><span className="text-xs text-slate-400">Rejected</span></>}
                <button onClick={() => setDecisions(p => { const n = { ...p }; delete n[item.id]; return n; })} className="ml-auto text-xs text-blue-500 hover:underline">Undo</button>
              </div>
            )}
          </div>
        );
      })}

      {done === total && (
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 text-center" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-sm text-green-900">Queue cleared — all caught up</p>
          <button onClick={() => setDecisions({})} className="text-xs text-green-700 mt-1 hover:underline">Reset</button>
        </div>
      )}
    </div>
  );
}

// ── 6 · Success ────────────────────────────────────────────────────────────
function SuccessDemo() {
  const [style, setStyle] = useState<'toast' | 'inline' | 'full'>('toast');
  const [phase, setPhase] = useState<'idle' | 'success'>('idle');

  function trigger() { setPhase('success'); if (style === 'toast') setTimeout(() => setPhase('idle'), 3500); }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex p-1 gap-1 rounded-xl bg-slate-100">
        {(['toast', 'inline', 'full'] as const).map(s => (
          <button key={s} onClick={() => { setStyle(s); setPhase('idle'); }}
            className={`flex-1 rounded-lg py-2 text-xs capitalize transition-all ${style === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s === 'toast' ? 'Toast' : s === 'inline' ? 'Inline' : 'Full-screen'}
          </button>
        ))}
      </div>

      <div className="relative rounded-2xl bg-white border border-slate-200 overflow-hidden">
        {/* simulated content */}
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
          <p className="text-xs text-slate-500">Simulated screen context</p>
        </div>

        {/* toast — slides in at top */}
        {style === 'toast' && phase === 'success' && (
          <div className="absolute top-10 left-4 right-4 z-10 flex items-center gap-3 rounded-xl bg-slate-900 text-white px-4 py-3 shadow-xl"
            style={{ animation: 'slideDown 0.25s ease' }}>
            <CheckCircle2 size={16} className="text-green-400 shrink-0" />
            <div className="flex-1">
              <p className="text-sm">Invoice sent · INV-0087</p>
              <p className="text-xs text-slate-400 mt-0.5">Roberto Rodriguez · Payment link active</p>
            </div>
            <button onClick={() => setPhase('idle')} className="text-slate-400 hover:text-white shrink-0"><X size={14} /></button>
          </div>
        )}

        {/* inline — turns green */}
        <div className={`px-4 py-4 transition-all duration-300 ${style === 'inline' && phase === 'success' ? 'bg-green-50' : ''}`}>
          {style === 'inline' && phase === 'success' ? (
            <div className="flex items-center gap-3" style={{ animation: 'stepIn 0.25s ease' }}>
              <CheckCircle2 size={20} className="text-green-500 shrink-0" />
              <div className="flex-1">
                <p className="text-sm text-green-900">Invoice sent successfully</p>
                <p className="text-xs text-green-600 mt-0.5">INV-0087 · Roberto Rodriguez · Payment link active</p>
              </div>
            </div>
          ) : style !== 'full' || phase !== 'success' ? (
            <div className="flex items-center gap-3 opacity-40">
              <div className="size-8 rounded-full bg-slate-200 shrink-0" />
              <div className="flex-1 flex flex-col gap-1.5">
                <div className="h-3 rounded-full bg-slate-200 w-3/4" />
                <div className="h-2 rounded-full bg-slate-100 w-1/2" />
              </div>
              <div className="h-5 w-16 rounded-full bg-slate-200" />
            </div>
          ) : null}

          {style === 'full' && phase === 'success' && (
            <div className="flex flex-col items-center text-center py-6 gap-3" style={{ animation: 'stepIn 0.3s ease' }}>
              <div className="flex size-16 items-center justify-center rounded-full bg-green-100">
                <CheckCircle2 size={32} className="text-green-500" />
              </div>
              <div>
                <p className="text-slate-900">Invoice sent!</p>
                <p className="text-sm text-slate-500 mt-1">Roberto Rodriguez will receive a payment link via SMS and email.</p>
              </div>
              <div className="flex gap-2 mt-1">
                <button className="rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">View invoice</button>
                <button onClick={() => setPhase('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">Done</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {phase === 'idle' && (
        <button onClick={trigger}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Trigger {style} success
        </button>
      )}
      {style === 'toast' && phase === 'success' && (
        <p className="text-xs text-center text-slate-400">Auto-dismisses in 3.5 s</p>
      )}
      <style>{`
        @keyframes slideDown { from { opacity:0; transform:translateY(-12px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}

// ── 7 · Partial failure ────────────────────────────────────────────────────
function PartialFailureDemo() {
  const [phase,    setPhase]    = useState<'idle' | 'sending' | 'results' | 'retrying' | 'resolved'>('idle');
  const [retried,  setRetried]  = useState<Set<string>>(new Set());

  const results = [
    { id: 'r1', customer: 'Rodriguez',  inv: 'INV-0087', ok: true  },
    { id: 'r2', customer: 'Davis',      inv: 'INV-0088', ok: false, error: 'Email bounced — invalid address' },
    { id: 'r3', customer: 'Bradley',    inv: 'INV-0089', ok: true  },
    { id: 'r4', customer: 'Johnson',    inv: 'INV-0090', ok: false, error: 'SMS carrier rejected — carrier error' },
    { id: 'r5', customer: 'Williams',   inv: 'INV-0091', ok: true  },
  ];
  const failed = results.filter(r => !r.ok && !retried.has(r.id));

  function send() {
    setPhase('sending');
    setTimeout(() => setPhase('results'), 1800);
  }
  function retryFailed() {
    setPhase('retrying');
    setTimeout(() => { setRetried(new Set(results.filter(r => !r.ok).map(r => r.id))); setPhase('resolved'); }, 1600);
  }

  return (
    <div className="flex flex-col gap-3">
      {phase === 'idle' && (
        <button onClick={send}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors">
          <Send size={14} /> Batch-send 5 invoices
        </button>
      )}

      {phase === 'sending' && (
        <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-5 flex items-center gap-3">
          <div className="size-7 rounded-full border-2 border-slate-200 border-t-blue-600 animate-spin shrink-0" />
          <div>
            <p className="text-sm text-slate-800">Sending invoices…</p>
            <p className="text-xs text-slate-400">Processing 5 recipients via SMS and email</p>
          </div>
        </div>
      )}

      {(phase === 'results' || phase === 'retrying' || phase === 'resolved') && (
        <div className="flex flex-col gap-2" style={{ animation: 'stepIn 0.2s ease' }}>
          {/* summary */}
          <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${phase === 'resolved' ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            {phase === 'resolved' ? <CheckCircle2 size={16} className="text-green-500 shrink-0" /> : <AlertTriangle size={16} className="text-amber-600 shrink-0" />}
            <p className="text-sm">
              {phase === 'resolved'
                ? '5 of 5 invoices sent — all resolved'
                : `${results.filter(r => r.ok).length} of ${results.length} sent · ${results.filter(r => !r.ok).length} failed`}
            </p>
          </div>

          {/* rows */}
          {results.map(r => {
            const succeeded = r.ok || retried.has(r.id);
            return (
              <div key={r.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${succeeded ? 'border-green-100 bg-green-50/40' : 'border-red-200 bg-red-50/40'}`}>
                {succeeded
                  ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                  : <XCircle size={14} className="text-red-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800">{r.inv} · {r.customer}</p>
                  {!succeeded && r.error && <p className="text-xs text-red-600 mt-0.5">{r.error}</p>}
                  {retried.has(r.id) && <p className="text-xs text-green-600 mt-0.5">Retried — delivered</p>}
                </div>
              </div>
            );
          })}

          {/* retry failed CTA */}
          {phase === 'results' && failed.length > 0 && (
            <button onClick={retryFailed}
              className="flex items-center justify-center gap-2 rounded-xl bg-red-600 text-white py-2.5 text-sm hover:bg-red-700 transition-colors"
              style={{ animation: 'stepIn 0.3s ease' }}>
              <RefreshCw size={13} /> Retry {failed.length} failed
            </button>
          )}

          {phase === 'retrying' && (
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
              <div className="size-5 rounded-full border-2 border-slate-200 border-t-blue-600 animate-spin shrink-0" />
              <p className="text-xs text-slate-500">Re-sending failed invoices…</p>
            </div>
          )}

          <button onClick={() => { setPhase('idle'); setRetried(new Set()); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Reset</button>
        </div>
      )}
    </div>
  );
}

// ── 8 · Disconnected / weak connectivity ───────────────────────────────────
function DisconnectedDemo() {
  const [conn, setConn] = useState<'online' | 'weak' | 'offline'>('online');

  const CONFIG = {
    online:  { banner: null },
    weak:    {
      banner: { bg: 'bg-amber-50 border-amber-200', Icon: Signal, ic: 'text-amber-500', text: 'Slow connection — some features may respond slowly', sub: 'Syncing may take longer than usual' },
    },
    offline: {
      banner: { bg: 'bg-red-50 border-red-200', Icon: WifiOff, ic: 'text-red-500', text: 'No connection — working offline', sub: 'Changes will sync automatically when reconnected' },
    },
  };

  const jobs = [
    { name: 'Rodriguez · HVAC',  time: '9:00 AM',  stale: false },
    { name: 'Davis · Estimate',  time: '11:30 AM', stale: conn !== 'online' },
    { name: 'Johnson · Plumbing',time: '2:00 PM',  stale: conn === 'offline' },
  ];

  const degraded = conn === 'offline' ? ['Camera upload', 'SMS send', 'Real-time sync', 'Payment collection'] :
                   conn === 'weak'    ? ['Camera upload', 'Real-time sync'] : [];

  const banner = (CONFIG[conn] as any).banner;

  return (
    <div className="flex flex-col gap-3">
      {/* state toggle */}
      <div className="flex p-1 gap-1 rounded-xl bg-slate-100">
        {(['online', 'weak', 'offline'] as const).map(c => (
          <button key={c} onClick={() => setConn(c)}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs capitalize transition-all ${conn === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <span className={`size-1.5 rounded-full ${c === 'online' ? 'bg-green-500' : c === 'weak' ? 'bg-amber-400' : 'bg-red-500'}`} />
            {c === 'online' ? 'Online' : c === 'weak' ? 'Weak signal' : 'Offline'}
          </button>
        ))}
      </div>

      {/* banner */}
      {banner && (
        <div className={`rounded-xl border px-4 py-3 flex items-start gap-2.5 ${banner.bg}`} style={{ animation: 'stepIn 0.2s ease' }}>
          <banner.Icon size={15} className={`${banner.ic} shrink-0 mt-0.5`} />
          <div>
            <p className="text-sm text-slate-800">{banner.text}</p>
            <p className="text-xs text-slate-500 mt-0.5">{banner.sub}</p>
          </div>
        </div>
      )}

      {/* job list with stale indicators */}
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-100">
          <p className="text-xs text-slate-500">Today's jobs</p>
          {conn !== 'online' && <span className="text-xs text-amber-600 flex items-center gap-1"><Clock size={10} /> Cached data</span>}
        </div>
        {jobs.map(j => (
          <div key={j.name} className={`flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0 ${j.stale ? 'opacity-60' : ''}`}>
            <p className="text-sm text-slate-800 flex-1">{j.name}</p>
            <p className="text-xs text-slate-400">{j.time}</p>
            {j.stale && <span className="text-xs text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">Stale</span>}
          </div>
        ))}
      </div>

      {/* degraded features */}
      {degraded.length > 0 && (
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-xs text-slate-500 mb-2">Unavailable in this state</p>
          <div className="flex flex-wrap gap-1.5">
            {degraded.map(f => (
              <span key={f} className="text-xs text-slate-400 line-through bg-slate-100 rounded-full px-2.5 py-1">{f}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 9 · Sync delayed ───────────────────────────────────────────────────────
function SyncDelayedDemo() {
  const [delay, setDelay] = useState<'fresh' | 'warning' | 'stale'>('fresh');
  const [syncing, setSyncing] = useState(false);

  const CONFIG = {
    fresh:   { label: 'Synced just now',    ago: '',       color: 'text-green-600', bg: 'bg-green-50 border-green-200', dot: 'bg-green-500', warn: false },
    warning: { label: 'Last synced 8m ago', ago: '8 min',  color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-400', warn: true  },
    stale:   { label: 'Last synced 23m ago',ago: '23 min', color: 'text-red-600',   bg: 'bg-red-50 border-red-200',     dot: 'bg-red-500',  warn: true  },
  };
  const cfg = CONFIG[delay];

  function syncNow() {
    setSyncing(true);
    setTimeout(() => { setSyncing(false); setDelay('fresh'); }, 1800);
  }

  const staleModules = delay === 'stale'   ? ['Jobs', 'Invoices', 'Estimates', 'Schedule'] :
                       delay === 'warning' ? ['Estimates', 'Schedule'] : [];

  return (
    <div className="flex flex-col gap-3">
      {/* delay selector */}
      <div className="flex p-1 gap-1 rounded-xl bg-slate-100">
        {(['fresh', 'warning', 'stale'] as const).map(d => (
          <button key={d} onClick={() => { setDelay(d); setSyncing(false); }}
            className={`flex-1 rounded-lg py-2 text-xs capitalize transition-all ${delay === d ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {d === 'fresh' ? 'Just now' : d === 'warning' ? '8 min ago' : '23 min ago'}
          </button>
        ))}
      </div>

      {/* status indicator */}
      <div className={`rounded-xl border px-4 py-3.5 transition-all ${cfg.bg}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {syncing ? (
              <div className="size-2 rounded-full bg-blue-500 animate-pulse" />
            ) : (
              <div className={`size-2 rounded-full ${cfg.dot}`} />
            )}
            <p className="text-sm text-slate-800">{syncing ? 'Syncing now…' : cfg.label}</p>
          </div>
          <button onClick={syncNow} disabled={syncing}
            className="flex items-center gap-1.5 rounded-lg bg-white border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-all">
            <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} /> Sync now
          </button>
        </div>
        {cfg.warn && !syncing && (
          <p className="text-xs mt-1.5" style={{ animation: 'stepIn 0.2s ease' }}>
            <span className={cfg.color}>Some data may be out of date — tap "Sync now" to refresh</span>
          </p>
        )}
      </div>

      {/* affected sections */}
      {staleModules.length > 0 && !syncing && (
        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-50 overflow-hidden" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="px-4 py-2 bg-slate-50">
            <p className="text-xs text-slate-500">Sections showing stale data</p>
          </div>
          {staleModules.map(m => (
            <div key={m} className="flex items-center gap-3 px-4 py-3">
              <Clock size={12} className="text-amber-400 shrink-0" />
              <p className="flex-1 text-sm text-slate-700">{m}</p>
              <span className="text-xs text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">May be stale</span>
            </div>
          ))}
        </div>
      )}

      {syncing && (
        <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 flex items-center gap-2.5" style={{ animation: 'stepIn 0.2s ease' }}>
          <div className="size-4 rounded-full border-2 border-blue-300 border-t-blue-600 animate-spin shrink-0" />
          <p className="text-sm text-blue-800">Pulling latest data from Fieldly cloud…</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { id: 'ai',          label: 'AI',           count: 8  },
  { id: 'messaging',   label: 'Messaging',    count: 7  },
  { id: 'scheduling',  label: 'Scheduling',   count: 5  },
  { id: 'records',     label: 'Records',      count: 5  },
  { id: 'financial',   label: 'Financial',    count: 6  },
  { id: 'onboarding',  label: 'Onboarding',   count: 5  },
  { id: 'states',      label: 'System States',count: 9  },
] as const;
type TabId = typeof TABS[number]['id'];

export function InteractionsPage() {
  const [tab, setTab] = useState<TabId>('ai');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-5 pt-5 pb-0 border-b border-slate-100 bg-white">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-slate-900">Interaction Patterns</h1>
              <p className="text-sm text-slate-400 mt-0.5">45 live patterns — click and interact with each</p>
            </div>
            <span className="flex size-8 items-center justify-center rounded-xl bg-indigo-100">
              <Sparkles size={15} className="text-indigo-600" />
            </span>
          </div>
          <div className="flex gap-0.5 overflow-x-auto pb-0" style={{ scrollbarWidth: 'none' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2.5 text-sm border-b-2 whitespace-nowrap transition-all shrink-0 ${
                  tab === t.id
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {t.label}
                <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                  tab === t.id ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'
                }`}>{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-6 pb-20 flex flex-col gap-5">

          {/* ── AI tab ── */}
          {tab === 'ai' && (
            <>
              <DemoCard tag="Propose action" onReset={() => {}}>
                <ProposeDemo />
              </DemoCard>
              <DemoCard tag="Approve action" tagColor="bg-green-100 text-green-700">
                <ApproveDemo />
              </DemoCard>
              <DemoCard tag="Edit action" tagColor="bg-indigo-100 text-indigo-700">
                <EditDemo />
              </DemoCard>
              <DemoCard tag="Reject action" tagColor="bg-red-100 text-red-700">
                <RejectDemo />
              </DemoCard>
              <DemoCard tag="Show brief explanation" tagColor="bg-slate-100 text-slate-600" title="Why this suggestion?">
                <ExplanationDemo />
              </DemoCard>
              <DemoCard tag="Confidence & ambiguity cue" tagColor="bg-amber-100 text-amber-700" title="Tap a card to expand">
                <ConfidenceDemo />
              </DemoCard>
              <DemoCard tag="Ask targeted clarification" tagColor="bg-violet-100 text-violet-700">
                <ClarificationDemo />
              </DemoCard>
              <DemoCard tag="Auto-applied update" tagColor="bg-green-100 text-green-700" title="Silent updates with undo">
                <AutoAppliedDemo />
              </DemoCard>
            </>
          )}

          {/* ── Messaging tab ── */}
          {tab === 'messaging' && (
            <>
              <DemoCard tag="Draft SMS · Review · Send feedback" tagColor="bg-blue-100 text-blue-700" title="Covers 3 patterns">
                <SMSDraftDemo />
              </DemoCard>
              <DemoCard tag="Draft email message" tagColor="bg-blue-100 text-blue-700" title="AI-drafted, fully editable">
                <EmailDraftDemo />
              </DemoCard>
              <DemoCard tag="Reminder / follow-up suggestion" tagColor="bg-violet-100 text-violet-700">
                <FollowUpDemo />
              </DemoCard>
              <DemoCard tag="Appointment confirm · Reschedule notice" tagColor="bg-amber-100 text-amber-700" title="Toggle between types">
                <AppointmentDemo />
              </DemoCard>
            </>
          )}

          {/* ── Scheduling tab ── */}
          {tab === 'scheduling' && (
            <>
              <DemoCard tag="Create schedule from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateFromConvoDemo />
              </DemoCard>
              <DemoCard tag="Move job from conversation" tagColor="bg-blue-100 text-blue-700">
                <MoveJobDemo />
              </DemoCard>
              <DemoCard tag="Assign technician from calendar" tagColor="bg-green-100 text-green-700" title="Thu Mar 12 availability">
                <AssignTechDemo />
              </DemoCard>
              <DemoCard tag="Resolve scheduling conflict" tagColor="bg-red-100 text-red-700">
                <ConflictDemo />
              </DemoCard>
              <DemoCard tag="External calendar sync status" tagColor="bg-slate-100 text-slate-600" title="Tap to cycle states">
                <SyncStatusDemo />
              </DemoCard>
            </>
          )}

          {/* ── Records tab ── */}
          {tab === 'records' && (
            <>
              <DemoCard tag="Resolve customer match" tagColor="bg-amber-100 text-amber-700" title="Match before creating contact">
                <CustomerMatchDemo />
              </DemoCard>
              <DemoCard tag="Resolve job match" tagColor="bg-orange-100 text-orange-700" title="Possible duplicate job">
                <JobMatchDemo />
              </DemoCard>
              <DemoCard tag="Create new lead/job from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateLeadDemo />
              </DemoCard>
              <DemoCard tag="Surface duplicate warning" tagColor="bg-red-100 text-red-700" title="Inline while creating">
                <DuplicateWarningDemo />
              </DemoCard>
              <DemoCard tag="Review suggested merge candidate" tagColor="bg-violet-100 text-violet-700" title="Field-level conflict resolution">
                <MergeCandidateDemo />
              </DemoCard>
            </>
          )}

          {/* ── Financial tab ── */}
          {tab === 'financial' && (
            <>
              <DemoCard tag="Estimate draft from conversation" tagColor="bg-indigo-100 text-indigo-700" title="Plain language → line items">
                <EstimateDraftDemo />
              </DemoCard>
              <DemoCard tag="Pricing suggestion review" tagColor="bg-green-100 text-green-700" title="Per-line accept or keep">
                <PricingReviewDemo />
              </DemoCard>
              <DemoCard tag="Estimate approval capture" tagColor="bg-blue-100 text-blue-700" title="Signature + metadata recorded">
                <ApprovalCaptureDemo />
              </DemoCard>
              <DemoCard tag="Invoice draft from job completion" tagColor="bg-slate-100 text-slate-600" title="Complete → draft → send">
                <InvoiceDraftDemo />
              </DemoCard>
              <DemoCard tag="Hosted payment handoff" tagColor="bg-green-100 text-green-700" title="Link generation + delivery">
                <PaymentHandoffDemo />
              </DemoCard>
              <DemoCard tag="Cancellation / no-show fee suggestion" tagColor="bg-amber-100 text-amber-700">
                <CancellationFeeDemo />
              </DemoCard>
            </>
          )}

          {/* ── Onboarding tab ── */}
          {tab === 'onboarding' && (
            <>
              <DemoCard tag="Voice answer capture · Text fallback" tagColor="bg-red-100 text-red-700" title="Toggle between modes">
                <VoiceCaptureDemo />
              </DemoCard>
              <DemoCard tag="Config proposal review" tagColor="bg-indigo-100 text-indigo-700" title="Toggle inferred settings on/off">
                <ConfigProposalDemo />
              </DemoCard>
              <DemoCard tag="Rule confirmation" tagColor="bg-violet-100 text-violet-700" title="Confirm, edit, or skip">
                <RuleConfirmationDemo />
              </DemoCard>
              <DemoCard tag="Unsupported preference capture" tagColor="bg-slate-100 text-slate-600" title="3 examples — tap to switch">
                <UnsupportedPrefDemo />
              </DemoCard>
            </>
          )}

          {/* ── System States tab ── */}
          {tab === 'states' && (
            <>
              <DemoCard tag="Loading" tagColor="bg-blue-100 text-blue-700" title="Skeleton · Spinner · Progress">
                <LoadingDemo />
              </DemoCard>
              <DemoCard tag="Empty" tagColor="bg-slate-100 text-slate-600" title="Jobs · Invoices · Schedule contexts">
                <EmptyDemo />
              </DemoCard>
              <DemoCard tag="Error" tagColor="bg-red-100 text-red-700" title="Network · Validation · Permission">
                <ErrorDemo />
              </DemoCard>
              <DemoCard tag="Retry" tagColor="bg-amber-100 text-amber-700" title="Exponential backoff + drain animation">
                <RetryDemo />
              </DemoCard>
              <DemoCard tag="Pending review" tagColor="bg-indigo-100 text-indigo-700" title="AI action queue · approve / reject each">
                <PendingReviewDemo />
              </DemoCard>
              <DemoCard tag="Success" tagColor="bg-green-100 text-green-700" title="Toast · Inline · Full-screen">
                <SuccessDemo />
              </DemoCard>
              <DemoCard tag="Partial failure" tagColor="bg-orange-100 text-orange-700" title="Batch send · n of n succeeded">
                <PartialFailureDemo />
              </DemoCard>
              <DemoCard tag="Disconnected / weak connectivity" tagColor="bg-red-100 text-red-700" title="Online · Weak · Offline">
                <DisconnectedDemo />
              </DemoCard>
              <DemoCard tag="Sync delayed" tagColor="bg-amber-100 text-amber-700" title="Escalating staleness · Sync now">
                <SyncDelayedDemo />
              </DemoCard>
            </>
          )}

        </div>
      </div>

      <style>{`@keyframes stepIn { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} }`}</style>
    </div>
  );
}
