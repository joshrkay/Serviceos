import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router';
import {
  Check, Phone, Mail, ChevronDown, ChevronUp, CheckCircle2, X,
  MapPin, FileText, Calendar, Clock, User,
} from 'lucide-react';
import { estimates, customers, calcEstimateTotal } from '../../data/mock-data';

// ─── Signature canvas ─────────────────────────────────────────────────────
function SignatureCanvas({ onChange }: { onChange: (hasSig: boolean) => void }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const drawing    = useRef(false);
  const [hasSig, setHasSig] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Size canvas to its CSS display size
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width  = rect.width  * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
    };
    resize();
  }, []);

  function getXY(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const t = e.touches[0];
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onStart(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = getXY(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function onMove(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getXY(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasSig) { setHasSig(true); onChange(true); }
  }
  function onEnd() { drawing.current = false; }

  function clear() {
    const canvas = canvasRef.current;
    const ctx    = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSig(false);
    onChange(false);
  }

  return (
    <div className="relative rounded-xl border-2 border-dashed border-slate-300 bg-white overflow-hidden" style={{ height: 96 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onMouseDown={onStart} onMouseMove={onMove} onMouseUp={onEnd} onMouseLeave={onEnd}
        onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}
      />
      {!hasSig && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-400 pointer-events-none">
          Draw your signature here
        </p>
      )}
      {hasSig && (
        <button
          onClick={clear}
          className="absolute top-2 right-2 flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-500 hover:text-slate-700 shadow-sm"
        >
          <X size={10} /> Clear
        </button>
      )}
    </div>
  );
}

// ─── Approval sheet ───────────────────────────────────────────────────────
function ApprovalSheet({
  estimateNumber, customer, total, onClose, onConfirm,
}: {
  estimateNumber: string; customer: string; total: number;
  onClose: () => void; onConfirm: () => void;
}) {
  const [name,    setName]    = useState(customer);
  const [hasSig,  setHasSig]  = useState(false);
  const [loading, setLoading] = useState(false);

  function submit() {
    if (!name.trim() || !hasSig) return;
    setLoading(true);
    setTimeout(() => { setLoading(false); onConfirm(); }, 1400);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl shadow-2xl overflow-y-auto max-h-[92vh]"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'sheetUp 0.3s cubic-bezier(0.32,0.72,0,1)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>

        <div className="px-6 pb-8 pt-2">
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div>
              <p className="text-sm text-slate-400 mb-0.5">Accepting</p>
              <h2 className="text-slate-900" style={{ fontSize: '1.15rem' }}>{estimateNumber}</h2>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400 mb-0.5">Total</p>
              <p className="text-slate-900" style={{ fontSize: '1.3rem' }}>${total.toLocaleString()}</p>
            </div>
          </div>

          {/* Legal note */}
          <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 rounded-xl px-4 py-3 mb-5">
            By accepting this estimate you're agreeing to the scope and pricing above. Work will be scheduled after acceptance.
          </p>

          {/* Name */}
          <div className="mb-4">
            <label className="block text-xs text-slate-500 mb-1.5">Full name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
              placeholder="Your full name"
            />
          </div>

          {/* Signature */}
          <div className="mb-6">
            <label className="block text-xs text-slate-500 mb-1.5">Signature</label>
            <SignatureCanvas onChange={setHasSig} />
          </div>

          {/* Date */}
          <div className="flex items-center justify-between text-xs text-slate-400 mb-6">
            <span>Accepted on</span>
            <span>March 10, 2026</span>
          </div>

          {/* Button */}
          <button
            onClick={submit}
            disabled={!name.trim() || !hasSig || loading}
            className={`w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm transition-all ${
              !name.trim() || !hasSig
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : loading
                ? 'bg-green-400 text-white'
                : 'bg-slate-900 text-white hover:bg-slate-700 active:scale-[0.98]'
            }`}
          >
            {loading ? (
              <><span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Processing…</>
            ) : (
              <><Check size={16} /> Accept estimate</>
            )}
          </button>
        </div>
      </div>
      <style>{`@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </div>
  );
}

// ─── Success screen ────────────────────────────────────────────────────────
function SuccessScreen({
  customer, estimateNumber, description, address, total,
}: {
  customer: string;
  estimateNumber: string;
  description: string;
  address: string;
  total: number;
}) {
  // Mock auto-created job number
  const jobNumber = 'JOB-1053';
  const firstName = customer.split(' ')[0];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Branded header */}
      <div className="bg-white border-b border-slate-200 px-5 py-4">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
              <span className="text-white" style={{ fontSize: 13 }}>F</span>
            </div>
            <div>
              <p className="text-sm text-slate-800">Fieldly Pro Services</p>
              <p className="text-xs text-slate-400">Austin, TX</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="tel:5125550000" className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
              <Phone size={14} className="text-slate-600" />
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-5 py-8 pb-16">

        {/* Hero confirmation */}
        <div className="flex flex-col items-center text-center gap-4 mb-8"
          style={{ animation: 'popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <div className="flex size-20 items-center justify-center rounded-full bg-green-500 shadow-xl shadow-green-200">
            <CheckCircle2 size={40} className="text-white" />
          </div>
          <div>
            <h1 className="text-slate-900" style={{ fontSize: '1.6rem', lineHeight: 1.2 }}>
              Estimate accepted!
            </h1>
            <p className="text-slate-500 mt-2 text-sm leading-relaxed">
              Thanks, {firstName}! Your job has been created and our team will be in touch shortly to confirm your appointment.
            </p>
          </div>
        </div>

        {/* Job card */}
        <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white mb-4"
          style={{ animation: 'fadeUp 0.4s ease 0.2s both' }}>
          {/* Dark header */}
          <div className="bg-slate-900 px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-lg bg-white/10 flex items-center justify-center">
                  <span className="text-white" style={{ fontSize: 11 }}>F</span>
                </div>
                <p className="text-sm text-white">Fieldly Pro Services</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs text-green-400">Job created</span>
              </div>
            </div>
            <p className="text-xs text-slate-400 mb-1">{description}</p>
            <p className="text-white" style={{ fontSize: '1.5rem', lineHeight: 1 }}>
              ${total.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-1">{jobNumber}</p>
          </div>

          {/* Detail rows */}
          <div className="divide-y divide-slate-50">
            <div className="flex items-start gap-3 px-5 py-3.5">
              <User size={14} className="text-slate-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-400 mb-0.5">Customer</p>
                <p className="text-sm text-slate-800">{customer}</p>
              </div>
            </div>

            <div className="flex items-start gap-3 px-5 py-3.5">
              <MapPin size={14} className="text-slate-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-400 mb-0.5">Service address</p>
                <p className="text-sm text-slate-800">{address}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 px-5 py-3.5">
              <Check size={14} className="text-green-500 shrink-0" />
              <div className="flex-1">
                <p className="text-xs text-slate-400 mb-0.5">Accepted</p>
                <p className="text-sm text-slate-800">March 10, 2026 · Estimate approved</p>
              </div>
            </div>

            <div className="flex items-center gap-3 px-5 py-3.5">
              <FileText size={14} className="text-slate-400 shrink-0" />
              <div className="flex-1">
                <p className="text-xs text-slate-400 mb-0.5">From estimate</p>
                <p className="text-sm text-slate-500">{estimateNumber}</p>
              </div>
            </div>
          </div>
        </div>

        {/* What happens next */}
        <div className="rounded-2xl bg-white border border-slate-200 px-5 py-4 mb-4"
          style={{ animation: 'fadeUp 0.4s ease 0.35s both' }}>
          <p className="text-sm text-slate-800 mb-4">What happens next</p>
          <div className="flex flex-col gap-4">
            {[
              {
                step: 1,
                icon: Calendar,
                title: 'We schedule your job',
                desc: 'Our team will call or text you within 1 business day to confirm a date and time that works.',
                color: 'bg-blue-100 text-blue-600',
              },
              {
                step: 2,
                icon: Clock,
                title: 'Day-before reminder',
                desc: 'We\'ll send you a reminder the evening before your appointment with your tech\'s name and arrival window.',
                color: 'bg-violet-100 text-violet-600',
              },
              {
                step: 3,
                icon: CheckCircle2,
                title: 'Work done, invoice follows',
                desc: 'After the job is complete you\'ll receive a final invoice reflecting any on-site adjustments.',
                color: 'bg-green-100 text-green-600',
              },
            ].map(({ step, icon: Icon, title, desc, color }) => (
              <div key={step} className="flex items-start gap-3.5">
                <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${color}`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-sm text-slate-800">{title}</p>
                  <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Contact footer */}
        <div className="flex flex-col items-center gap-3 text-center"
          style={{ animation: 'fadeUp 0.4s ease 0.5s both' }}>
          <p className="text-xs text-slate-400">
            Questions? Reach us any time.
          </p>
          <div className="flex items-center gap-3">
            <a href="tel:5125550000"
              className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
              <Phone size={13} className="text-slate-500" /> (512) 555-0000
            </a>
            <a href="mailto:info@fieldly.pro"
              className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
              <Mail size={13} className="text-slate-500" /> Email us
            </a>
          </div>
        </div>

      </div>

      <style>{`
        @keyframes popIn { 0% { opacity:0; transform:scale(0.8); } 70% { transform:scale(1.05); } 100% { opacity:1; transform:scale(1); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
      `}</style>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────
export function EstimateApprovalPage() {
  const { id }                    = useParams<{ id: string }>();
  const [showApproval, setAppr]   = useState(false);
  const [accepted,     setAccept] = useState(false);
  const [showAllItems, setAll]    = useState(false);

  const est = estimates.find(e =>
    e.id === id || e.estimateNumber.toLowerCase().replace('-', '') === id?.toLowerCase()
  ) ?? estimates[0];

  const customer = customers.find(c => c.id === est.customerId);
  const total    = calcEstimateTotal(est);
  const visItems = showAllItems ? est.lineItems : est.lineItems.slice(0, 3);

  if (accepted) return (
    <SuccessScreen
      customer={est.customer}
      estimateNumber={est.estimateNumber}
      description={est.description}
      address={customer?.address ?? ''}
      total={total}
    />
  );

  return (
    <>
      <div className="min-h-screen bg-slate-50">
        {/* Branded header */}
        <div className="bg-white border-b border-slate-200 px-5 py-4">
          <div className="max-w-lg mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
                <span className="text-white" style={{ fontSize: 13 }}>F</span>
              </div>
              <div>
                <p className="text-sm text-slate-800">Fieldly Pro Services</p>
                <p className="text-xs text-slate-400">Austin, TX</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <a href="tel:5125550000" className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
                <Phone size={14} className="text-slate-600" />
              </a>
              <a href="mailto:info@fieldly.pro" className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
                <Mail size={14} className="text-slate-600" />
              </a>
            </div>
          </div>
        </div>

        <div className="max-w-lg mx-auto px-5 py-6 pb-32">
          {/* Estimate badge */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-500 uppercase tracking-widest">Estimate</span>
            <span className="text-xs text-slate-500">{est.estimateNumber}</span>
          </div>

          {/* Customer */}
          <h1 className="text-slate-900 mb-0.5" style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>
            Hi, {est.customer.split(' ')[0]}!
          </h1>
          <p className="text-sm text-slate-500 mb-5">
            {customer?.address}
          </p>

          {/* Service description */}
          <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 mb-4">
            <p className="text-xs text-slate-400 mb-1">Service</p>
            <p className="text-sm text-slate-800">{est.description}</p>
            {est.validUntil && (
              <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-400 inline-block" />
                Valid until {est.validUntil}
              </p>
            )}
          </div>

          {/* Line items */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-4">
            <div className="grid grid-cols-[1fr_40px_72px_72px] gap-x-2 px-5 py-2.5 bg-slate-50 border-b border-slate-100">
              <p className="text-xs text-slate-400">Item</p>
              <p className="text-xs text-slate-400 text-right">Qty</p>
              <p className="text-xs text-slate-400 text-right">Rate</p>
              <p className="text-xs text-slate-400 text-right">Total</p>
            </div>
            <div className="divide-y divide-slate-50">
              {visItems.map((item, i) => (
                <div key={i} className="grid grid-cols-[1fr_40px_72px_72px] gap-x-2 px-5 py-3 items-start">
                  <p className="text-sm text-slate-800">{item.description}</p>
                  <p className="text-sm text-slate-500 text-right">{item.qty}</p>
                  <p className="text-sm text-slate-500 text-right">${item.rate.toLocaleString()}</p>
                  <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toLocaleString()}</p>
                </div>
              ))}
            </div>
            {est.lineItems.length > 3 && (
              <button
                onClick={() => setAll(v => !v)}
                className="flex items-center justify-center gap-1 w-full py-2.5 text-xs text-slate-400 hover:text-slate-600 border-t border-slate-100 transition-colors"
              >
                {showAllItems ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> {est.lineItems.length - 3} more items</>}
              </button>
            )}
            <div className="flex items-center justify-between px-5 py-4 bg-slate-900 rounded-b-2xl">
              <p className="text-sm text-slate-300">Estimate total</p>
              <p className="text-white" style={{ fontSize: '1.15rem' }}>${total.toLocaleString()}</p>
            </div>
          </div>

          {/* Notes */}
          <p className="text-xs text-slate-400 text-center px-4 mb-6 leading-relaxed">
            This estimate is valid until {est.validUntil ?? 'Mar 24, 2026'}. Prices may change if site conditions differ from what was quoted. Contact us with any questions.
          </p>
        </div>

        {/* Fixed CTA */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 pb-safe pt-3">
          <div className="max-w-lg mx-auto">
            <button
              onClick={() => setAppr(true)}
              className="w-full flex items-center justify-center gap-2 rounded-2xl bg-slate-900 text-white py-4 text-sm hover:bg-slate-700 active:scale-[0.98] transition-all shadow-xl shadow-slate-900/20"
            >
              <Check size={16} /> Accept this estimate
            </button>
            <p className="text-center text-xs text-slate-400 mt-2 pb-1">
              No account needed · Fieldly Pro Services
            </p>
          </div>
        </div>
      </div>

      {showApproval && (
        <ApprovalSheet
          estimateNumber={est.estimateNumber}
          customer={est.customer}
          total={total}
          onClose={() => setAppr(false)}
          onConfirm={() => { setAppr(false); setAccept(true); }}
        />
      )}
    </>
  );
}