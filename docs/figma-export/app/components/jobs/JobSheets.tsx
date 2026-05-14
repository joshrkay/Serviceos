import { useState, useEffect, useRef } from 'react';
import {
  X, Check, Send, Plus, Receipt,
  Phone, MessageSquare, Eye,
  MicOff, Mic, Volume2, PhoneOff,
} from 'lucide-react';
import { estimates, invoices, calcEstimateTotal, calcInvoiceTotal } from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';

// ─── Sheet Overlay ───────────────────────────────────────────────
export function SheetOverlay({
  children, onClose, maxH = '85vh',
}: { children: React.ReactNode; onClose: () => void; maxH?: string }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-white shadow-2xl overflow-y-auto"
        style={{ maxHeight: maxH, animation: 'slideUp 0.22s cubic-bezier(.32,1,.46,1)' }}
      >
        <div className="sticky top-0 flex justify-center pt-3 pb-1 bg-white">
          <div className="w-9 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="px-5 pb-8 pt-1">{children}</div>
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </>
  );
}

// ─── Call Screen ─────────────────────────────────────────────────
export function CallScreen({ name, phone, initials, color, onEnd }: {
  name: string; phone: string; initials: string; color: string; onEnd: () => void;
}) {
  const [phase, setPhase] = useState<'calling' | 'active'>('calling');
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setPhase('active'), 2200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between py-16 px-6"
      style={{ background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 60%, #0c4a6e 100%)' }}
    >
      <div className="flex flex-col items-center gap-1">
        <p className="text-slate-400 text-sm tracking-widest uppercase" style={{ fontSize: 11 }}>
          {phase === 'calling' ? 'Calling…' : 'Active call'}
        </p>
        {phase === 'active' && <p className="text-white text-sm tabular-nums">{fmt(seconds)}</p>}
      </div>

      <div className="flex flex-col items-center gap-4">
        <div
          className="flex items-center justify-center rounded-full text-white shadow-2xl"
          style={{ width: 96, height: 96, background: color, fontSize: 32 }}
        >
          {initials}
        </div>
        <div className="text-center">
          <p className="text-white" style={{ fontSize: '1.4rem' }}>{name}</p>
          <p className="text-slate-400 text-sm mt-1">{phone}</p>
        </div>
        {phase === 'calling' && (
          <div className="flex gap-1 mt-2">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-2 h-2 rounded-full bg-blue-400"
                style={{ animation: `callPulse 1.2s ease-in-out ${i * 0.3}s infinite` }} />
            ))}
          </div>
        )}
      </div>

      <div className="w-full max-w-xs">
        <div className="grid grid-cols-3 gap-4 mb-8">
          <CallBtn icon={muted ? MicOff : Mic} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={() => setMuted(m => !m)} />
          <CallBtn icon={Volume2} label="Speaker" active={speaker} onPress={() => setSpeaker(s => !s)} />
          <CallBtn icon={MessageSquare} label="Keypad" onPress={() => {}} />
        </div>
        <button
          onClick={onEnd}
          className="flex items-center justify-center gap-2 w-full py-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
        >
          <PhoneOff size={22} /><span className="text-sm">End call</span>
        </button>
      </div>

      <style>{`@keyframes callPulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }`}</style>
    </div>
  );
}

function CallBtn({ icon: Icon, label, active, onPress }: {
  icon: React.ElementType; label: string; active?: boolean; onPress: () => void;
}) {
  return (
    <button onClick={onPress} className="flex flex-col items-center gap-2">
      <span
        className={`flex items-center justify-center rounded-full transition-colors ${active ? 'bg-white' : 'bg-white/10 hover:bg-white/20'}`}
        style={{ width: 56, height: 56 }}
      >
        <Icon size={22} className={active ? 'text-slate-900' : 'text-white'} />
      </span>
      <span className="text-xs text-slate-400">{label}</span>
    </button>
  );
}

