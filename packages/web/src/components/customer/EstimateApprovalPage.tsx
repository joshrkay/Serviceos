import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams } from 'react-router';
import {
  Check, Phone, Mail, ChevronDown, ChevronUp, CheckCircle2, X,
  MapPin, FileText, Calendar, Clock, User, Download,
} from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { printEstimateDocument } from '../../lib/estimatePdf';
import { Button } from '../ui/button';

/**
 * Format a USD dollar amount with exactly two fraction digits. A bare
 * `n.toLocaleString()` drops the cents (e.g. 1234.5 → "1,234.5",
 * 1234 → "1,234"), which mis-states money on this customer-facing page.
 */
const fmtUsd = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Whole days from now until `iso` (negative once past). null when unparseable. */
function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  return Math.ceil((then - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Human "May 14, 2026" from an ISO string; '' when unparseable. */
function fmtFriendlyDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface PublicEstimateView {
  id: string;
  estimateNumber: string;
  status: string;
  customerName: string;
  customerAddress?: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  lineItems: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    taxable?: boolean;
    groupKey?: string;
    groupLabel?: string;
    isOptional?: boolean;
    isDefaultSelected?: boolean;
  }>;
  /** True when the estimate has tier options or optional add-ons to choose. */
  hasSelectableItems?: boolean;
  /** Tax rate (basis points) so the preview mirrors server tax math exactly. */
  taxRateBps?: number;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  validUntil?: string;
  customerMessage?: string;
  isActionable: boolean;
  acceptedAt?: string;
  acceptedByName?: string;
  rejectedAt?: string;
  rejectedReason?: string;
  isExpired: boolean;
  /** Optimistic-lock / re-sync counter. Sent back as expectedVersion on approve. */
  version: number;
  /** ISO timestamp the estimate was last revised after sending. */
  lastRevisedAt?: string;
  /**
   * Tier 4 (Deposit rules — PR 3a). Required deposit cents derived
   * from the linked job. 0 when no rule applies; >0 means the
   * customer must pay this much before work begins. The UI surfaces
   * the figure on the approval card today; PR 3b adds the
   * "Pay deposit" CTA + Stripe link.
   */
  depositRequiredCents?: number;
  depositPaidCents?: number;
  depositStatus?: 'not_required' | 'pending' | 'paid';
  /**
   * Tier 4 (Deposit rules — PR 3b). Tenant policy controlling whether
   * the deposit must be paid BEFORE the customer can approve the
   * estimate. The page replaces the Accept CTA with a Pay deposit
   * CTA when this is `'before_approval'` and the deposit is unpaid.
   */
  depositTimingPolicy?: 'before_approval' | 'after_approval';
  /**
   * Pre-existing Stripe Payment Link for the deposit, surfaced read-only
   * here so a returning customer doesn't trigger a fresh mint when one
   * already exists. The page calls POST /deposit-checkout when this is
   * absent or expired.
   */
  depositCheckoutUrl?: string;
  /**
   * Hennessy — payment-link UX. ISO deadline for the deposit checkout
   * link. Surfaced as a "pay by" hint; the server re-mints the link once
   * this passes so the customer never lands on a dead URL.
   */
  depositCheckoutExpiresAt?: string;
}

// ─── Signature canvas ─────────────────────────────────────────────────────
function SignatureCanvas({ onChange, canvasRef: externalRef }: {
  onChange: (hasSig: boolean) => void;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
}) {
  const localRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalRef ?? (localRef as unknown as React.MutableRefObject<HTMLCanvasElement | null>);
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
  estimateNumber, customer, total, token, expectedVersion, selectedLineItemIds, onStale, onClose, onConfirm,
}: {
  estimateNumber: string; customer: string; total: number;
  /** When set, submit calls the real /public/estimates/:token/approve endpoint. */
  token?: string;
  /** The version the customer is viewing; sent so a stale accept is rejected. */
  expectedVersion?: number;
  /** Good-better-best selection, when the estimate has selectable items. */
  selectedLineItemIds?: string[];
  /** Called when the server reports the estimate changed (409) since load. */
  onStale?: () => void;
  onClose: () => void; onConfirm: (view?: PublicEstimateView) => void;
}) {
  const sigRef = useRef<HTMLCanvasElement | null>(null);
  const [name,    setName]    = useState(customer);
  const [hasSig,  setHasSig]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !hasSig) return;
    setLoading(true);
    setError(null);
    try {
      let view: PublicEstimateView | undefined;
      if (token) {
        const signatureData = sigRef.current?.toDataURL('image/png');
        const res = await apiFetch(`/public/estimates/${token}/approve`, {
          method: 'POST',
          body: JSON.stringify({
            acceptedByName: name.trim(),
            // Keep payload size sane — most signatures fit under ~50KB.
            signatureData: signatureData && signatureData.length < 200_000
              ? signatureData
              : undefined,
            expectedVersion,
            selectedLineItemIds,
          }),
        });
        if (res.status === 409) {
          // The estimate was revised after the customer opened it. Bounce
          // back to the page so they review the latest version first.
          setLoading(false);
          onStale?.();
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({} as any));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        view = await res.json() as PublicEstimateView;
      } else {
        await new Promise((r) => setTimeout(r, 1200));
      }
      setLoading(false);
      onConfirm(view);
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Approval failed');
    }
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
              <p className="text-slate-900" style={{ fontSize: '1.3rem' }}>${fmtUsd(total)}</p>
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
            <SignatureCanvas onChange={setHasSig} canvasRef={sigRef} />
          </div>

          {error && (
            <p className="text-xs text-red-600 mb-3 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

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
              <p className="text-sm text-slate-800">Rivet Pro Services</p>
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
                <p className="text-sm text-white">Rivet Pro Services</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs text-green-400">Job created</span>
              </div>
            </div>
            <p className="text-xs text-slate-400 mb-1">{description}</p>
            <p className="text-white" style={{ fontSize: '1.5rem', lineHeight: 1 }}>
              ${fmtUsd(total)}
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
            <a href="mailto:info@rivet.ai"
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

  // Load the estimate from the real public API. We must NOT fall back to
  // fixture/mock data on failure: this page is served on a public URL, so
  // a fixture render would leak another customer's name, address, and
  // pricing. 404 → "Link not found"; any other failure → retryable error.
  const [apiView, setApiView] = useState<PublicEstimateView | null>(null);
  const [apiLoading, setApiLoading] = useState(true);
  const [apiNotFound, setApiNotFound] = useState(false);
  // Set when the estimate could not be loaded for a reason other than 404
  // (network error or non-OK response). We render a safe error screen
  // with a Retry action rather than any fixture data.
  const [apiError, setApiError] = useState(false);
  // Bumped by the Retry button to re-trigger the load effect after a
  // transient network/server error.
  const [retryNonce, setRetryNonce] = useState(0);
  // Set when a background poll detects the business revised the estimate
  // (version bumped) after the customer opened the page. The banner asks
  // them to review the latest version; approve is also blocked server-side.
  const [revised, setRevised] = useState(false);
  // Good-better-best: the line-item ids the customer has chosen. Null
  // until the estimate loads, then seeded from the server's defaults.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);

  const retryLoad = useCallback(() => {
    setApiError(false);
    setApiNotFound(false);
    setApiLoading(true);
    setRetryNonce(n => n + 1);
  }, []);

  useEffect(() => {
    if (!id) {
      setApiLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/public/estimates/${encodeURIComponent(id)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setApiNotFound(true);
          setApiLoading(false);
          return;
        }
        if (!res.ok) {
          setApiError(true);
          setApiLoading(false);
          return;
        }
        const view = await res.json() as PublicEstimateView;
        setApiView(view);
        if (view.status === 'accepted') setAccept(true);
        // Fire-and-forget view tracking.
        apiFetch(`/public/estimates/${encodeURIComponent(id)}/view`, {
          method: 'POST',
          body: JSON.stringify({}),
        }).catch(() => {});
      } catch {
        // Network error — show an error screen. We must NOT fall back to
        // fixture/mock data on a public URL (it would leak another
        // customer's name, address, and pricing).
        if (!cancelled) setApiError(true);
      } finally {
        if (!cancelled) setApiLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, retryNonce]);

  // Re-sync poll: while the page is open on a live (sent) estimate, poll
  // for a revision so the customer can't accept stale numbers. When the
  // version bumps we refresh the displayed data and raise the banner.
  // Mirrors the invoice payment page's polling approach (useInvoiceStatus).
  const loadedVersion = apiView?.version;
  useEffect(() => {
    if (!id || !apiView || accepted) return;
    if (apiView.status !== 'sent') return; // terminal states never change
    let cancelled = false;
    const POLL_MS = 15_000;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/public/estimates/${encodeURIComponent(id)}`);
        if (cancelled || !res.ok) return;
        const next = await res.json() as PublicEstimateView;
        if (cancelled) return;
        setApiView(next);
        if (next.status === 'accepted') setAccept(true);
        if (loadedVersion !== undefined && next.version > loadedVersion) {
          setRevised(true);
        }
      } catch {
        // Transient network error — keep polling.
      }
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, apiView, accepted, loadedVersion]);

  // Good-better-best: seed the customer's selection from the server
  // defaults once the estimate loads. Selectable items (tier options +
  // add-ons) are chosen by the customer; everything else is always billed.
  const hasSelectable = apiView?.hasSelectableItems ?? false;
  useEffect(() => {
    if (!apiView || !hasSelectable || selectedIds !== null) return;
    // Seed one option per tier group (the flagged default, else the first
    // by order) plus any pre-checked add-ons — matching the server's
    // default resolution so the preview total is correct on first load.
    const seed: string[] = [];
    const groups = new Map<string, typeof apiView.lineItems>();
    for (const li of apiView.lineItems) {
      if (li.groupKey) {
        const arr = groups.get(li.groupKey) ?? [];
        arr.push(li);
        groups.set(li.groupKey, arr);
      } else if (li.isOptional && li.isDefaultSelected) {
        seed.push(li.id);
      }
    }
    for (const items of groups.values()) {
      const chosen = items.find(i => i.isDefaultSelected) ?? items[0];
      if (chosen) seed.push(chosen.id);
    }
    setSelectedIds(seed);
  }, [apiView, hasSelectable, selectedIds]);

  if (apiLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="size-8 rounded-full border-2 border-slate-200 border-t-slate-900 animate-spin" />
      </div>
    );
  }

  // No real estimate data to show. We deliberately do NOT fall back to
  // fixture/mock data: this page is served on a public URL, so rendering a
  // mock estimate would expose another customer's name, address, and
  // pricing. Show a safe message instead (404 vs transient error). A
  // Retry button is offered for transient errors so the customer doesn't
  // have to hunt for a refresh control on mobile.
  if (!apiView) {
    const heading = apiNotFound ? 'Link not found' : 'Couldn’t load this estimate';
    const detail = apiNotFound
      ? 'This estimate link is invalid or has been revoked. Please contact the business that sent it.'
      : 'We couldn’t load this estimate. Please refresh or contact us.';
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-slate-900 mb-2" style={{ fontSize: '1.4rem' }}>{heading}</h1>
          <p className="text-sm text-slate-500">{detail}</p>
          {apiError && !apiNotFound && (
            <div className="mt-5 flex justify-center">
              <Button
                variant="primary"
                size="md"
                onClick={retryLoad}
                data-testid="estimate-load-retry"
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // apiView is guaranteed non-null past this point — every field derives
  // from the real public API, never from fixtures.
  const estimateNumber  = apiView.estimateNumber;
  const businessName    = apiView.businessName;
  const businessPhone   = apiView.businessPhone ?? '';
  const customerName    = apiView.customerName;
  const customerAddress = apiView.customerAddress ?? '';
  const description     = apiView.customerMessage ?? '';
  const validUntilText  = apiView.validUntil ? apiView.validUntil.slice(0, 10) : '';

  // Good-better-best derivations. `selectable` items (tier options +
  // add-ons) are chosen by the customer; everything else is always billed.
  const apiItems = apiView.lineItems;
  const isSelectable = (li: { isOptional?: boolean; groupKey?: string }) =>
    Boolean(li.isOptional || li.groupKey);
  const chosen = new Set(selectedIds ?? []);
  const billedApiItems = hasSelectable
    ? apiItems.filter(li => !isSelectable(li) || chosen.has(li.id))
    : apiItems;

  // Group the selectable items: tier groups (radio) keyed by groupKey,
  // standalone add-ons (checkbox) collected separately.
  const tierGroups = new Map<string, { label: string; items: typeof apiItems }>();
  const addOns: typeof apiItems = [];
  for (const li of apiItems) {
    if (li.groupKey) {
      const g = tierGroups.get(li.groupKey) ?? { label: li.groupLabel ?? 'Options', items: [] };
      g.items.push(li);
      tierGroups.set(li.groupKey, g);
    } else if (li.isOptional) {
      addOns.push(li);
    }
  }

  // Client-side preview total. Mirrors billing-engine.calculateDocumentTotals
  // exactly — tax is applied only to the SELECTED taxable items (after
  // discount), so changing the taxable composition (e.g. picking a
  // non-taxable tier) tracks the server's accepted total. The server still
  // recomputes authoritatively on approve.
  const selectedSubtotalCents = billedApiItems.reduce((s, li) => s + li.totalCents, 0);
  const selectedTaxableCents = billedApiItems.filter(li => li.taxable).reduce((s, li) => s + li.totalCents, 0);
  const discountCents = apiView?.discountCents ?? 0;
  const taxRateBps = apiView?.taxRateBps ?? 0;
  const previewTaxCents = Math.round((Math.max(0, selectedTaxableCents - discountCents) * taxRateBps) / 10000);
  const previewTotalCents = Math.max(0, selectedSubtotalCents - discountCents + previewTaxCents);

  function selectTier(groupKey: string, itemId: string) {
    setSelectedIds(prev => {
      const group = tierGroups.get(groupKey);
      const groupIds = new Set(group?.items.map(i => i.id) ?? []);
      const next = (prev ?? []).filter(id => !groupIds.has(id));
      next.push(itemId);
      return next;
    });
  }
  function toggleAddOn(itemId: string) {
    setSelectedIds(prev => {
      const set = new Set(prev ?? []);
      if (set.has(itemId)) set.delete(itemId);
      else set.add(itemId);
      return [...set];
    });
  }

  const lineItems       = billedApiItems.map(li => ({
    description: li.description,
    qty: li.quantity,
    rate: li.unitPriceCents / 100,
  }));
  const visItems = showAllItems ? lineItems : lineItems.slice(0, 3);
  const total           = (hasSelectable ? previewTotalCents : apiView.totalCents) / 100;
  const isExpired       = apiView.isExpired;
  const isAlreadyDeclined = apiView.status === 'rejected';
  // Days until the quote's price is no longer guaranteed. Drives the
  // validity urgency banner (Hennessy). Null when the quote carries no
  // validUntil — we say nothing rather than imply a deadline.
  const validUntilDays  = daysUntil(apiView.validUntil);

  if (accepted) return (
    <SuccessScreen
      customer={customerName}
      estimateNumber={estimateNumber}
      description={description}
      address={customerAddress}
      total={total}
    />
  );

  return (
    <>
      <div className="min-h-screen bg-slate-50">
        {revised && (
          <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 text-center">
            <p className="text-sm text-amber-800 max-w-lg mx-auto">
              This estimate was updated by the business. The latest pricing is shown below — please review before accepting.
            </p>
          </div>
        )}
        {/* Branded header */}
        <div className="bg-white border-b border-slate-200 px-5 py-4">
          <div className="max-w-lg mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
                <span className="text-white" style={{ fontSize: 13 }}>{businessName.charAt(0).toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm text-slate-800">{businessName}</p>
                {businessPhone && <p className="text-xs text-slate-400">{businessPhone}</p>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {businessPhone && (
                <a href={`tel:${businessPhone.replace(/\D/g, '')}`} className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors">
                  <Phone size={14} className="text-slate-600" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-lg mx-auto px-5 py-6 pb-32">
          {/* Estimate badge */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-500 uppercase tracking-widest">Estimate</span>
            <span className="text-xs text-slate-500">{estimateNumber}</span>
          </div>

          {/* Customer */}
          <h1 className="text-slate-900 mb-0.5" style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>
            Hi, {customerName.split(' ')[0]}!
          </h1>
          {customerAddress && (
            <p className="text-sm text-slate-500 mb-5">
              {customerAddress}
            </p>
          )}

          {isExpired && (
            <div className="mb-5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="text-sm text-amber-900">This estimate has expired.</p>
              <p className="text-xs text-amber-700 mt-0.5">Please contact the business for an updated quote.</p>
            </div>
          )}

          {/* Hennessy — payment-link UX. Tell the customer, up front, how
              long this price is held so the deadline drives action instead
              of surprising them at accept-time. Only while the quote is
              still live and actionable; escalates from neutral to amber as
              the window closes. */}
          {!isExpired && !isAlreadyDeclined && apiView.isActionable !== false && validUntilDays !== null && (
            <div
              data-testid="estimate-validity-banner"
              className={`mb-5 flex items-center gap-2.5 rounded-xl border px-4 py-3 ${
                validUntilDays <= 3
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <Clock size={15} className={validUntilDays <= 3 ? 'text-amber-500 shrink-0' : 'text-slate-400 shrink-0'} />
              <p className="text-sm">
                {validUntilDays <= 0
                  ? 'This price expires today.'
                  : validUntilDays === 1
                  ? 'This price is held until tomorrow — 1 day left.'
                  : validUntilDays <= 14
                  ? `This price is held until ${fmtFriendlyDate(apiView.validUntil)} — ${validUntilDays} days left.`
                  : `This price is held until ${fmtFriendlyDate(apiView.validUntil)}.`}
              </p>
            </div>
          )}
          {isAlreadyDeclined && (
            <div className="mb-5 rounded-xl bg-slate-100 border border-slate-200 px-4 py-3">
              <p className="text-sm text-slate-800">You declined this estimate.</p>
              {apiView?.rejectedReason && <p className="text-xs text-slate-500 mt-0.5">{apiView.rejectedReason}</p>}
            </div>
          )}

          {/* Service description */}
          <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 mb-4">
            <p className="text-xs text-slate-400 mb-1">Service</p>
            <p className="text-sm text-slate-800">{description}</p>
            {validUntilText && (
              <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-400 inline-block" />
                Valid until {validUntilText}
              </p>
            )}
          </div>

          {/* Good-better-best: tier groups + optional add-ons. Shown only
              when the estimate has selectable items. Drives the preview
              total above; the server recomputes on approve. */}
          {hasSelectable && (
            <div className="mb-4 flex flex-col gap-4">
              {[...tierGroups.entries()].map(([groupKey, group]) => (
                <div key={groupKey} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100">
                    <p className="text-xs text-slate-500">{group.label} · choose one</p>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {group.items.map(item => {
                      const isSel = chosen.has(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => selectTier(groupKey, item.id)}
                          className={`flex min-h-11 w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors ${isSel ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${isSel ? 'border-blue-600 bg-blue-600' : 'border-slate-300'}`}>
                              {isSel && <span className="size-1.5 rounded-full bg-white" />}
                            </span>
                            <span className="text-sm text-slate-800 truncate">{item.description}</span>
                          </span>
                          <span className="text-sm text-slate-900 shrink-0">${(item.totalCents / 100).toLocaleString()}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {addOns.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100">
                    <p className="text-xs text-slate-500">Optional add-ons</p>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {addOns.map(item => {
                      const isSel = chosen.has(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleAddOn(item.id)}
                          className={`flex min-h-11 w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors ${isSel ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${isSel ? 'border-blue-600 bg-blue-600' : 'border-slate-300'}`}>
                              {isSel && <Check size={11} className="text-white" />}
                            </span>
                            <span className="text-sm text-slate-800 truncate">{item.description}</span>
                          </span>
                          <span className="text-sm text-slate-900 shrink-0">+${(item.totalCents / 100).toLocaleString()}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Line items */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-4">
            {/* minmax(0,1fr) lets the description track shrink below its
                content width (grid items default to min-width:auto, which
                forced horizontal overflow on ≤390px phones). Narrower fixed
                columns below the sm breakpoint; tabular-nums keeps money
                digits stable and right-aligned. */}
            <div className="grid grid-cols-[minmax(0,1fr)_2rem_4rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_40px_72px_72px] gap-x-2 px-5 py-2.5 bg-slate-50 border-b border-slate-100">
              <p className="text-xs text-slate-400">Item</p>
              <p className="text-xs text-slate-400 text-right">Qty</p>
              <p className="text-xs text-slate-400 text-right">Rate</p>
              <p className="text-xs text-slate-400 text-right">Total</p>
            </div>
            <div className="divide-y divide-slate-50">
              {visItems.map((item, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_2rem_4rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_40px_72px_72px] gap-x-2 px-5 py-3 items-start">
                  <p className="text-sm text-slate-800 min-w-0 break-words">{item.description}</p>
                  <p className="text-sm text-slate-500 text-right tabular-nums">{item.qty}</p>
                  <p className="text-sm text-slate-500 text-right tabular-nums">${fmtUsd(item.rate)}</p>
                  <p className="text-sm text-slate-800 text-right tabular-nums">${fmtUsd(item.qty * item.rate)}</p>
                </div>
              ))}
            </div>
            {lineItems.length > 3 && (
              <button
                onClick={() => setAll(v => !v)}
                className="flex min-h-11 items-center justify-center gap-1 w-full py-2.5 text-xs text-slate-400 hover:text-slate-600 border-t border-slate-100 transition-colors"
              >
                {showAllItems ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> {lineItems.length - 3} more items</>}
              </button>
            )}
            <div className="flex items-center justify-between px-5 py-4 bg-slate-900 rounded-b-2xl">
              <p className="text-sm text-slate-300">Estimate total</p>
              <p className="text-white" style={{ fontSize: '1.15rem' }}>${fmtUsd(total)}</p>
            </div>
          </div>

          <button
            onClick={() => printEstimateDocument({
              estimateNumber,
              customerName,
              businessName,
              businessContact: businessPhone,
              description,
              validUntil: validUntilText,
              lineItems: lineItems.map((i) => ({ description: i.description, qty: i.qty, rate: i.rate })),
              totalDollars: total,
            })}
            className="mb-4 flex min-h-11 items-center justify-center gap-1.5 w-full rounded-xl border border-slate-200 bg-white py-2.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors"
          >
            <Download size={12} /> Download PDF
          </button>

          {/* Deposit notice — Tier 4 (Deposit rules — PR 3a). When the
              tenant has a deposit rule and the estimate qualifies, the
              backend writes depositRequiredCents onto the linked job;
              the public view surfaces it. PR 3b adds the actual
              Stripe payment-link CTA. */}
          {apiView && (apiView.depositRequiredCents ?? 0) > 0 && (
            <div
              data-testid="estimate-deposit-notice"
              className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
            >
              <p className="text-sm text-amber-900">
                Deposit required to confirm:{' '}
                <span className="font-medium">
                  ${((apiView.depositRequiredCents ?? 0) / 100).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                {apiView.depositStatus === 'paid' && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs">
                    Paid
                  </span>
                )}
              </p>
              <p className="text-xs text-amber-800 mt-1">
                {apiView.depositStatus === 'paid'
                  ? 'Thanks — your deposit is on file. We\'ll be in touch to schedule the work.'
                  : apiView.depositTimingPolicy === 'before_approval'
                  ? 'Please pay the deposit to unlock the Approve button below.'
                  : 'You\'ll be prompted to pay the deposit after approving this estimate.'}
              </p>
            </div>
          )}

          {/* Notes */}
          <p className="text-xs text-slate-400 text-center px-4 mb-6 leading-relaxed">
            {validUntilText
              ? `This estimate is valid until ${validUntilText}. `
              : ''}
            Prices may change if site conditions differ from what was quoted. Contact us with any questions.
          </p>
        </div>

        {/* Fixed CTA */}
        {(() => {
          if (isExpired || isAlreadyDeclined) return null;

          // Tier 4 (Deposit rules — PR 3b). When the tenant policy is
          // 'before_approval' and the deposit is still pending, swap
          // the Accept CTA for a Pay deposit CTA. The backend's
          // approve() also enforces this gate, so this is a UI guard
          // that prevents the customer from getting a 409 mid-flow.
          const blockedByDeposit =
            apiView?.depositTimingPolicy === 'before_approval' &&
            (apiView?.depositRequiredCents ?? 0) > 0 &&
            apiView?.depositStatus !== 'paid';

          if (blockedByDeposit && id) {
            return (
              <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 pb-safe pt-3">
                <div className="max-w-lg mx-auto">
                  <PayDepositButton
                    token={id}
                    initialUrl={apiView?.depositCheckoutUrl}
                    expiresAt={apiView?.depositCheckoutExpiresAt}
                  />
                  {id && (
                    <DeclineButton
                      token={id}
                      onDeclined={(view) => setApiView(view)}
                    />
                  )}
                  <p className="text-center text-xs text-slate-400 mt-2 pb-1">
                    No account needed · {businessName}
                  </p>
                </div>
              </div>
            );
          }

          if (apiView?.isActionable === false) return null;

          return (
            <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 pb-safe pt-3">
              <div className="max-w-lg mx-auto">
                <button
                  onClick={() => setAppr(true)}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl bg-slate-900 text-white py-4 text-sm hover:bg-slate-700 active:scale-[0.98] transition-all shadow-xl shadow-slate-900/20"
                >
                  <Check size={16} /> Accept this estimate
                </button>
                {id && (
                  <DeclineButton
                    token={id}
                    onDeclined={(view) => setApiView(view)}
                  />
                )}
                <p className="text-center text-xs text-slate-400 mt-2 pb-1">
                  No account needed · {businessName}
                </p>
              </div>
            </div>
          );
        })()}
      </div>

      {showApproval && (
        <ApprovalSheet
          estimateNumber={estimateNumber}
          customer={customerName}
          total={total}
          token={id}
          expectedVersion={apiView?.version}
          selectedLineItemIds={hasSelectable ? (selectedIds ?? []) : undefined}
          onStale={() => { setRevised(true); setAppr(false); }}
          onClose={() => setAppr(false)}
          onConfirm={(view) => {
            if (view) setApiView(view);
            setAppr(false);
            setAccept(true);
          }}
        />
      )}
    </>
  );
}

// ─── Decline button ────────────────────────────────────────────────────────
// Tier 4 (Deposit rules — PR 3b). Pay-deposit CTA shown when the
// tenant policy is 'before_approval'. On click, mints (or reuses) a
// Stripe Payment Link via POST /public/estimates/:token/deposit-checkout
// and redirects the customer there. After payment Stripe redirects
// back to the page and the webhook will have credited the deposit so
// the page swaps in the regular Accept CTA on next load.
function PayDepositButton({ token, initialUrl, expiresAt }: {
  token: string;
  initialUrl?: string;
  /** ISO deadline after which this checkout link is re-minted server-side. */
  expiresAt?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const depositDays = daysUntil(expiresAt);

  async function go() {
    setSubmitting(true);
    setError(null);
    try {
      // Reuse a previously-minted link to avoid an unnecessary Stripe
      // round-trip on a returning customer.
      if (initialUrl) {
        window.location.assign(initialUrl);
        return;
      }
      const res = await apiFetch(
        `/public/estimates/${encodeURIComponent(token)}/deposit-checkout`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url: string };
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        data-testid="estimate-pay-deposit-cta"
        onClick={go}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-2xl bg-amber-500 text-white py-4 text-sm hover:bg-amber-600 disabled:opacity-60 active:scale-[0.98] transition-all shadow-xl shadow-amber-500/20"
      >
        {submitting ? 'Redirecting…' : 'Pay deposit to continue'}
      </button>
      {error && (
        <p className="text-center text-xs text-red-600 mt-2" role="alert">
          {error}
        </p>
      )}
      {!error && expiresAt && depositDays !== null && depositDays > 0 && (
        <p className="text-center text-xs text-slate-400 mt-2">
          {depositDays === 1
            ? 'Pay by tomorrow to hold your spot'
            : `Pay by ${fmtFriendlyDate(expiresAt)} to hold your spot`}
        </p>
      )}
    </>
  );
}

function DeclineButton({ token, onDeclined }: {
  token: string;
  onDeclined: (view: PublicEstimateView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/public/estimates/${encodeURIComponent(token)}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const view = await res.json() as PublicEstimateView;
      onDeclined(view);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decline failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="block mx-auto mt-2 text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
      >
        Decline this estimate
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
      <p className="text-xs text-slate-600 mb-2">Decline this estimate? You can include a brief reason (optional).</p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="e.g. Going with another quote"
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-slate-400 bg-white resize-none"
      />
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => setConfirming(false)}
          disabled={submitting}
          className="flex-1 rounded-lg border border-slate-200 bg-white py-2 text-xs text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting}
          className="flex-1 rounded-lg bg-slate-700 text-white py-2 text-xs hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? 'Declining…' : 'Confirm decline'}
        </button>
      </div>
    </div>
  );
}