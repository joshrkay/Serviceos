import { useState } from 'react';
import {
  Check, AlertTriangle, ArrowRight,
  Mic, CheckCircle2, ChevronRight,
} from 'lucide-react';
import { AILabel } from '../shared';

// ── 1 · Resolve customer match ─────────────────────────────────────────────
export function CustomerMatchDemo() {
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
export function JobMatchDemo() {
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
export function CreateLeadDemo() {
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
export function DuplicateWarningDemo() {
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
export function MergeCandidateDemo() {
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