// ─── Text Sheet ──────────────────────────────────────────────────
export function TextSheet({ name, phone, onClose }: { name: string; phone: string; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const first = name.split(' ')[0];

  const templates = [
    `Hi ${first}, we're on our way! ETA ~15 min.`,
    `Hi ${first}, your job is complete. Invoice on its way.`,
    `Hi ${first}, just confirming your appointment today.`,
  ];

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-slate-900">Text {first}</p>
          <p className="text-xs text-slate-400 mt-0.5">{phone}</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={16} className="text-slate-400" /></button>
      </div>

      {!sent ? (
        <>
          <div className="flex flex-col gap-2 mb-4">
            {templates.map((t, i) => (
              <button
                key={i}
                onClick={() => { setMessage(t); ref.current?.focus(); }}
                className="text-left rounded-lg border border-slate-200 px-3 py-2.5 text-xs text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
          <textarea
            ref={ref}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            placeholder="Type a custom message…"
            className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400 resize-none mb-3"
          />
          <button
            onClick={() => { if (!message.trim()) return; setSent(true); setTimeout(onClose, 1500); }}
            disabled={!message.trim()}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors disabled:opacity-40"
          >
            <Send size={14} /> Send message
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-8">
          <span className="flex size-12 items-center justify-center rounded-full bg-green-100">
            <Check size={22} className="text-green-600" />
          </span>
          <p className="text-sm text-slate-700">Message sent to {first}</p>
        </div>
      )}
    </SheetOverlay>
  );
}

// ─── Estimate Sheet ──────────────────────────────────────────────
export function EstimateSheet({ estimateId, onClose }: { estimateId: string; onClose: () => void }) {
  const est = estimates.find(e => e.id === estimateId);
  if (!est) return null;
  const total = calcEstimateTotal(est);

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-slate-900">Estimate {est.estimateNumber}</p>
          <p className="text-xs text-slate-400 mt-0.5">Created {est.createdDate}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={est.status} />
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={16} className="text-slate-400" /></button>
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-4 bg-slate-50 rounded-lg px-3 py-2">{est.description}</p>
      <div className="rounded-xl border border-slate-200 overflow-hidden mb-4">
        <div className="divide-y divide-slate-100">
          {est.lineItems.map((item, i) => (
            <div key={i} className="flex items-start justify-between gap-3 px-3 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">{item.description}</p>
                <p className="text-xs text-slate-400 mt-0.5">Qty: {item.qty} × ${item.rate.toFixed(2)}</p>
              </div>
              <p className="text-sm text-slate-800 shrink-0">${(item.qty * item.rate).toFixed(2)}</p>
            </div>
          ))}
        </div>
        <div className="flex justify-between px-3 py-3 bg-slate-50 border-t border-slate-100">
          <p className="text-sm text-slate-700">Total</p>
          <p className="text-sm text-slate-900">${total.toFixed(2)}</p>
        </div>
      </div>
      {est.validUntil && <p className="text-xs text-slate-400 text-center mb-4">Valid until {est.validUntil}</p>}
      <button onClick={onClose} className="w-full py-3 rounded-xl border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 transition-colors">Close</button>
    </SheetOverlay>
  );
}

// ─── Invoice Sheet ───────────────────────────────────────────────
export function InvoiceSheet({ invoiceId, customerName, customerPhone, onClose }: {
  invoiceId: string; customerName: string; customerPhone: string; onClose: () => void;
}) {
  const inv = invoices.find(i => i.id === invoiceId);
  const [sent, setSent] = useState(false);

  if (!inv) {
    return (
      <SheetOverlay onClose={onClose}>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-slate-900">Send Invoice</p>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={16} className="text-slate-400" /></button>
        </div>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-slate-100">
            <Receipt size={20} className="text-slate-400" />
          </span>
          <p className="text-sm text-slate-600">No invoice linked to this job yet.</p>
          <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Plus size={14} /> Create invoice
          </button>
        </div>
      </SheetOverlay>
    );
  }

  const total = calcInvoiceTotal(inv);

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-slate-900">Send Invoice {inv.invoiceNumber}</p>
          <p className="text-xs text-slate-400 mt-0.5">To {customerName}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={inv.status} />
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={16} className="text-slate-400" /></button>
        </div>
      </div>
      {!sent ? (
        <>
          <div className="rounded-xl border border-slate-200 overflow-hidden mb-4">
            <div className="divide-y divide-slate-100">
              {inv.lineItems.map((item, i) => (
                <div key={i} className="flex items-start justify-between gap-3 px-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800">{item.description}</p>
                    <p className="text-xs text-slate-400 mt-0.5">Qty: {item.qty} × ${item.rate.toFixed(2)}</p>
                  </div>
                  <p className="text-sm text-slate-800 shrink-0">${(item.qty * item.rate).toFixed(2)}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-between px-3 py-3 bg-slate-50 border-t border-slate-100">
              <p className="text-sm text-slate-700">Total due</p>
              <p className="text-sm text-slate-900">${total.toFixed(2)}</p>
            </div>
          </div>
          <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2.5 mb-4 flex items-center gap-2">
            <Send size={13} className="text-blue-500 shrink-0" />
            <p className="text-xs text-blue-700">Will be sent via SMS to {customerPhone}</p>
          </div>
          {inv.status === 'Paid' ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <span className="flex size-10 items-center justify-center rounded-full bg-green-100">
                <Check size={18} className="text-green-600" />
              </span>
              <p className="text-sm text-slate-700">Invoice already paid</p>
              <p className="text-xs text-slate-400">Paid {inv.paidDate}</p>
            </div>
          ) : (
            <button
              onClick={() => setSent(true)}
              className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors"
            >
              <Send size={14} /> Send invoice now
            </button>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-8">
          <span className="flex size-12 items-center justify-center rounded-full bg-green-100">
            <Check size={22} className="text-green-600" />
          </span>
          <p className="text-sm text-slate-700">Invoice sent to {customerName.split(' ')[0]}</p>
          <p className="text-xs text-slate-400">{customerPhone}</p>
        </div>
      )}
    </SheetOverlay>
  );
}
