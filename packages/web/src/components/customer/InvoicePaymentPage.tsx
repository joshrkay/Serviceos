import { useState, useEffect } from 'react';
import {
  Lock, Check, Phone, Mail,
  CheckCircle2, ChevronDown, ChevronUp, Shield, AlertCircle, ExternalLink,
} from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';

// ─── API types ──────────────────────────────────────────────────────────────

interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

interface PublicInvoiceView {
  id: string;
  invoiceNumber: string;
  status: string;
  customerName: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  lineItems: LineItem[];
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  dueDate?: string;
  customerMessage?: string;
  isPaid: boolean;
  viewCount: number;
  stripePaymentLinkUrl?: string;
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function fetchInvoice(token: string): Promise<PublicInvoiceView> {
  const res = await fetch(`/public/invoices/${token}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Error ${res.status}`);
  }
  return res.json() as Promise<PublicInvoiceView>;
}

async function pingView(token: string) {
  await fetch(`/public/invoices/${token}/view`, { method: 'POST' }).catch(() => undefined);
}

async function createCheckout(token: string): Promise<string> {
  const res = await fetch(`/public/invoices/${token}/checkout`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Error ${res.status}`);
  }
  const data = await res.json() as { url: string };
  return data.url;
}

// ─── Success screen ────────────────────────────────────────────────────────

function PaidScreen({ customerName, invoiceNumber, totalCents, businessPhone }: {
  customerName: string;
  invoiceNumber: string;
  totalCents: number;
  businessPhone?: string;
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
            Thank you, {(customerName || 'there').split(' ')[0] || 'there'}! Your payment of{' '}
            <strong>${formatMoney(totalCents)}</strong> for {invoiceNumber} has been processed.
          </p>
        </div>
        <div className="w-full rounded-2xl bg-slate-50 border border-slate-200 px-5 py-4 flex flex-col gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Invoice</span>
            <span className="text-slate-800">{invoiceNumber}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Amount</span>
            <span className="text-slate-800">${formatMoney(totalCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Status</span>
            <span className="text-green-700 flex items-center gap-1"><Check size={12} /> Paid</span>
          </div>
        </div>
        {businessPhone && (
          <p className="text-xs text-slate-400">A receipt has been sent. Questions? {businessPhone}</p>
        )}
      </div>
      <style>{`@keyframes popIn { 0%{opacity:0;transform:scale(0.8);}70%{transform:scale(1.05);}100%{opacity:1;transform:scale(1);} }`}</style>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────

export function InvoicePaymentPage() {
  const { id: token } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  const [invoice, setInvoice] = useState<PublicInvoiceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Stripe redirects back with ?success=true after a completed checkout session.
  const paymentSucceeded = searchParams.get('success') === 'true';

  useEffect(() => {
    if (!token) { setError('Invalid payment link'); setLoading(false); return; }
    fetchInvoice(token)
      .then((inv) => {
        setInvoice(inv);
        setLoading(false);
        pingView(token);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [token]);

  async function handlePayNow() {
    if (!token || checkoutLoading) return;
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const url = await createCheckout(token);
      // Validate the URL is a legitimate Stripe-hosted checkout page before
      // navigating — guards against a compromised API response injecting
      // javascript: URIs or redirecting to arbitrary hosts.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid checkout URL returned by server');
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.stripe.com')) {
        throw new Error('Unexpected checkout URL returned by server');
      }
      window.location.href = url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Could not start checkout. Please try again.');
      setCheckoutLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <span className="size-8 rounded-full border-2 border-slate-200 border-t-slate-900 animate-spin" />
      </div>
    );
  }

  if (error && !invoice) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center gap-4">
        <AlertCircle size={40} className="text-slate-300" />
        <h1 className="text-slate-900">Invoice not found</h1>
        <p className="text-sm text-slate-500">This payment link may have expired or been removed.</p>
      </div>
    );
  }

  const inv = invoice!;
  const isOverdue = inv.dueDate ? new Date(inv.dueDate) < new Date() && !inv.isPaid : false;
  const visItems = showAll ? inv.lineItems : inv.lineItems.slice(0, 3);

  // Show paid screen when:
  //   • invoice is fully settled (isPaid or amountDueCents === 0)
  //   • Stripe redirected back with ?success=true (webhook may not have fired yet)
  // amountDueCents === 0 guard prevents showing the pay form during the
  // 1–5 second window between Stripe's redirect and webhook processing.
  if (inv.isPaid || inv.amountDueCents <= 0 || paymentSucceeded) {
    return (
      <PaidScreen
        customerName={inv.customerName}
        invoiceNumber={inv.invoiceNumber}
        totalCents={inv.amountPaidCents > 0 ? inv.amountPaidCents : inv.totalCents}
        businessPhone={inv.businessPhone}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-5 py-4">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
              <span className="text-white" style={{ fontSize: 13 }}>S</span>
            </div>
            <div>
              <p className="text-sm text-slate-800">{inv.businessName}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {inv.businessPhone && (
              <a href={`tel:${inv.businessPhone}`} className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
                <Phone size={14} className="text-slate-600" />
              </a>
            )}
            {inv.businessEmail && (
              <a href={`mailto:${inv.businessEmail}`} className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
                <Mail size={14} className="text-slate-600" />
              </a>
            )}
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
              <p className="text-xs text-red-600 mt-0.5">Was due {formatDate(inv.dueDate)}. Please pay as soon as possible.</p>
            </div>
          </div>
        )}

        {/* Invoice header */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-500 uppercase tracking-widest">Invoice</span>
          <span className="text-xs text-slate-500">{inv.invoiceNumber}</span>
        </div>
        <h1 className="text-slate-900 mb-0.5" style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>
          Hi, {(inv.customerName || 'there').split(' ')[0] || 'there'}!
        </h1>
        {inv.dueDate && (
          <p className={`text-sm mb-5 ${isOverdue ? 'text-red-500' : 'text-slate-500'}`}>
            {isOverdue ? 'Was due' : 'Due'} {formatDate(inv.dueDate)}
          </p>
        )}

        {/* Customer message */}
        {inv.customerMessage && (
          <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 mb-4">
            <p className="text-xs text-slate-400 mb-1">Message from {inv.businessName}</p>
            <p className="text-sm text-slate-700">{inv.customerMessage}</p>
          </div>
        )}

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
                <p className="text-sm text-slate-500 text-right">{item.quantity}</p>
                <p className="text-sm text-slate-500 text-right">${formatMoney(item.unitPriceCents)}</p>
                <p className="text-sm text-slate-800 text-right">${formatMoney(item.totalCents)}</p>
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
          {/* Totals */}
          {inv.discountCents > 0 && (
            <div className="flex justify-between px-5 py-2 border-t border-slate-100">
              <span className="text-sm text-slate-500">Discount</span>
              <span className="text-sm text-slate-500">-${formatMoney(inv.discountCents)}</span>
            </div>
          )}
          {inv.taxCents > 0 && (
            <div className="flex justify-between px-5 py-2 border-t border-slate-100">
              <span className="text-sm text-slate-500">Tax</span>
              <span className="text-sm text-slate-500">${formatMoney(inv.taxCents)}</span>
            </div>
          )}
          {inv.amountPaidCents > 0 && (
            <div className="flex justify-between px-5 py-2 border-t border-slate-100">
              <span className="text-sm text-slate-500">Paid</span>
              <span className="text-sm text-green-600">-${formatMoney(inv.amountPaidCents)}</span>
            </div>
          )}
          <div className="flex items-center justify-between px-5 py-4 bg-slate-900 rounded-b-2xl">
            <p className="text-sm text-slate-300">Amount due</p>
            <p className="text-white" style={{ fontSize: '1.25rem' }}>${formatMoney(inv.amountDueCents)}</p>
          </div>
        </div>

        {/* Pay button */}
        <div className="bg-white rounded-2xl border border-slate-200 px-5 py-5 mb-5">
          {checkoutError && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {checkoutError}
            </div>
          )}
          <button
            onClick={handlePayNow}
            disabled={checkoutLoading}
            className={`w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm transition-all ${
              checkoutLoading
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-slate-900 text-white hover:bg-slate-700 active:scale-[0.98] shadow-lg shadow-slate-900/20'
            }`}
          >
            {checkoutLoading
              ? <><span className="size-4 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" /> Opening secure checkout…</>
              : <><Lock size={14} /> Pay ${formatMoney(inv.amountDueCents)} securely <ExternalLink size={12} /></>
            }
          </button>
          <p className="text-xs text-slate-400 text-center mt-3">
            You'll be taken to a secure Stripe checkout page
          </p>
        </div>

        {/* Trust signals */}
        <div className="flex flex-col items-center gap-2 pb-8">
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1"><Lock size={10} /> 256-bit SSL</span>
            <span className="flex items-center gap-1"><Shield size={10} /> Powered by Stripe</span>
          </div>
          <p className="text-xs text-slate-400">No account required · Your card data is never stored by us</p>
        </div>
      </div>
    </div>
  );
}
