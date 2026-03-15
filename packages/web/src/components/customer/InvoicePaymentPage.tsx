import { useState } from 'react';
import {
  CreditCard, Building2, Lock, Check, Phone, Mail,
  CheckCircle2, ChevronDown, ChevronUp, Shield, AlertCircle,
} from 'lucide-react';
import { useParams } from 'react-router';
import { invoices, customers, calcInvoiceTotal } from '../../data/mock-data';

// ─── Card input form ──────────────────────────────────────────────────────
function CardForm({ onPay, total }: { onPay: () => void; total: number }) {
  const [card,   setCard]   = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc,    setCvc]    = useState('');
  const [name,   setName]   = useState('');
  const [zip,    setZip]    = useState('');
  const [paying, setPaying] = useState(false);

  function fmt(val: string) { return val.replace(/\D/g,'').replace(/(.{4})/g,'$1 ').trim().slice(0, 19); }
  function fmtExp(val: string) { const d = val.replace(/\D/g,''); return d.length > 2 ? `${d.slice(0,2)}/${d.slice(2,4)}` : d; }

  const canPay = card.replace(/\s/g,'').length >= 15 && expiry.length === 5 && cvc.length >= 3 && name.trim() && zip.length === 5;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPay) return;
    setPaying(true);
    setTimeout(() => { setPaying(false); onPay(); }, 1600);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {/* Card number */}
      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Card number</label>
        <div className="relative">
          <input
            value={card}
            onChange={e => setCard(fmt(e.target.value))}
            placeholder="1234 5678 9012 3456"
            inputMode="numeric"
            maxLength={19}
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors pr-14"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex gap-1">
            {['V','M','A'].map(b => (
              <span key={b} className="flex size-5 items-center justify-center rounded bg-slate-100 text-xs text-slate-500">{b}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Expiry</label>
          <input
            value={expiry}
            onChange={e => setExpiry(fmtExp(e.target.value))}
            placeholder="MM/YY"
            inputMode="numeric"
            maxLength={5}
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">CVC</label>
          <input
            value={cvc}
            onChange={e => setCvc(e.target.value.replace(/\D/g,'').slice(0, 4))}
            placeholder="123"
            inputMode="numeric"
            maxLength={4}
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Name on card</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Full name"
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
        />
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Billing ZIP</label>
        <input
          value={zip}
          onChange={e => setZip(e.target.value.replace(/\D/g,'').slice(0, 5))}
          placeholder="78701"
          inputMode="numeric"
          maxLength={5}
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
        />
      </div>

      <button
        type="submit"
        disabled={!canPay || paying}
        className={`w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm transition-all mt-1 ${
          !canPay   ? 'bg-slate-100 text-slate-400 cursor-not-allowed' :
          paying    ? 'bg-green-500 text-white' :
                      'bg-slate-900 text-white hover:bg-slate-700 active:scale-[0.98] shadow-lg shadow-slate-900/20'
        }`}
      >
        {paying
          ? <><span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Processing…</>
          : <><Lock size={14} /> Pay ${total.toLocaleString()} securely</>
        }
      </button>
    </form>
  );
}

// ─── ACH form ─────────────────────────────────────────────────────────────
function ACHForm({ onPay, total }: { onPay: () => void; total: number }) {
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const [name,    setName]    = useState('');
  const [paying,  setPaying]  = useState(false);

  const canPay = routing.length === 9 && account.length >= 8 && name.trim();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPay) return;
    setPaying(true);
    setTimeout(() => { setPaying(false); onPay(); }, 1600);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex items-start gap-3 rounded-xl bg-blue-50 border border-blue-100 px-4 py-3 mb-1">
        <Building2 size={14} className="text-blue-500 shrink-0 mt-0.5" />
        <p className="text-xs text-blue-700 leading-relaxed">
          ACH bank transfers typically process in 1–3 business days. You'll receive a confirmation email once payment is received.
        </p>
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Account holder name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Full name on account"
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Routing number (9 digits)</label>
        <input
          value={routing}
          onChange={e => setRouting(e.target.value.replace(/\D/g,'').slice(0, 9))}
          placeholder="021000021"
          inputMode="numeric"
          maxLength={9}
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1.5">Account number</label>
        <input
          value={account}
          onChange={e => setAccount(e.target.value.replace(/\D/g,'').slice(0, 17))}
          placeholder="•••••••••••"
          inputMode="numeric"
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors"
        />
      </div>
      <button
        type="submit"
        disabled={!canPay || paying}
        className={`w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm transition-all mt-1 ${
          !canPay ? 'bg-slate-100 text-slate-400 cursor-not-allowed' :
          paying  ? 'bg-green-500 text-white' :
                    'bg-slate-900 text-white hover:bg-slate-700 active:scale-[0.98] shadow-lg shadow-slate-900/20'
        }`}
      >
        {paying
          ? <><span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Processing…</>
          : <><Building2 size={14} /> Submit bank transfer — ${total.toLocaleString()}</>
        }
      </button>
    </form>
  );
}

