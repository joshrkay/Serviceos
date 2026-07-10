import { useState, useEffect, useRef } from 'react';
import {
  X, Check, Send, Receipt, FileText,
  Phone, MessageSquare,
  AlertCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatUsdCentsFixed } from '@ai-service-os/shared';
import type { EstimateResponse, InvoiceResponse } from '@ai-service-os/shared';
import { StatusBadge } from '../shared/StatusBadge';
import { EmptyState, Textarea, Spinner } from '../ui';
import { apiFetch } from '../../utils/api-fetch';
import { normalizeEstimateStatus, normalizeInvoiceStatus } from '../../utils/statusNormalize';

// ─── Sheet Overlay ───────────────────────────────────────────────
export function SheetOverlay({
  children, onClose, maxH = '85vh',
}: { children: React.ReactNode; onClose: () => void; maxH?: string }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-card shadow-2xl overflow-y-auto"
        style={{ maxHeight: maxH, animation: 'slideUp 0.22s cubic-bezier(.32,1,.46,1)' }}
      >
        <div className="sticky top-0 flex justify-center pt-3 pb-1 bg-card">
          <div className="w-9 h-1 rounded-full bg-border" />
        </div>
        <div className="px-5 pb-8 pt-1">{children}</div>
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </>
  );
}

// ─── Call Screen ─────────────────────────────────────────────────
// D1: Wire to real tel: link that opens native dialer and logs comms touch.
export function CallScreen({ name, phone, initials, color, customerId, onEnd }: {
  name: string; phone: string; initials: string; color: string; customerId?: string; onEnd: () => void;
}) {
  const [phase, setPhase] = useState<'confirm' | 'calling'>('confirm');
  const [error, setError] = useState<string | null>(null);

  // D1: No timeline/touch API endpoint exists in the API. The tel: link opens
  // the native dialer; comms logging would require a dedicated route (P-XXX).
  // For now, we skip the logging call — the call itself is the user action.

  function handleCallNow() {
    setPhase('calling');
    // Use tel: to open native dialer
    window.location.href = `tel:${phone.replace(/\D/g, '')}`;
    // Auto-close after a short delay (user is now in phone app)
    setTimeout(onEnd, 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between py-16 px-6"
      style={{ background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 60%, #0c4a6e 100%)' }}
    >
      <div className="flex flex-col items-center gap-1">
        <p className="text-muted-foreground text-sm tracking-widest uppercase" style={{ fontSize: 11 }}>
          {phase === 'confirm' ? 'Call customer' : 'Opening dialer…'}
        </p>
      </div>

      <div className="flex flex-col items-center gap-4">
        <div
          className="flex items-center justify-center rounded-full text-primary-foreground shadow-2xl"
          style={{ width: 96, height: 96, background: color, fontSize: 32 }}
        >
          {initials}
        </div>
        <div className="text-center">
          <p className="text-primary-foreground" style={{ fontSize: '1.4rem' }}>{name}</p>
          <p className="text-muted-foreground text-sm mt-1">{phone}</p>
        </div>
      </div>

      <div className="w-full max-w-xs">
        {error && (
          <div className="flex items-center gap-2 bg-destructive/20 border border-destructive/30 rounded-lg px-3 py-2 mb-4">
            <AlertCircle size={14} className="text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}
        {phase === 'confirm' ? (
          <>
            <button
              onClick={handleCallNow}
              className="flex items-center justify-center gap-2 w-full py-4 rounded-full bg-success text-primary-foreground hover:bg-success/90 transition-colors mb-3"
            >
              <Phone size={22} /><span className="text-sm">Call now</span>
            </button>
            <button
              onClick={onEnd}
              className="flex items-center justify-center gap-2 w-full py-3 rounded-full bg-card/10 text-muted-foreground hover:bg-card/20 transition-colors"
            >
              <span className="text-sm">Cancel</span>
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full bg-primary"
                  style={{ animation: `callPulse 1.2s ease-in-out ${i * 0.3}s infinite` }} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Opening your phone app…</p>
          </div>
        )}
      </div>

      <style>{`@keyframes callPulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }`}</style>
    </div>
  );
}

// ─── Text Sheet ──────────────────────────────────────────────────
// D1: Wire to open comms compose for the customer thread via real API
export function TextSheet({ name, phone, customerId, onClose }: {
  name: string; phone: string; customerId?: string; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const first = name.split(' ')[0];

  const templates = [
    `Hi ${first}, we're on our way! ETA ~15 min.`,
    `Hi ${first}, your job is complete. Invoice on its way.`,
    `Hi ${first}, just confirming your appointment today.`,
  ];

  async function handleSend() {
    if (!message.trim()) return;
    if (!customerId) {
      setError('No customer linked to this job');
      return;
    }

    setError(null);
    setSending(true);

    try {
      // D1: Resolve existing thread via search, create if none exists
      const searchRes = await apiFetch(
        `/api/conversations/search?customerId=${encodeURIComponent(customerId)}`,
        { method: 'GET' },
      );
      if (!searchRes.ok) {
        const json = await searchRes.json().catch(() => ({}));
        throw new Error(json?.message ?? `Failed to search threads: HTTP ${searchRes.status}`);
      }
      const { results } = await searchRes.json();

      let conversationId: string;
      if (results && results.length > 0) {
        // Use the first matching thread (most recent)
        conversationId = results[0].conversationId ?? results[0].id;
      } else {
        // No existing thread — create one via POST /api/conversations
        const createRes = await apiFetch('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({
            entityType: 'customer',
            entityId: customerId,
          }),
        });
        if (!createRes.ok) {
          const json = await createRes.json().catch(() => ({}));
          throw new Error(json?.message ?? `Failed to create thread: HTTP ${createRes.status}`);
        }
        const created = await createRes.json();
        conversationId = created.id;
      }

      // Send the message via the reply endpoint
      const replyRes = await apiFetch(`/api/conversations/${conversationId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: message.trim(), channel: 'sms' }),
      });
      if (!replyRes.ok) {
        const json = await replyRes.json().catch(() => ({}));
        throw new Error(json?.message ?? `Failed to send: HTTP ${replyRes.status}`);
      }

      setSent(true);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  function handleOpenComms() {
    if (!customerId) {
      setError('No customer linked to this job');
      return;
    }
    // Navigate to comms inbox filtered to this customer
    navigate(`/inbox?customerId=${customerId}`);
    onClose();
  }

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-foreground">Text {first}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{phone}</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary"><X size={16} className="text-muted-foreground" /></button>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mb-4">
          <AlertCircle size={14} className="text-destructive shrink-0" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {!sent ? (
        <>
          <div className="flex flex-col gap-2 mb-4">
            {templates.map((t, i) => (
              <button
                key={i}
                onClick={() => { setMessage(t); ref.current?.focus(); }}
                className="text-left rounded-lg border border-border px-3 py-2.5 text-xs text-foreground hover:bg-secondary hover:border-border transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
          <Textarea
            ref={ref}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            placeholder="Type a custom message…"
            className="min-h-11 resize-none mb-3"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!message.trim() || sending}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            <Send size={14} /> {sending ? 'Sending…' : 'Send message'}
          </button>
          <button
            onClick={handleOpenComms}
            className="flex items-center justify-center gap-2 w-full py-2.5 mt-2 rounded-xl border border-border text-foreground text-xs hover:bg-secondary transition-colors"
          >
            <MessageSquare size={12} /> Open full conversation
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-8">
          <span className="flex size-12 items-center justify-center rounded-full bg-success/15">
            <Check size={22} className="text-success" />
          </span>
          <p className="text-sm text-foreground">Message sent to {first}</p>
        </div>
      )}
    </SheetOverlay>
  );
}

// ─── Estimate Sheet ──────────────────────────────────────────────
// Fetches the job's real estimate(s) via GET /api/estimates?jobId=<id>
// (bare-array shape) and renders the most recent one. Empty state links to
// the real estimate create flow.
export function EstimateSheet({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [est, setEst] = useState<EstimateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/estimates?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list: EstimateResponse[] = await res.json();
        if (!cancelled) setEst(Array.isArray(list) && list.length > 0 ? list[0] : null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load estimate');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-foreground">Estimate{est ? ` ${est.estimateNumber}` : ''}</p>
          {est && <p className="text-xs text-muted-foreground mt-0.5">{est.lineItems.length} line item{est.lineItems.length === 1 ? '' : 's'}</p>}
        </div>
        <div className="flex items-center gap-2">
          {est && <StatusBadge status={normalizeEstimateStatus(est.status)} />}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary"><X size={16} className="text-muted-foreground" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner size="md" className="text-foreground" label="Loading estimate" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mb-4">
          <AlertCircle size={14} className="text-destructive shrink-0" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : !est ? (
        <EmptyState
          icon={<FileText size={20} />}
          title="No estimate linked to this job yet."
          actionLabel="Create estimate"
          onAction={() => { onClose(); navigate(`/estimates/new?jobId=${encodeURIComponent(jobId)}`); }}
        />
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden mb-4">
            <div className="divide-y divide-border">
              {est.lineItems.map((item, i) => (
                <div key={item.id ?? i} className="flex items-start justify-between gap-3 px-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{item.description}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Qty: {item.quantity} × {formatUsdCentsFixed(item.unitPriceCents)}</p>
                  </div>
                  <p className="text-sm text-foreground shrink-0">{formatUsdCentsFixed(item.totalCents)}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-between px-3 py-3 bg-secondary border-t border-border">
              <p className="text-sm text-foreground">Total</p>
              <p className="text-sm text-foreground">{formatUsdCentsFixed(est.totals.totalCents)}</p>
            </div>
          </div>
          <button
            onClick={() => { onClose(); navigate(`/estimates/${est.id}`); }}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors mb-2"
          >
            Open full estimate
          </button>
          <button onClick={onClose} className="w-full py-3 rounded-xl border border-border text-sm text-foreground hover:bg-secondary transition-colors">Close</button>
        </>
      )}
    </SheetOverlay>
  );
}

// ─── Invoice Sheet ───────────────────────────────────────────────
// Fetches the job's real invoice(s) via GET /api/invoices?jobId=<id>
// (bare-array shape). "Send invoice now" routes to the real invoice page —
// the sheet never fakes a send. Empty state links to the invoice create flow.
export function InvoiceSheet({ jobId, customerName, customerPhone, onClose }: {
  jobId: string; customerName: string; customerPhone: string; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [inv, setInv] = useState<InvoiceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/invoices?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list: InvoiceResponse[] = await res.json();
        if (!cancelled) setInv(Array.isArray(list) && list.length > 0 ? list[0] : null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoice');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  const status = inv ? normalizeInvoiceStatus(inv.status) : undefined;

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-foreground">Invoice{inv ? ` ${inv.invoiceNumber}` : ''}</p>
          <p className="text-xs text-muted-foreground mt-0.5">To {customerName}</p>
        </div>
        <div className="flex items-center gap-2">
          {status && <StatusBadge status={status} />}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary"><X size={16} className="text-muted-foreground" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner size="md" className="text-foreground" label="Loading invoice" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mb-4">
          <AlertCircle size={14} className="text-destructive shrink-0" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : !inv ? (
        <EmptyState
          icon={<Receipt size={20} />}
          title="No invoice linked to this job yet."
          actionLabel="Create invoice"
          onAction={() => { onClose(); navigate(`/invoices/new?jobId=${encodeURIComponent(jobId)}`); }}
        />
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden mb-4">
            <div className="divide-y divide-border">
              {inv.lineItems.map((item, i) => (
                <div key={item.id ?? i} className="flex items-start justify-between gap-3 px-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{item.description}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Qty: {item.quantity} × {formatUsdCentsFixed(item.unitPriceCents)}</p>
                  </div>
                  <p className="text-sm text-foreground shrink-0">{formatUsdCentsFixed(item.totalCents)}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-between px-3 py-3 bg-secondary border-t border-border">
              <p className="text-sm text-foreground">Total due</p>
              <p className="text-sm text-foreground">{formatUsdCentsFixed(inv.amountDueCents)}</p>
            </div>
          </div>
          {status === 'Paid' ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <span className="flex size-10 items-center justify-center rounded-full bg-success/15">
                <Check size={18} className="text-success" />
              </span>
              <p className="text-sm text-foreground">Invoice already paid</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-2.5 mb-4 flex items-center gap-2">
                <Send size={13} className="text-primary shrink-0" />
                <p className="text-xs text-primary">Send to {customerName.split(' ')[0]} at {customerPhone} from the invoice page</p>
              </div>
              <button
                onClick={() => { onClose(); navigate(`/invoices/${inv.id}`); }}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors"
              >
                <Send size={14} /> Send invoice now
              </button>
            </>
          )}
        </>
      )}
    </SheetOverlay>
  );
}
