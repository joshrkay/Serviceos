import { useState } from 'react';
import {
  Sparkles, Check, Pencil, AlertTriangle, ArrowRight, Send,
  Mic, Zap, MessageSquare, Mail, CheckCircle2, ChevronRight,
} from 'lucide-react';
import { AILabel } from '../shared';

// ── 1 · Estimate draft from conversation ─────────────────────────────────
export function EstimateDraftDemo() {
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
export function PricingReviewDemo() {
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
export function ApprovalCaptureDemo() {
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
export function InvoiceDraftDemo() {
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
export function PaymentHandoffDemo() {
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
export function CancellationFeeDemo() {
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