// ─── Success screen ────────────────────────────────────────────────────────
function PaidScreen({ customer, invoiceNumber, total, method }: {
  customer: string; invoiceNumber: string; total: number; method: 'card' | 'ach';
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
      <div className="flex flex-col items-center gap-5 max-w-xs" style={{ animation: 'popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <div className="flex size-20 items-center justify-center rounded-full bg-green-500 shadow-xl shadow-green-200">
          <CheckCircle2 size={40} className="text-white" />
        </div>
        <div>
          <h1 className="text-slate-900" style={{ fontSize: '1.6rem', lineHeight: 1.2 }}>Payment received!</h1>
          <p className="text-slate-500 mt-2 leading-relaxed text-sm">
            Thank you, {customer.split(' ')[0]}! Your payment of <strong>${total.toLocaleString()}</strong> for {invoiceNumber} has been {method === 'ach' ? 'submitted' : 'processed'}.
          </p>
        </div>
        <div className="w-full rounded-2xl bg-slate-50 border border-slate-200 px-5 py-4 flex flex-col gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Invoice</span>
            <span className="text-slate-800">{invoiceNumber}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Amount</span>
            <span className="text-slate-800">${total.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Method</span>
            <span className="text-slate-800">{method === 'ach' ? 'ACH bank transfer' : 'Credit card'}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Status</span>
            <span className="text-green-700 flex items-center gap-1"><Check size={12} /> {method === 'ach' ? 'Submitted' : 'Paid'}</span>
          </div>
        </div>
        <p className="text-xs text-slate-400">A receipt has been sent. Questions? (512) 555-0000</p>
      </div>
      <style>{`@keyframes popIn { 0%{opacity:0;transform:scale(0.8);}70%{transform:scale(1.05);}100%{opacity:1;transform:scale(1);} }`}</style>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────
export function InvoicePaymentPage() {
  const { id }                      = useParams<{ id: string }>();
  const [method,  setMethod]        = useState<'card' | 'ach'>('card');
  const [paid,    setPaid]          = useState(false);
  const [showAll, setShowAll]       = useState(false);

  const inv = invoices.find(i =>
    i.id === id || i.invoiceNumber.toLowerCase().replace('-','') === id?.toLowerCase()
  ) ?? invoices[1]; // fallback to unpaid invoice for demo

  const customer = customers.find(c => c.id === inv.customerId);
  const total    = calcInvoiceTotal(inv);
  const isOverdue = inv.status === 'Overdue';
  const visItems  = showAll ? inv.lineItems : inv.lineItems.slice(0, 3);

  if (paid) return <PaidScreen customer={inv.customer} invoiceNumber={inv.invoiceNumber} total={total} method={method} />;

  if (inv.status === 'Paid') {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
        <CheckCircle2 size={48} className="text-green-500 mb-4" />
        <h1 className="text-slate-900 mb-2">Already paid</h1>
        <p className="text-sm text-slate-500">This invoice has already been paid. Thank you!</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
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

      <div className="max-w-lg mx-auto px-5 py-6">
        {/* Overdue banner */}
        {isOverdue && (
          <div className="flex items-start gap-3 rounded-2xl bg-red-50 border border-red-200 px-4 py-3.5 mb-5">
            <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-red-800">This invoice is overdue</p>
              <p className="text-xs text-red-600 mt-0.5">Was due {inv.dueDate}. Please pay as soon as possible.</p>
            </div>
          </div>
        )}

        {/* Invoice header */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-500 uppercase tracking-widest">Invoice</span>
          <span className="text-xs text-slate-500">{inv.invoiceNumber}</span>
        </div>
        <h1 className="text-slate-900 mb-0.5" style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>
          Hi, {inv.customer.split(' ')[0]}!
        </h1>
        <p className="text-sm text-slate-500 mb-5">{customer?.address}</p>

        {/* Service */}
        <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 mb-4">
          <p className="text-xs text-slate-400 mb-1">For</p>
          <p className="text-sm text-slate-800">{inv.description}</p>
          {inv.dueDate && (
            <p className={`text-xs mt-1.5 flex items-center gap-1 ${isOverdue ? 'text-red-500' : 'text-slate-400'}`}>
              <span className={`size-1.5 rounded-full inline-block ${isOverdue ? 'bg-red-400' : 'bg-slate-300'}`} />
              {isOverdue ? 'Was due' : 'Due'} {inv.dueDate}
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
          {inv.lineItems.length > 3 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="flex items-center justify-center gap-1 w-full py-2.5 text-xs text-slate-400 hover:text-slate-600 border-t border-slate-100 transition-colors"
            >
              {showAll ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> {inv.lineItems.length - 3} more items</>}
            </button>
          )}
          <div className="flex items-center justify-between px-5 py-4 bg-slate-900 rounded-b-2xl">
            <p className="text-sm text-slate-300">Amount due</p>
            <p className="text-white" style={{ fontSize: '1.25rem' }}>${total.toLocaleString()}</p>
          </div>
        </div>

        {/* Payment method selector */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-5">
          <div className="px-5 py-4 border-b border-slate-100">
            <p className="text-sm text-slate-700">Pay with</p>
          </div>
          <div className="flex p-3 gap-2">
            <button
              onClick={() => setMethod('card')}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl border py-3 text-sm transition-all ${
                method === 'card' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <CreditCard size={15} /> Card
            </button>
            <button
              onClick={() => setMethod('ach')}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl border py-3 text-sm transition-all ${
                method === 'ach' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Building2 size={15} /> Bank / ACH
              {method === 'ach' && <span className="text-xs text-green-300 ml-1">lower fee</span>}
            </button>
          </div>

          <div className="px-5 pb-5">
            {method === 'card'
              ? <CardForm onPay={() => setPaid(true)} total={total} />
              : <ACHForm  onPay={() => setPaid(true)} total={total} />
            }
          </div>
        </div>

        {/* Trust signals */}
        <div className="flex flex-col items-center gap-2 pb-8">
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1"><Lock size={10} /> 256-bit SSL</span>
            <span className="flex items-center gap-1"><Shield size={10} /> Powered by Stripe</span>
          </div>
          <p className="text-xs text-slate-400">No Fieldly account required · Your data is never stored</p>
        </div>
      </div>
    </div>
  );
}
