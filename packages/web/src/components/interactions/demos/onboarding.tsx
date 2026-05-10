import { useState } from 'react';
import {
  Sparkles, Check, Pencil, Mic, Bell,
} from 'lucide-react';
import { AILabel } from '../shared';

// ── 1+2 · Voice capture + text fallback ───────────────────────────────────
export function VoiceCaptureDemo() {
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
export function ConfigProposalDemo() {
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
export function RuleConfirmationDemo() {
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
export function UnsupportedPrefDemo() {
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
