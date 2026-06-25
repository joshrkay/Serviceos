import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router';
import {
  Check, Phone, Mail, ChevronDown, ChevronUp, CheckCircle2, X,
  MapPin, FileText, Calendar, Clock, User, Download,
} from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { printEstimateDocument } from '../../lib/estimatePdf';
import { Input, Textarea, Field } from '../ui';
import { NEUTRAL_FIELD } from './portalNeutral';

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
  /** Tenant's document word (Quote/Bid/Estimate). Defaults to 'Estimate'. */
  estimateLabel?: string;
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
   * Whether the customer can pay the deposit now (required + unpaid on a
   * live estimate), policy-agnostic. Drives the Pay-deposit CTA — including
   * the after_approval case where the deposit is owed after acceptance.
   */
  depositPayable?: boolean;
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
    <div className="relative rounded-xl border-2 border-dashed border-border bg-card overflow-hidden" style={{ height: 96 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onMouseDown={onStart} onMouseMove={onMove} onMouseUp={onEnd} onMouseLeave={onEnd}
        onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}
      />
      {!hasSig && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
          Draw your signature here
        </p>
      )}
      {hasSig && (
        <button
          onClick={clear}
          className="absolute top-2 right-2 flex items-center gap-1 bg-card border border-border rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground shadow-sm"
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
        className="bg-card rounded-t-3xl shadow-2xl overflow-y-auto max-h-[92vh]"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'sheetUp 0.3s cubic-bezier(0.32,0.72,0,1)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        <div className="px-6 pb-8 pt-2">
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div>
              <p className="text-sm text-muted-foreground mb-0.5">Accepting</p>
              <h2 className="text-foreground" style={{ fontSize: '1.15rem' }}>{estimateNumber}</h2>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-0.5">Total</p>
              <p className="text-foreground" style={{ fontSize: '1.3rem' }}>${fmtUsd(total)}</p>
            </div>
          </div>

          {/* Legal note */}
          <p className="text-xs text-muted-foreground leading-relaxed bg-muted rounded-xl px-4 py-3 mb-5">
            By accepting this estimate you're agreeing to the scope and pricing above. Work will be scheduled after acceptance.
          </p>

          {/* Name */}
          <div className="mb-4">
            <Field label="Full name">
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your full name"
                className={NEUTRAL_FIELD}
              />
            </Field>
          </div>

          {/* Signature */}
          <div className="mb-6">
            <label className="block text-xs text-muted-foreground mb-1.5">Signature</label>
            <SignatureCanvas onChange={setHasSig} canvasRef={sigRef} />
          </div>

          {error && (
            <p className="text-xs text-destructive mb-3 bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
          )}

          {/* Date */}
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-6">
            <span>Accepted on</span>
            <span>March 10, 2026</span>
          </div>

          {/* Button */}
          <button
            onClick={submit}
            disabled={!name.trim() || !hasSig || loading}
            className={`w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm transition-all ${
              !name.trim() || !hasSig
                ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                : loading
                ? 'bg-success text-white'
                : 'bg-foreground text-white hover:bg-foreground/80 active:scale-[0.98]'
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
  token, depositPayable, depositDueCents = 0, depositPaid = false,
  depositCheckoutUrl, depositCheckoutExpiresAt,
}: {
  customer: string;
  estimateNumber: string;
  description: string;
  address: string;
  total: number;
  /** Token + deposit context so an after_approval deposit can be paid here. */
  token?: string;
  depositPayable?: boolean;
  depositDueCents?: number;
  depositPaid?: boolean;
  depositCheckoutUrl?: string;
  depositCheckoutExpiresAt?: string;
}) {
  // Mock auto-created job number
  const jobNumber = 'JOB-1053';
  const firstName = customer.split(' ')[0];

  return (
    <div className="min-h-screen bg-muted">
      {/* Branded header */}
      <div className="bg-card border-b border-border px-5 py-4">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-xl bg-foreground">
              <span className="text-white" style={{ fontSize: 13 }}>F</span>
            </div>
            <div>
              <p className="text-sm text-foreground">Fieldly Pro Services</p>
              <p className="text-xs text-muted-foreground">Austin, TX</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="tel:5125550000" className="flex size-8 items-center justify-center rounded-full bg-secondary hover:bg-border transition-colors">
              <Phone size={14} className="text-foreground" />
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-5 py-8 pb-16">

        {/* Hero confirmation */}
        <div className="flex flex-col items-center text-center gap-4 mb-8"
          style={{ animation: 'popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <div className="flex size-20 items-center justify-center rounded-full bg-success shadow-xl shadow-success/20">
            <CheckCircle2 size={40} className="text-white" />
          </div>
          <div>
            <h1 className="text-foreground" style={{ fontSize: '1.6rem', lineHeight: 1.2 }}>
              Estimate accepted!
            </h1>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Thanks, {firstName}! Your job has been created and our team will be in touch shortly to confirm your appointment.
            </p>
          </div>
        </div>

        {/* Deposit prompt — Tier 4 (after_approval). The estimate is
            accepted; if a deposit is still owed, this is the "you'll be
            prompted to pay after approving" step. Pays via the same Stripe
            link as before_approval; the settlement poll swaps this for the
            paid confirmation once the webhook credits it. */}
        {depositPayable && token && (
          <div
            data-testid="success-deposit-prompt"
            className="rounded-2xl border border-warning/20 bg-warning/10 px-5 py-4 mb-4"
            style={{ animation: 'fadeUp 0.4s ease 0.25s both' }}
          >
            <p className="text-sm text-warning">
              {depositDueCents > 0
                ? `Pay your $${fmtUsd(depositDueCents / 100)} deposit to confirm scheduling`
                : 'Pay your deposit to confirm scheduling'}
            </p>
            <p className="text-xs text-warning mt-1 mb-3">
              We&apos;ll hold your spot as soon as the deposit is received.
            </p>
            <PayDepositButton
              token={token}
              initialUrl={depositCheckoutUrl}
              expiresAt={depositCheckoutExpiresAt}
            />
          </div>
        )}
        {depositPaid && (
          <div
            data-testid="success-deposit-paid"
            className="rounded-2xl border border-success/20 bg-success/10 px-5 py-3 mb-4 flex items-center gap-2"
          >
            <CheckCircle2 size={16} className="text-success shrink-0" />
            <p className="text-sm text-success">Deposit paid — thank you!</p>
          </div>
        )}

        {/* Job card */}
        <div className="rounded-2xl border border-border overflow-hidden bg-card mb-4"
          style={{ animation: 'fadeUp 0.4s ease 0.2s both' }}>
          {/* Dark header */}
          <div className="bg-foreground px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-lg bg-card/10 flex items-center justify-center">
                  <span className="text-white" style={{ fontSize: 11 }}>F</span>
                </div>
                <p className="text-sm text-white">Fieldly Pro Services</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-success animate-pulse" />
                <span className="text-xs text-success">Job created</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-1">{description}</p>
            <p className="text-white" style={{ fontSize: '1.5rem', lineHeight: 1 }}>
              ${fmtUsd(total)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{jobNumber}</p>
          </div>

          {/* Detail rows */}
          <div className="divide-y divide-border">
            <div className="flex items-start gap-3 px-5 py-3.5">
              <User size={14} className="text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">Customer</p>
                <p className="text-sm text-foreground">{customer}</p>
              </div>
            </div>

            <div className="flex items-start gap-3 px-5 py-3.5">
              <MapPin size={14} className="text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">Service address</p>
                <p className="text-sm text-foreground">{address}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 px-5 py-3.5">
              <Check size={14} className="text-success shrink-0" />
              <div className="flex-1">
                <p className="text-xs text-muted-foreground mb-0.5">Accepted</p>
                <p className="text-sm text-foreground">March 10, 2026 · Estimate approved</p>
              </div>
            </div>

            <div className="flex items-center gap-3 px-5 py-3.5">
              <FileText size={14} className="text-muted-foreground shrink-0" />
              <div className="flex-1">
                <p className="text-xs text-muted-foreground mb-0.5">From estimate</p>
                <p className="text-sm text-muted-foreground">{estimateNumber}</p>
              </div>
            </div>
          </div>
        </div>

        {/* What happens next */}
        <div className="rounded-2xl bg-card border border-border px-5 py-4 mb-4"
          style={{ animation: 'fadeUp 0.4s ease 0.35s both' }}>
          <p className="text-sm text-foreground mb-4">What happens next</p>
          <div className="flex flex-col gap-4">
            {[
              {
                step: 1,
                icon: Calendar,
                title: 'We schedule your job',
                desc: 'Our team will call or text you within 1 business day to confirm a date and time that works.',
                color: 'bg-secondary text-foreground',
              },
              {
                step: 2,
                icon: Clock,
                title: 'Day-before reminder',
                desc: 'We\'ll send you a reminder the evening before your appointment with your tech\'s name and arrival window.',
                color: 'bg-secondary text-foreground',
              },
              {
                step: 3,
                icon: CheckCircle2,
                title: 'Work done, invoice follows',
                desc: 'After the job is complete you\'ll receive a final invoice reflecting any on-site adjustments.',
                color: 'bg-success/15 text-success',
              },
            ].map(({ step, icon: Icon, title, desc, color }) => (
              <div key={step} className="flex items-start gap-3.5">
                <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${color}`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-sm text-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Contact footer */}
        <div className="flex flex-col items-center gap-3 text-center"
          style={{ animation: 'fadeUp 0.4s ease 0.5s both' }}>
          <p className="text-xs text-muted-foreground">
            Questions? Reach us any time.
          </p>
          <div className="flex items-center gap-3">
            <a href="tel:5125550000"
              className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-foreground/30 hover:bg-muted transition-colors">
              <Phone size={13} className="text-muted-foreground" /> (512) 555-0000
            </a>
            <a href="mailto:info@fieldly.pro"
              className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-foreground/30 hover:bg-muted transition-colors">
              <Mail size={13} className="text-muted-foreground" /> Email us
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

  // Load the estimate from the real public API. There is deliberately NO
  // mock/fixture fallback on this public URL — see the error branch below.
  const [apiView, setApiView] = useState<PublicEstimateView | null>(null);
  const [apiLoading, setApiLoading] = useState(true);
  const [apiNotFound, setApiNotFound] = useState(false);
  // Set when the estimate could not be loaded for a reason other than 404
  // (network error or non-OK response). We render a safe error screen
  // rather than fixture data — this is a public URL.
  const [apiError, setApiError] = useState(false);
  // Set when a background poll detects the business revised the estimate
  // (version bumped) after the customer opened the page. The banner asks
  // them to review the latest version; approve is also blocked server-side.
  const [revised, setRevised] = useState(false);
  // Good-better-best: the line-item ids the customer has chosen. Null
  // until the estimate loads, then seeded from the server's defaults.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  // Bumped by the error screen's "Try again" button to re-run the fetch.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!id) {
      setApiLoading(false);
      return;
    }
    setApiLoading(true);
    setApiError(false);
    setApiNotFound(false);
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
  }, [id, retryCount]);

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

  // Deposit-settlement poll: when a deposit is payable (notably the
  // after_approval case, where the estimate is already accepted so the
  // revision poll above bails), the customer pays on Stripe and returns;
  // the webhook credits the deposit a beat later. Poll until it settles so
  // the page swaps the Pay-deposit prompt for the paid state without a
  // manual refresh. Stops as soon as the deposit is no longer payable.
  const depositPayable = apiView?.depositPayable ?? false;
  useEffect(() => {
    if (!id || !depositPayable) return;
    let cancelled = false;
    const POLL_MS = 5_000;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/public/estimates/${encodeURIComponent(id)}`);
        if (cancelled || !res.ok) return;
        const next = await res.json() as PublicEstimateView;
        if (!cancelled) setApiView(next);
      } catch {
        // Transient network error — keep polling.
      }
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, depositPayable, apiView]);

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
      <div className="min-h-screen bg-muted flex items-center justify-center">
        <div className="size-8 rounded-full border-2 border-border border-t-foreground animate-spin" />
      </div>
    );
  }

  // No real estimate data to show. We deliberately do NOT fall back to
  // fixture/mock data: this page is served on a public URL, so rendering a
  // mock estimate would expose another customer's name, address, and
  // pricing. Show a safe message instead (404 vs transient error).
  if (!apiView) {
    const heading = apiNotFound ? 'Link not found' : 'Couldn’t load this estimate';
    const detail = apiNotFound
      ? 'This estimate link is invalid or has been revoked. Please contact the business that sent it.'
      : 'We couldn’t load this estimate — check the link or contact the business that sent it.';
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-foreground mb-2" style={{ fontSize: '1.4rem' }}>{heading}</h1>
          <p className="text-sm text-muted-foreground">{detail}</p>
          {apiError && (
            <button
              onClick={() => setRetryCount(c => c + 1)}
              className="mt-5 inline-flex items-center justify-center rounded-2xl bg-foreground text-white px-6 py-3 text-sm hover:bg-foreground/80 active:scale-[0.98] transition-all"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // apiView is guaranteed non-null past this point — every field derives
  // from the real public API, never from fixtures.
  const estimateNumber  = apiView.estimateNumber;
  const businessName    = apiView.businessName;
  const estimateLabel   = apiView.estimateLabel?.trim() || 'Estimate';
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
      token={id}
      depositPayable={apiView.depositPayable}
      depositDueCents={Math.max(
        0,
        (apiView.depositRequiredCents ?? 0) - (apiView.depositPaidCents ?? 0),
      )}
      depositPaid={
        (apiView.depositRequiredCents ?? 0) > 0 && apiView.depositStatus === 'paid'
      }
      depositCheckoutUrl={apiView.depositCheckoutUrl}
      depositCheckoutExpiresAt={apiView.depositCheckoutExpiresAt}
    />
  );

  return (
    <>
      <div className="min-h-screen bg-muted">
        {revised && (
          <div className="bg-warning/10 border-b border-warning/20 px-5 py-3 text-center">
            <p className="text-sm text-warning max-w-lg mx-auto">
              This estimate was updated by the business. The latest pricing is shown below — please review before accepting.
            </p>
          </div>
        )}
        {/* Branded header */}
        <div className="bg-card border-b border-border px-5 py-4">
          <div className="max-w-lg mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-xl bg-foreground">
                <span className="text-white" style={{ fontSize: 13 }}>{businessName.charAt(0).toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm text-foreground">{businessName}</p>
                {businessPhone && <p className="text-xs text-muted-foreground">{businessPhone}</p>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {businessPhone && (
                <a href={`tel:${businessPhone.replace(/\D/g, '')}`} className="flex size-8 items-center justify-center rounded-full bg-secondary hover:bg-border transition-colors">
                  <Phone size={14} className="text-foreground" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-lg mx-auto px-5 py-6 pb-32">
          {/* Estimate badge */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground uppercase tracking-widest">{estimateLabel}</span>
            <span className="text-xs text-muted-foreground">{estimateNumber}</span>
          </div>

          {/* Customer */}
          <h1 className="text-foreground mb-0.5" style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>
            Hi, {customerName.split(' ')[0]}!
          </h1>
          {customerAddress && (
            <p className="text-sm text-muted-foreground mb-5">
              {customerAddress}
            </p>
          )}

          {isExpired && (
            <div className="mb-5 rounded-xl bg-warning/10 border border-warning/20 px-4 py-3">
              <p className="text-sm text-warning">This estimate has expired.</p>
              <p className="text-xs text-warning mt-0.5">Please contact the business for an updated quote.</p>
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
                  ? 'bg-warning/10 border-warning/20 text-warning'
                  : 'bg-muted border-border text-foreground'
              }`}
            >
              <Clock size={15} className={validUntilDays <= 3 ? 'text-warning shrink-0' : 'text-muted-foreground shrink-0'} />
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
            <div className="mb-5 rounded-xl bg-secondary border border-border px-4 py-3">
              <p className="text-sm text-foreground">You declined this estimate.</p>
              {apiView?.rejectedReason && <p className="text-xs text-muted-foreground mt-0.5">{apiView.rejectedReason}</p>}
            </div>
          )}

          {/* Service description */}
          <div className="bg-card rounded-2xl border border-border px-5 py-4 mb-4">
            <p className="text-xs text-muted-foreground mb-1">Service</p>
            <p className="text-sm text-foreground">{description}</p>
            {validUntilText && (
              <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-warning inline-block" />
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
                <div key={groupKey} className="bg-card rounded-2xl border border-border overflow-hidden">
                  <div className="px-5 py-2.5 bg-muted border-b border-border">
                    <p className="text-xs text-muted-foreground">{group.label} · choose one</p>
                  </div>
                  <div className="divide-y divide-border">
                    {group.items.map(item => {
                      const isSel = chosen.has(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => selectTier(groupKey, item.id)}
                          className={`flex min-h-11 w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors ${isSel ? 'bg-secondary' : 'hover:bg-muted'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${isSel ? 'border-foreground bg-foreground' : 'border-border'}`}>
                              {isSel && <span className="size-1.5 rounded-full bg-card" />}
                            </span>
                            <span className="text-sm text-foreground truncate">{item.description}</span>
                          </span>
                          <span className="text-sm text-foreground shrink-0">${fmtUsd(item.totalCents / 100)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {addOns.length > 0 && (
                <div className="bg-card rounded-2xl border border-border overflow-hidden">
                  <div className="px-5 py-2.5 bg-muted border-b border-border">
                    <p className="text-xs text-muted-foreground">Optional add-ons</p>
                  </div>
                  <div className="divide-y divide-border">
                    {addOns.map(item => {
                      const isSel = chosen.has(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleAddOn(item.id)}
                          className={`flex min-h-11 w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors ${isSel ? 'bg-secondary' : 'hover:bg-muted'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${isSel ? 'border-foreground bg-foreground' : 'border-border'}`}>
                              {isSel && <Check size={11} className="text-white" />}
                            </span>
                            <span className="text-sm text-foreground truncate">{item.description}</span>
                          </span>
                          <span className="text-sm text-foreground shrink-0">+${fmtUsd(item.totalCents / 100)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Line items */}
          <div className="bg-card rounded-2xl border border-border overflow-hidden mb-4">
            {/* minmax(0,1fr) lets the description track shrink below its
                content width (grid items default to min-width:auto, which
                forced horizontal overflow on ≤390px phones). Narrower fixed
                columns below the sm breakpoint; tabular-nums keeps money
                digits stable and right-aligned. */}
            <div className="grid grid-cols-[minmax(0,1fr)_2rem_4rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_40px_72px_72px] gap-x-2 px-5 py-2.5 bg-muted border-b border-border">
              <p className="text-xs text-muted-foreground">Item</p>
              <p className="text-xs text-muted-foreground text-right">Qty</p>
              <p className="text-xs text-muted-foreground text-right">Rate</p>
              <p className="text-xs text-muted-foreground text-right">Total</p>
            </div>
            <div className="divide-y divide-border">
              {visItems.map((item, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_2rem_4rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_40px_72px_72px] gap-x-2 px-5 py-3 items-start">
                  <p className="text-sm text-foreground min-w-0 break-words">{item.description}</p>
                  <p className="text-sm text-muted-foreground text-right tabular-nums">{item.qty}</p>
                  <p className="text-sm text-muted-foreground text-right tabular-nums">${fmtUsd(item.rate)}</p>
                  <p className="text-sm text-foreground text-right tabular-nums">${fmtUsd(item.qty * item.rate)}</p>
                </div>
              ))}
            </div>
            {lineItems.length > 3 && (
              <button
                onClick={() => setAll(v => !v)}
                className="flex min-h-11 items-center justify-center gap-1 w-full py-2.5 text-xs text-muted-foreground hover:text-foreground border-t border-border transition-colors"
              >
                {showAllItems ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> {lineItems.length - 3} more items</>}
              </button>
            )}
            <div className="flex items-center justify-between px-5 py-4 bg-foreground rounded-b-2xl">
              <p className="text-sm text-muted-foreground">Estimate total</p>
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
            className="mb-4 flex min-h-11 items-center justify-center gap-1.5 w-full rounded-xl border border-border bg-card py-2.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
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
              className="mb-4 rounded-2xl border border-warning/20 bg-warning/10 px-4 py-3"
            >
              <p className="text-sm text-warning">
                Deposit required to confirm:{' '}
                <span className="font-medium">
                  ${((apiView.depositRequiredCents ?? 0) / 100).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                {apiView.depositStatus === 'paid' && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-success/15 text-success px-2 py-0.5 text-xs">
                    Paid
                  </span>
                )}
              </p>
              <p className="text-xs text-warning mt-1">
                {apiView.depositStatus === 'paid'
                  ? 'Thanks — your deposit is on file. We\'ll be in touch to schedule the work.'
                  : apiView.depositTimingPolicy === 'before_approval'
                  ? 'Please pay the deposit to unlock the Approve button below.'
                  : 'You\'ll be prompted to pay the deposit after approving this estimate.'}
              </p>
            </div>
          )}

          {/* Notes */}
          <p className="text-xs text-muted-foreground text-center px-4 mb-6 leading-relaxed">
            {validUntilText
              ? `This estimate is valid until ${validUntilText}. `
              : ''}
            Prices may change if site conditions differ from what was quoted. Contact us with any questions.
          </p>
        </div>

        {/* Fixed CTA */}
        {(() => {
          if (isExpired || isAlreadyDeclined) return null;

          // Tier 4 (Deposit rules). Show the Pay-deposit CTA whenever the
          // deposit is payable (policy-agnostic, computed server-side). For
          // before_approval this is the sent+pending estimate — the Accept
          // CTA stays hidden until the deposit is paid (the backend's
          // approve() enforces the same gate). The after_approval accepted
          // case is handled on the success screen, not here.
          if (apiView?.depositPayable && id) {
            return (
              <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border px-5 pb-safe pt-3">
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
                  <p className="text-center text-xs text-muted-foreground mt-2 pb-1">
                    No account needed · {businessName}
                  </p>
                </div>
              </div>
            );
          }

          if (apiView?.isActionable === false) return null;

          return (
            <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border px-5 pb-safe pt-3">
              <div className="max-w-lg mx-auto">
                <button
                  onClick={() => setAppr(true)}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl bg-foreground text-white py-4 text-sm hover:bg-foreground/80 active:scale-[0.98] transition-all shadow-xl shadow-foreground/20"
                >
                  <Check size={16} /> Accept this {estimateLabel.toLowerCase()}
                </button>
                {id && (
                  <DeclineButton
                    token={id}
                    onDeclined={(view) => setApiView(view)}
                  />
                )}
                <p className="text-center text-xs text-muted-foreground mt-2 pb-1">
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
        className="w-full flex items-center justify-center gap-2 rounded-2xl bg-warning text-white py-4 text-sm hover:bg-warning/90 disabled:opacity-60 active:scale-[0.98] transition-all shadow-xl shadow-warning/20"
      >
        {submitting ? 'Redirecting…' : 'Pay deposit to continue'}
      </button>
      {error && (
        <p className="text-center text-xs text-destructive mt-2" role="alert">
          {error}
        </p>
      )}
      {!error && expiresAt && depositDays !== null && depositDays > 0 && (
        <p className="text-center text-xs text-muted-foreground mt-2">
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
        className="block mx-auto mt-2 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        Decline this estimate
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-muted border border-border px-3 py-3">
      <p className="text-xs text-foreground mb-2">Decline this estimate? You can include a brief reason (optional).</p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="e.g. Going with another quote"
        className={`${NEUTRAL_FIELD} resize-none`}
      />
      {error && <p className="text-xs text-destructive mt-2">{error}</p>}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => setConfirming(false)}
          disabled={submitting}
          className="flex-1 rounded-lg border border-border bg-card py-2 text-xs text-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting}
          className="flex-1 rounded-lg bg-foreground text-white py-2 text-xs hover:bg-foreground/90 disabled:opacity-60"
        >
          {submitting ? 'Declining…' : 'Confirm decline'}
        </button>
      </div>
    </div>
  );
}