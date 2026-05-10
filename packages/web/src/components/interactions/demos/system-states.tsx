import { useState } from 'react';
import {
  Check, X, AlertCircle, AlertTriangle, Send,
  Clock, Calendar, Briefcase, Eye,
  Receipt, WifiOff, Signal,
  CheckCircle2, XCircle, RefreshCw,
} from 'lucide-react';

// ── 1 · Loading ────────────────────────────────────────────────────────────
export function LoadingDemo() {
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
export function EmptyDemo() {
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
export function ErrorDemo() {
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
export function RetryDemo() {
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
export function PendingReviewDemo() {
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
export function SuccessDemo() {
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
export function PartialFailureDemo() {
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
export function DisconnectedDemo() {
  const [conn, setConn] = useState<'online' | 'weak' | 'offline'>('online');

  type BannerCfg = {
    bg: string;
    Icon: typeof Signal;
    ic: string;
    text: string;
    sub: string;
  };

  const CONFIG: Record<'online' | 'weak' | 'offline', { banner: BannerCfg | null }> = {
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

  const banner = CONFIG[conn].banner;

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
export function SyncDelayedDemo() {
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
