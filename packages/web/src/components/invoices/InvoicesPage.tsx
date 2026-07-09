import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Plus, Send, ArrowLeft, DollarSign, CheckCircle, CheckCircle2,
  Clock, AlertCircle, FileText, CreditCard, ChevronRight, X,
  Phone, Mail, Copy, Check, Pencil, Trash2, MessageSquare,
  ExternalLink, Lock, Building2, Smartphone, Briefcase,
} from 'lucide-react';
import type { InvoiceResponse, LineItem as InvoiceLineItem } from '@ai-service-os/shared';
import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { deriveInvoiceUiStatus, centsToDisplay } from '../../utils/statusNormalize';
import { formatCurrencyAmount } from '../../utils/currency';

/** Format dollar amounts (not cents) with fixed two decimal places. */
const formatDollars = (dollars: number): string =>
  formatCurrencyAmount(Math.round(dollars * 100));
import { StatusBadge } from '../shared/StatusBadge';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { apiFetch } from '../../utils/api-fetch';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateInTenantTz, formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';
import { AttachmentSection } from '../attachments/AttachmentSection';

type InvoiceStatus = 'Draft' | 'Sent' | 'Unpaid' | 'Paid' | 'Overdue' | 'Canceled';

interface InvCompat {
  id: string;
  invoiceNumber: string;
  customer: string;
  customerId: string;
  description: string;
  lineItems: LineItem[];
  status: InvoiceStatus;
  dueDate?: string;
  sentDate?: string;
  paidDate?: string;
}

interface ApiLead {
  id: string;
  source: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

/** Convert a shared line item to the UI LineItem shape */
function apiLineToUi(item: InvoiceLineItem): LineItem {
  return {
    id: item.id,
    description: item.description,
    qty: item.quantity,
    rate: item.unitPriceCents / 100,
    taxable: item.taxable,
    // Persisted rows arrive as `category: null`; normalize to undefined so a
    // round-trip PUT never sends null at a `.optional()` (non-nullable) field.
    category: item.category ?? undefined,
  };
}

/** Stable client id for a new row (pattern: forms/LineItemEditor makeId). */
function makeLineId(): string {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Convert a UI LineItem back to a shared line item for saving. */
function uiLineToApi(item: LineItem, sortOrder: number): InvoiceLineItem {
  return {
    id: item.id ?? makeLineId(),
    description: item.description,
    category: item.category,
    quantity: item.qty,
    unitPriceCents: Math.round(item.rate * 100),
    totalCents: Math.round(item.qty * item.rate * 100),
    sortOrder,
    taxable: item.taxable ?? false,
  };
}

/** Build an invoice-compat object for sub-components */
function buildInvCompat(inv: InvoiceResponse, uiStatus: InvoiceStatus, timezone: string) {
  const customerName = inv.customer
    ? (inv.customer.displayName || [inv.customer.firstName, inv.customer.lastName].filter(Boolean).join(' ') || 'Customer')
    : 'Customer';
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    customer: customerName,
    customerId: inv.customer?.id ?? '',
    description: '',
    status: uiStatus,
    lineItems: (inv.lineItems ?? []).map(apiLineToUi),
    dueDate: inv.dueDate,
    sentDate: inv.issuedAt ? formatDateInTenantTz(inv.issuedAt, timezone) : undefined,
    paidDate: undefined as string | undefined,
  };
}

type LineItem = {
  id?: string;
  description: string;
  qty: number;
  rate: number;
  taxable?: boolean;
  category?: 'labor' | 'material' | 'equipment' | 'other';
};

// ─── Payment Journey Timeline ─────────────────────────────────────────────
function PaymentTimeline({ inv }: { inv: InvCompat }) {
  const steps = [
    { label: 'Draft',     date: null,           done: true,                              active: inv.status === 'Draft' },
    { label: 'Sent',      date: inv.sentDate,   done: !!inv.sentDate,                   active: inv.status === 'Sent' },
    { label: 'Viewed',    date: null,           done: inv.status === 'Paid' || inv.status === 'Unpaid' || inv.status === 'Overdue', active: false },
    { label: 'Paid',      date: inv.paidDate,   done: inv.status === 'Paid',            active: inv.status === 'Paid' },
  ];
  const currentIdx = steps.reduce((last, s, i) => s.done ? i : last, 0);

  return (
    <div className="rounded-xl bg-card border border-border px-4 py-4">
      <p className="text-xs text-muted-foreground mb-3">Payment journey</p>
      <div className="relative flex items-start">
        <div className="absolute top-3 left-3 right-3 h-px bg-border z-0" />
        <div
          className={`absolute top-3 left-3 h-px z-0 transition-all ${inv.status === 'Paid' ? 'bg-success' : 'bg-primary'}`}
          style={{ width: `${(currentIdx / (steps.length - 1)) * 100}%`, maxWidth: 'calc(100% - 24px)' }}
        />
        {steps.map((step, i) => (
          <div key={step.label} className="flex-1 flex flex-col items-center relative z-10">
            <div className={`flex size-6 items-center justify-center rounded-full border-2 transition-all ${
              step.done && inv.status === 'Paid' ? 'bg-success border-success' :
              step.done                          ? 'bg-primary border-primary'   :
              i === currentIdx + 1               ? 'bg-card border-primary/30'      :
                                                   'bg-card border-border'
            }`}>
              {step.done && <Check size={12} className="text-primary-foreground" />}
            </div>
            <p className="text-xs text-foreground mt-1.5 text-center" style={{ fontSize: 10 }}>{step.label}</p>
            {step.date && <p className="text-center text-muted-foreground mt-0.5" style={{ fontSize: 9 }}>{step.date}</p>}
          </div>
        ))}
      </div>

      {/* Overdue warning */}
      {inv.status === 'Overdue' && inv.dueDate && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
          <AlertCircle size={12} className="text-destructive shrink-0" />
          <p className="text-xs text-destructive">Payment was due {inv.dueDate}</p>
        </div>
      )}
    </div>
  );
}

// ─── Payment Methods Card ─────────────────────────────────────────────────
// `paymentLink` is the invoice's real Stripe payment link (stripePaymentLinkUrl);
// when absent there is nothing to copy — a hint explains how to get one.
function PaymentMethodsCard({ paymentLink }: { paymentLink?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="px-4 py-3.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Lock size={13} className="text-muted-foreground" />
          <h4 className="text-foreground">Payment options</h4>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">Customer pays via secure hosted page — no account required</p>
      </div>

      {/* Methods */}
      <div className="px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-xl bg-secondary border border-border px-3 py-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 shrink-0">
            <CreditCard size={15} className="text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-foreground">Credit or debit card</p>
            <p className="text-xs text-muted-foreground">Visa · Mastercard · Amex · Discover</p>
          </div>
          <div className="flex gap-1 shrink-0">
            {['V', 'M', 'A'].map(b => (
              <span key={b} className="flex size-5 items-center justify-center rounded bg-card border border-border text-xs text-foreground">{b}</span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-secondary border border-border px-3 py-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-success/15 shrink-0">
            <Building2 size={15} className="text-success" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-foreground">ACH / Bank transfer</p>
            <p className="text-xs text-muted-foreground">Direct debit from checking account</p>
          </div>
          <span className="text-xs text-success bg-success/15 rounded-full px-2 py-0.5 shrink-0">Lower fee</span>
        </div>

        {/* Trust */}
        <div className="flex items-center gap-2 pt-1">
          <Lock size={11} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Secured by Stripe · 256-bit SSL encryption</p>
        </div>

        {/* Payment link */}
        {paymentLink ? (
          <div className="flex items-center gap-2 rounded-lg bg-secondary border border-border px-3 py-2.5 mt-1">
            <p className="flex-1 text-xs text-muted-foreground truncate">{paymentLink}</p>
            <button
              onClick={() => { navigator.clipboard?.writeText(paymentLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors shrink-0"
            >
              {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy link</>}
            </button>
          </div>
        ) : (
          <div className="rounded-lg bg-secondary border border-border px-3 py-2.5 mt-1">
            <p className="text-xs text-muted-foreground">Send the invoice to generate a payment link.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Line Items Editor (inline) ───────────────────────────────────────────
function InvoiceLineItems({ items, editable, onChange }: {
  items: LineItem[]; editable: boolean;
  /** Called with the edited rows on save. May return a promise (the PUT);
   *  a rejection keeps the editor open with the draft intact. */
  onChange?: (items: LineItem[]) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState<LineItem[]>(items);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const total      = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const draftTotal = draft.reduce((s, i) => s + i.qty * i.rate, 0);

  function update(idx: number, field: keyof LineItem, val: string) {
    setDraft(prev => prev.map((item, i) =>
      i === idx ? { ...item, [field]: field === 'description' ? val : parseFloat(val) || 0 } : item
    ));
  }
  function addRow()            { setDraft(prev => [...prev, { description: '', qty: 1, rate: 0 }]); }
  function removeRow(idx: number) { setDraft(prev => prev.filter((_, j) => j !== idx)); }
  // Re-seed the draft from the CURRENT items on every entry into edit mode —
  // a mount-time-only seed lets a save emit stale rows after a refetch.
  function startEditing() { setDraft(items); setSaveError(null); setEditing(true); }
  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await onChange?.(draft);
      setEditing(false);
    } catch (err) {
      // The rows were NOT persisted — keep the editor (and draft) open.
      setSaveError(err instanceof Error ? err.message : 'Failed to save line items');
    } finally {
      setSaving(false);
    }
  }
  function cancel() { setDraft(items); setSaveError(null); setEditing(false); }

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
        <h4 className="text-foreground">Line items</h4>
        {editable && !editing && (
          <button
            onClick={startEditing}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 py-1.5 hover:bg-secondary transition-colors"
          >
            <Pencil size={11} /> Edit
          </button>
        )}
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-[1fr_52px_80px_80px] gap-x-2 px-4 py-2 bg-secondary border-b border-border">
        <p className="text-xs text-muted-foreground">Description</p>
        <p className="text-xs text-muted-foreground text-right">Qty</p>
        <p className="text-xs text-muted-foreground text-right">Rate</p>
        <p className="text-xs text-muted-foreground text-right">Total</p>
      </div>

      <div className="divide-y divide-border">
        {(editing ? draft : items).map((item, i) => (
          <div key={i} className={`grid gap-x-2 px-4 py-2.5 items-center ${editing ? 'grid-cols-[1fr_52px_80px_80px_20px]' : 'grid-cols-[1fr_52px_80px_80px]'}`}>
            {editing ? (
              <>
                <input
                  value={item.description}
                  onChange={e => update(i, 'description', e.target.value)}
                  className="text-sm text-foreground border border-border rounded-lg px-2 py-1.5 focus:outline-none focus:border-primary w-full"
                />
                <input
                  value={item.qty}
                  onChange={e => update(i, 'qty', e.target.value)}
                  type="number" min="0"
                  className="text-sm text-foreground border border-border rounded-lg px-2 py-1.5 text-right focus:outline-none focus:border-primary w-full"
                />
                <input
                  value={item.rate}
                  onChange={e => update(i, 'rate', e.target.value)}
                  type="number" min="0" step="0.01"
                  className="text-sm text-foreground border border-border rounded-lg px-2 py-1.5 text-right focus:outline-none focus:border-primary w-full"
                />
                <p className="text-sm text-foreground text-right">${(item.qty * item.rate).toFixed(2)}</p>
                <button onClick={() => removeRow(i)} className="text-muted-foreground hover:text-destructive transition-colors">
                  <Trash2 size={13} />
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-foreground truncate">{item.description}</p>
                <p className="text-sm text-muted-foreground text-right">{item.qty}</p>
                <p className="text-sm text-muted-foreground text-right">${formatDollars(item.rate)}</p>
                <p className="text-sm text-foreground text-right">${formatDollars(item.qty * item.rate)}</p>
              </>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <button
          onClick={addRow}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-primary hover:text-primary hover:bg-primary/10 w-full transition-colors border-t border-border"
        >
          <Plus size={11} /> Add line item
        </button>
      )}

      <div className="px-4 py-3.5 border-t border-border bg-secondary flex items-center justify-between">
        <p className="text-sm text-foreground">Total due</p>
        <p className="text-sm text-foreground">${formatDollars(editing ? draftTotal : total)}</p>
      </div>

      {editing && (
        <div className="flex flex-col gap-2 px-4 py-3 border-t border-border">
          {saveError && (
            <p className="text-xs text-destructive">Save failed: {saveError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-primary text-primary-foreground py-2 text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : <><Check size={13} /> Save changes</>}
            </button>
            <button
              onClick={cancel}
              disabled={saving}
              className="flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-secondary disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Send Payment Sheet ────────────────────────────────────────────────────
function SendPaymentSheet({ inv, amountDueCents, paymentLink, onClose, onSent, apiId }: {
  inv: InvCompat; amountDueCents: number;
  /** The invoice's real Stripe payment link, when one exists. */
  paymentLink?: string;
  onClose: () => void; onSent: () => void;
  /** When set, the sheet calls the real /api/invoices/:id/send endpoint. */
  apiId?: string;
}) {
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [recipient, setRecipient] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The tokenized pay-page URL minted by POST /:id/send — surfaced post-send.
  const [sentUrl, setSentUrl] = useState<string | null>(null);

  const [msg, setMsg] = useState('');

  type SendBody = {
    channel: 'sms' | 'email';
    recipientPhone?: string;
    recipientEmail?: string;
    customMessage?: string;
  };
  type SendResp = { viewUrl: string; viewToken: string };
  const { mutate: sendInvoice } = useMutation<SendBody, SendResp>(
    'POST',
    apiId ? `/api/invoices/${apiId}/send` : '/api/invoices/_/send'
  );

  async function handleSend() {
    setSending(true);
    setSendError(null);
    try {
      if (apiId) {
        const result = await sendInvoice({
          channel,
          recipientPhone: channel === 'sms' ? recipient : undefined,
          recipientEmail: channel === 'email' ? recipient : undefined,
          customMessage: msg,
        });
        if (result?.viewUrl) setSentUrl(result.viewUrl);
      } else {
        await new Promise((r) => setTimeout(r, 1200));
      }
      setSending(false);
      setSent(true);
      setTimeout(() => { onSent(); onClose(); }, 1200);
    } catch (err) {
      setSending(false);
      setSendError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  const isOverdue = inv.status === 'Overdue';

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-card rounded-t-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <p className="text-sm text-foreground">{isOverdue ? 'Send payment reminder' : 'Send payment link'}</p>
            <p className="text-xs text-muted-foreground">{inv.invoiceNumber} · {inv.customer}</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-secondary">
            <X size={15} className="text-muted-foreground" />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Invoice summary */}
          <div className={`rounded-xl border px-4 py-4 ${isOverdue ? 'bg-destructive/10 border-destructive/30' : 'bg-secondary border-border'}`}>
            <div className="flex items-start justify-between">
              <div>
                <p className={`text-sm ${isOverdue ? 'text-destructive' : 'text-foreground'}`}>{inv.description}</p>
                <p className={`text-xs mt-0.5 ${isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {inv.invoiceNumber}{inv.dueDate ? ` · Due ${inv.dueDate}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-lg ${isOverdue ? 'text-destructive' : 'text-foreground'}`}>{centsToDisplay(amountDueCents)}</p>
                {isOverdue && <p className="text-xs text-destructive">Overdue</p>}
              </div>
            </div>
            {/* Payment methods mini */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
              <CreditCard size={12} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Card · ACH bank transfer</p>
              <Lock size={11} className="text-muted-foreground ml-auto" />
              <p className="text-xs text-muted-foreground">SSL secured</p>
            </div>
          </div>

          {/* Channel toggle */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">Send via</p>
            <div className="flex gap-2">
              {(['sms', 'email'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => {
                    setChannel(c);
                    if (c !== channel) setRecipient('');
                  }}
                  className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors ${
                    channel === c ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground border-border hover:bg-secondary'
                  }`}
                >
                  {c === 'sms' ? <><Smartphone size={13} /> SMS</> : <><Mail size={13} /> Email</>}
                </button>
              ))}
            </div>
          </div>

          {/* Recipient */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">{channel === 'sms' ? 'Phone number' : 'Email address'}</p>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary bg-card"
            />
          </div>

          {/* Personal note */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Personal note <span className="text-muted-foreground">(optional)</span></p>
            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              rows={3}
              placeholder="Add a personal note to your customer..."
              className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary bg-card resize-none leading-relaxed"
            />
          </div>

          {/* Payment link row — the freshly minted view URL after a send,
              else the invoice's Stripe payment link, else a hint. */}
          <div className="flex items-center gap-2 rounded-lg bg-secondary border border-border px-3 py-2">
            <ExternalLink size={11} className="text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground truncate flex-1">
              {sentUrl ?? paymentLink ?? 'Send the invoice to generate a payment link.'}
            </p>
          </div>

          {/* Due date */}
          {inv.dueDate && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock size={11} /> Payment due {inv.dueDate}
            </p>
          )}

          {sendError && (
            <p className="text-xs text-destructive -mt-2">Send failed: {sendError}</p>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={sending || sent}
            className={`flex items-center justify-center gap-2 w-full rounded-xl py-3.5 text-sm transition-all ${
              sent    ? 'bg-success text-primary-foreground' :
              sending ? 'bg-primary  text-primary-foreground' :
              isOverdue ? 'bg-destructive hover:bg-destructive text-primary-foreground' :
                        'bg-primary  hover:bg-primary text-primary-foreground'
            }`}
          >
            {sent ? <><Check size={15} /> Sent!</> : sending ? 'Sending…' : <><Send size={15} /> {isOverdue ? 'Send reminder' : 'Send payment link'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

type RecordPaymentMethod = 'cash' | 'check' | 'credit_card' | 'bank_transfer' | 'other';

const UI_METHOD_TO_API: Record<'card' | 'ach' | 'cash' | 'check', RecordPaymentMethod> = {
  card: 'credit_card',
  ach: 'bank_transfer',
  cash: 'cash',
  check: 'check',
};

// ─── Mark Paid Sheet ──────────────────────────────────────────────────────
function MarkPaidSheet({
  invoiceId,
  amountDueCents,
  inv,
  onClose,
  onPaid,
}: {
  invoiceId: string;
  amountDueCents: number;
  inv: InvCompat;
  onClose: () => void;
  onPaid: () => void | Promise<void>;
}) {
  const [method, setMethod] = useState<'card' | 'ach' | 'cash' | 'check'>('cash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const METHODS = [
    { key: 'card',  label: 'Credit / Debit card', icon: CreditCard },
    { key: 'ach',   label: 'ACH / Bank transfer',  icon: Building2 },
    { key: 'cash',  label: 'Cash',                  icon: DollarSign },
    { key: 'check', label: 'Check',                 icon: FileText },
  ] as const;

  async function handleSave() {
    const amountCents = amountDueCents;
    if (amountCents <= 0) {
      setError('Nothing due on this invoice.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          amountCents,
          method: UI_METHOD_TO_API[method],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body?.message === 'string' ? body.message : `Payment failed (HTTP ${res.status})`,
        );
      }
      await onPaid();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-card rounded-t-2xl max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <p className="text-sm text-foreground">Mark as paid</p>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-secondary">
            <X size={15} className="text-muted-foreground" />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-xl bg-success/10 border border-success/30 px-4 py-4">
            <div>
              <p className="text-sm text-success">{inv.description}</p>
              <p className="text-xs text-success mt-0.5">{inv.invoiceNumber}</p>
            </div>
            <p className="text-lg text-success">{centsToDisplay(amountDueCents)}</p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Payment method received</p>
            <div className="grid grid-cols-2 gap-2">
              {METHODS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setMethod(key as typeof method)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-left transition-colors ${
                    method === key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-secondary'
                  }`}
                >
                  <Icon size={14} />
                  <p className="text-sm">{label}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Payment date</p>
            <input
              defaultValue="Today"
              className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="flex items-center justify-center gap-2 w-full rounded-xl bg-success text-primary-foreground py-3.5 text-sm hover:bg-success transition-colors"
          >
            {saving ? 'Saving…' : <><CheckCircle2 size={15} /> Confirm payment received</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Origin / Attribution badge ───────────────────────────────────────────
function formatLeadSource(source: string): string {
  const labels: Record<string, string> = {
    web_form: 'Web form',
    phone_call: 'Phone call',
    referral: 'Referral',
    walk_in: 'Walk-in',
    marketplace: 'Marketplace',
    other: 'Other',
  };
  return labels[source] ?? source;
}

function OriginAttributionLine({ leadId }: { leadId: string }) {
  const { data: lead, isLoading } = useDetailQuery<ApiLead>('/api/leads', leadId);
  if (isLoading || !lead) return null;
  const parts: string[] = [formatLeadSource(lead.source)];
  if (lead.utmCampaign) parts.push(`Campaign: ${lead.utmCampaign}`);
  else if (lead.utmSource) parts.push(`Source: ${lead.utmSource}`);
  if (lead.utmMedium && !lead.utmCampaign) parts.push(`Medium: ${lead.utmMedium}`);
  return (
    <p className="text-xs text-muted-foreground mt-1">
      Originated from <span className="text-foreground">{parts.join(' · ')}</span>
    </p>
  );
}

// ─── Invoice Detail ───────────────────────────────────────────────────────
function InvoiceDetail({ invoiceId, onBack }: { invoiceId: string; onBack: () => void }) {
  const navigate = useNavigate();
  const tz = useTenantTimezone();
  const { data: inv, isLoading, error, refetch } = useDetailQuery<InvoiceResponse>('/api/invoices', invoiceId);
  const { mutate: updateInvoice } = useMutation<Record<string, unknown>, InvoiceResponse>('PUT', `/api/invoices/${invoiceId}`);

  const [sendOpen,  setSendOpen]  = useState(false);
  const [markOpen,  setMarkOpen]  = useState(false);
  const [paid,      setPaid]      = useState(false);

  // Notes
  const [notes, setNotes]       = useState<Array<{ id: string; content: string; createdAt: string }>>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteText,    setNoteText]    = useState('');
  const [savingNote,  setSavingNote]  = useState(false);

  useEffect(() => {
    apiFetch(`/api/notes?entityType=invoice&entityId=${invoiceId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Array<{ id: string; content: string; createdAt: string }>) => {
        setNotes(data);
        setNotesLoaded(true);
      })
      .catch(() => setNotesLoaded(true));
  }, [invoiceId]);

  async function saveNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      const res = await apiFetch('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ entityType: 'invoice', entityId: invoiceId, content: noteText.trim() }),
      });
      if (res.ok) {
        const saved = await res.json();
        setNotes(prev => [...prev, saved]);
        setNoteText('');
      }
    } finally {
      setSavingNote(false);
    }
  }

  if (isLoading && !inv) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if ((error && !inv) || !inv) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">Failed to load invoice</p>
        <button onClick={onBack} className="text-xs text-primary hover:underline">Go back</button>
      </div>
    );
  }

  const apiStatus   = paid ? 'paid' : inv.status;
  // Derive 'Overdue' (open/partially_paid + past due) — there is no overdue API
  // status, so a plain normalize would never surface the overdue banner/reminder.
  const uiStatus    = deriveInvoiceUiStatus(apiStatus, inv.dueDate) as InvoiceStatus;
  const invCompat   = buildInvCompat(inv, uiStatus, tz);
  const uiLineItems = (inv.lineItems ?? []).map(apiLineToUi);

  // U4 (E4) — money comes from server totals (integer cents), never a
  // float line-item recompute. `totals.totalCents` is the true invoice
  // total (tax/discount/fee applied); `amountDueCents` is the outstanding
  // balance after any partial payments; `amountPaidCents` is what's been
  // collected so far. No `qty*rate/100` and no `?? Math.round(...)` fallback.
  const totalCents      = inv.totals.totalCents;
  const amountPaidCents = inv.amountPaidCents;
  const amountDueCents  = inv.amountDueCents;
  const customer   = inv.customer;
  const status: InvoiceStatus = uiStatus;
  const editable   = status === 'Draft';
  // The invoice's REAL Stripe-hosted payment link when one exists — never a
  // fabricated URL. Absent until the payment link is created server-side.
  const paymentLink = inv.stripePaymentLinkUrl;
  // U12 (E14) — only offer "Mark as paid" when the backend can actually
  // accept a payment (PAYABLE_STATUSES = open / partially_paid). Drafts,
  // paid, and void/canceled invoices hide it. We read the *normalized* API
  // status (deriveInvoiceUiStatus folds 'open'/'partially_paid' → 'Unpaid'
  // and may surface 'Overdue'), all of which map back to a payable invoice.
  const canMarkPaid = status === 'Unpaid' || status === 'Overdue';

  return (
    <>
      <div className="h-full overflow-y-auto pb-24 md:pb-6">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6">
          {/* Back */}
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5">
            <ArrowLeft size={14} /> Back to Invoices
          </button>

          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div>
              <h1 className="text-foreground" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>{invCompat.customer}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">{inv.invoiceNumber}</p>
              {inv.dueDate && (
                <p className={`text-xs mt-1 flex items-center gap-1 ${status === 'Overdue' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  <Clock size={10} /> Due {inv.dueDate}
                </p>
              )}
              {inv.originatingLeadId && (
                <OriginAttributionLine leadId={inv.originatingLeadId} />
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge status={status} />
              <p className="text-sm text-foreground">{centsToDisplay(totalCents)}</p>
            </div>
          </div>

          {/* Payment status banner */}
          {status === 'Paid' && (
            <div className="flex items-center gap-3 rounded-xl bg-success/10 border border-success/30 px-4 py-4 mb-5">
              <div className="flex size-10 items-center justify-center rounded-full bg-success/15 shrink-0">
                <CheckCircle2 size={20} className="text-success" />
              </div>
              <div>
                <p className="text-sm text-success">Payment received</p>
                <p className="text-xs text-success mt-0.5">{paid ? 'Just now' : ''} · {centsToDisplay(totalCents)}</p>
              </div>
            </div>
          )}
          {status === 'Overdue' && (
            <div className="flex items-start gap-3 rounded-xl bg-destructive/10 border border-destructive/30 px-4 py-4 mb-5">
              <AlertCircle size={18} className="text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-destructive">Payment overdue</p>
                <p className="text-xs text-destructive mt-0.5">Due {inv.dueDate} · {centsToDisplay(amountDueCents)} outstanding</p>
              </div>
              <button
                onClick={() => setSendOpen(true)}
                className="flex items-center gap-1.5 shrink-0 rounded-lg bg-destructive text-primary-foreground px-3 py-1.5 text-xs hover:bg-destructive transition-colors"
              >
                <MessageSquare size={11} /> Remind
              </button>
            </div>
          )}
          {status === 'Draft' && (
            <div className="flex items-center gap-3 rounded-xl bg-secondary border border-border px-4 py-3 mb-5">
              <FileText size={16} className="text-muted-foreground shrink-0" />
              <p className="text-sm text-foreground">Draft — review line items then send to customer</p>
            </div>
          )}

          {/* 2-col layout */}
          <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_320px] md:gap-6 md:items-start">
            {/* Left column */}
            <div className="flex flex-col gap-4">
              <InvoiceLineItems
                items={uiLineItems}
                editable={editable}
                onChange={async (items) => {
                  // Persist the edit — nothing is committed locally until the
                  // server accepts it (a rejection keeps the editor open).
                  await updateInvoice({ lineItems: items.map((item, i) => uiLineToApi(item, i)) });
                  await refetch();
                }}
              />
              {status !== 'Paid' && (
                <PaymentMethodsCard paymentLink={paymentLink} />
              )}
              <AttachmentSection entityType="invoice" entityId={invoiceId} />

              {/* Notes section */}
              <div className="rounded-xl bg-card border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                  <MessageSquare size={13} className="text-muted-foreground" />
                  <p className="text-sm text-foreground">Notes</p>
                  <span className="ml-auto text-xs text-muted-foreground">{notes.length}</span>
                </div>
                {notesLoaded && notes.length > 0 && (
                  <div className="divide-y divide-border">
                    {notes.map(n => (
                      <div key={n.id} className="px-4 py-3">
                        <p className="text-sm text-foreground leading-snug">{n.content}</p>
                        <p className="text-xs text-muted-foreground mt-1">{formatDateTimeInTenantTz(n.createdAt, tz)}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-4 py-3 border-t border-border flex flex-col gap-2">
                  <textarea
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    rows={2}
                    placeholder="Add a note…"
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm resize-none focus:outline-none focus:border-primary transition-colors"
                  />
                  <button
                    onClick={saveNote}
                    disabled={savingNote || !noteText.trim()}
                    className="self-end rounded-lg bg-primary text-primary-foreground text-xs px-3 py-1.5 hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    {savingNote ? 'Saving…' : 'Save note'}
                  </button>
                </div>
              </div>
            </div>

            {/* Right rail */}
            <div className="flex flex-col gap-4">
              <PaymentTimeline inv={invCompat} />

              {/* Originating estimate link */}
              {inv.estimateId && (
                <button
                  onClick={() => navigate(`/estimates/${inv.estimateId}`)}
                  className="flex items-center gap-2 rounded-xl bg-card border border-border px-4 py-3 hover:border-border hover:bg-secondary transition-colors text-left"
                >
                  <FileText size={13} className="text-muted-foreground shrink-0" />
                  <p className="text-sm text-foreground flex-1">View originating estimate</p>
                  <ChevronRight size={13} className="text-muted-foreground" />
                </button>
              )}

              {/* Job link */}
              {inv.jobId && (
                <button
                  onClick={() => navigate(`/jobs/${inv.jobId}`)}
                  className="flex items-center gap-2 rounded-xl bg-card border border-border px-4 py-3 hover:border-border hover:bg-secondary transition-colors text-left"
                >
                  <Briefcase size={13} className="text-muted-foreground shrink-0" />
                  <p className="text-sm text-foreground flex-1">View linked job</p>
                  <ChevronRight size={13} className="text-muted-foreground" />
                </button>
              )}

              {/* Customer card */}
              {customer && (
                <div className="rounded-xl bg-card border border-border px-4 py-4">
                  <p className="text-xs text-muted-foreground mb-2">Billed to</p>
                  <button
                    onClick={() => invCompat.customerId && navigate(`/customers/${invCompat.customerId}`)}
                    className="text-sm text-foreground hover:text-primary transition-colors text-left"
                  >
                    {invCompat.customer}
                  </button>
                  <div className="flex flex-col gap-1.5 mt-2">
                    {customer.primaryPhone && (
                      <a href={`tel:${customer.primaryPhone}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-success transition-colors">
                        <Phone size={11} /> {customer.primaryPhone}
                      </a>
                    )}
                    {customer.email && (
                      <a href={`mailto:${customer.email}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                        <Mail size={11} /> {customer.email}
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Amount due — server totals, integer cents. For a partially
                  paid invoice the headline is the remaining balance
                  (amountDueCents) and we surface the collected amount on a
                  separate "Paid" line. */}
              <div className={`rounded-xl px-4 py-4 ${status === 'Paid' ? 'bg-success' : status === 'Overdue' ? 'bg-destructive' : 'bg-primary'} text-primary-foreground`}>
                <p className="text-sm text-primary-foreground/60 mb-1">
                  {status === 'Paid' ? 'Amount paid' : 'Amount due'}
                </p>
                <p className="text-3xl text-primary-foreground mb-1">
                  {status === 'Paid' ? centsToDisplay(totalCents) : centsToDisplay(amountDueCents)}
                </p>
                {status !== 'Paid' && amountPaidCents > 0 && (
                  <p className="text-xs text-primary-foreground/60">Paid {centsToDisplay(amountPaidCents)} of {centsToDisplay(totalCents)}</p>
                )}
                {inv.dueDate && status !== 'Paid' && (
                  <p className={`text-xs ${status === 'Overdue' ? 'text-destructive' : 'text-primary-foreground/40'}`}>
                    {status === 'Overdue' ? 'Overdue since' : 'Due'} {inv.dueDate}
                  </p>
                )}
                {status === 'Paid' && (
                  <p className="text-xs text-success">{paid ? 'Just now' : ''}</p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-col gap-2">
                {status !== 'Paid' && (
                  <button
                    onClick={() => setSendOpen(true)}
                    className={`flex items-center justify-center gap-2 rounded-xl py-3 text-sm transition-colors text-primary-foreground ${
                      status === 'Overdue' ? 'bg-destructive hover:bg-destructive' : 'bg-primary hover:bg-primary'
                    }`}
                  >
                    <Send size={14} />
                    {status === 'Draft'   ? 'Send payment link' :
                     status === 'Overdue' ? 'Send reminder'     : 'Resend payment link'}
                  </button>
                )}
                {canMarkPaid && (
                  <button
                    onClick={() => setMarkOpen(true)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card text-foreground py-3 text-sm hover:bg-secondary transition-colors"
                  >
                    <CheckCircle size={14} /> Mark as paid
                  </button>
                )}
                {status === 'Paid' && (
                  <button className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card text-foreground py-3 text-sm hover:bg-secondary transition-colors">
                    <FileText size={14} /> Download receipt
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {sendOpen && (
        <SendPaymentSheet
          inv={invCompat}
          amountDueCents={amountDueCents}
          paymentLink={paymentLink}
          apiId={inv?.id}
          onClose={() => setSendOpen(false)}
          onSent={() => {}}
        />
      )}
      {markOpen && (
        <MarkPaidSheet
          invoiceId={inv.id}
          amountDueCents={amountDueCents}
          inv={invCompat}
          onClose={() => setMarkOpen(false)}
          onPaid={async () => {
            setPaid(true);
            await refetch();
          }}
        />
      )}
    </>
  );
}

// ─── Invoices List ────────────────────────────────────────────────────────
const API_STATUS_FOR_TAB: Record<string, string> = {
  Draft:   'draft',
  Unpaid:  'open',
  Overdue: 'open',
  Paid:    'paid',
};

const TABS: { label: string; value: InvoiceStatus | 'All' }[] = [
  { label: 'All',     value: 'All'     },
  { label: 'Draft',   value: 'Draft'   },
  { label: 'Unpaid',  value: 'Unpaid'  },
  { label: 'Overdue', value: 'Overdue' },
  { label: 'Paid',    value: 'Paid'    },
];

/**
 * P5-018 — refresh interval for the dispatcher invoice list. 30s gives
 * ~near-real-time visibility on payment receipts without hammering the
 * API. Lifted to a constant so tests can reason about it.
 */
const INVOICE_LIST_REFRESH_MS = 30_000;

export function InvoicesPage({ defaultSelectedId }: { defaultSelectedId?: string } = {}) {
  const navigate = useNavigate();
  const tz = useTenantTimezone();
  const [tab,      setTab]      = useState<InvoiceStatus | 'All'>('All');
  const [selected, setSelected] = useState<string | null>(defaultSelectedId ?? null);

  // Keep `selected` in sync with the route param so deep-links and in-place
  // route changes (/invoices/:id → /invoices/:other) reopen the right
  // detail view instead of holding onto the previous selection.
  useEffect(() => {
    setSelected(defaultSelectedId ?? null);
  }, [defaultSelectedId]);

  const { data, total, isLoading, error, setFilters, refetch } = useListQuery<InvoiceResponse>(
    '/api/invoices',
    {
      // P5-018 — live refresh while the list is visible. Pause while a detail
      // page is open so the user isn't yanked around. Uses the shared hook's
      // background refetch (no spinner flash) + visibility pause/catch-up.
      refetchInterval: selected ? undefined : INVOICE_LIST_REFRESH_MS,
    },
  );

  // P5-018 — Toast when an invoice transitions to paid. We track the
  // previous status map across renders; a transition `previous !== paid
  // && next === paid` fires a Sonner toast.
  const previousStatusesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const previous = previousStatusesRef.current;
    const next = new Map<string, string>();
    for (const inv of data) {
      next.set(inv.id, inv.status);
      const prev = previous.get(inv.id);
      if (prev && prev !== 'paid' && inv.status === 'paid') {
        toast.success(`Payment received on ${inv.invoiceNumber}`);
      }
    }
    previousStatusesRef.current = next;
  }, [data]);

  if (selected) {
    return <InvoiceDetail invoiceId={selected} onBack={() => {
      setSelected(null);
      if (defaultSelectedId) navigate('/invoices');
    }} />;
  }

  const normalizedData = data.map(i => ({
    ...i,
    uiStatus: deriveInvoiceUiStatus(i.status, i.dueDate) as InvoiceStatus,
  }));

  const filtered = tab === 'All'
    ? normalizedData
    : normalizedData.filter(i => i.uiStatus === tab);

  const totalUnpaid  = normalizedData.filter(i => i.uiStatus === 'Unpaid' || i.uiStatus === 'Overdue').reduce((s, i) => s + i.totals.totalCents, 0);
  const totalPaid    = normalizedData.filter(i => i.uiStatus === 'Paid').reduce((s, i) => s + i.totals.totalCents, 0);
  const overdueCount = normalizedData.filter(i => i.uiStatus === 'Overdue').length;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="px-4 md:px-6 py-4 md:py-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-foreground">Invoices</h1>
          <button
            onClick={() => navigate('/invoices/new')}
            className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm hover:bg-primary/90 transition-colors"
          >
            <Plus size={14} /> New invoice
          </button>
        </div>

        {/* Financial summary */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="rounded-xl border border-warning/20 bg-warning/10 px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <DollarSign size={12} className="text-warning" />
              <p className="text-xs text-warning">Outstanding</p>
            </div>
            <p className="text-sm text-warning">{centsToDisplay(totalUnpaid)}</p>
            {overdueCount > 0 && <p className="text-xs text-destructive mt-0.5">{overdueCount} overdue</p>}
          </div>
          <div className="rounded-xl border border-success/20 bg-success/10 px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <CheckCircle size={12} className="text-success" />
              <p className="text-xs text-success">Collected</p>
            </div>
            <p className="text-sm text-success">{centsToDisplay(totalPaid)}</p>
            <p className="text-xs text-success mt-0.5">this week</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <FileText size={12} className="text-muted-foreground" />
              <p className="text-xs text-foreground">Total</p>
            </div>
            <p className="text-sm text-foreground">{total} invoices</p>
            <p className="text-xs text-muted-foreground mt-0.5">this month</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => {
                setTab(t.value);
                if (t.value !== 'All') {
                  const apiStatus = API_STATUS_FOR_TAB[t.value];
                  if (apiStatus) setFilters({ status: apiStatus });
                } else {
                  setFilters({});
                }
              }}
              className={`shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value ? 'bg-primary text-primary-foreground' : 'bg-card border border-border text-foreground hover:bg-secondary'
              }`}
            >
              {t.value === 'Overdue' && <AlertCircle size={11} className="text-destructive" />}
              {t.label}
            </button>
          ))}
        </div>

        {/* Loading / Error — only blank the list on cold load. Background
            polls (30s) keep isLoading false once rows exist. */}
        {isLoading && data.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="md" className="text-foreground" label="Loading invoices" />
          </div>
        )}
        {error && (
          <ErrorState message="Failed to load invoices" onRetry={refetch} />
        )}

        {/* List */}
        {!(isLoading && data.length === 0) && !error && (
          <div className="flex flex-col gap-2">
            {filtered.map(inv => {
              const status = inv.uiStatus;
              const customerName = inv.customer
                ? (inv.customer.displayName || [inv.customer.firstName, inv.customer.lastName].filter(Boolean).join(' ') || 'Customer')
                : 'Customer';
              return (
                <button
                  key={inv.id}
                  onClick={() => setSelected(inv.id)}
                  className="flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-4 text-left hover:border-border hover:shadow-sm transition-all group"
                >
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
                    status === 'Paid'    ? 'bg-success/10' :
                    status === 'Overdue' ? 'bg-destructive/10'   : 'bg-secondary'
                  }`}>
                    {status === 'Paid'
                      ? <CheckCircle size={16} className="text-success" />
                      : status === 'Overdue'
                      ? <AlertCircle size={16} className="text-destructive" />
                      : <FileText size={16} className="text-muted-foreground" />
                    }
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground">{customerName}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{inv.invoiceNumber}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <p className="text-sm text-foreground">{centsToDisplay(inv.totals.totalCents)}</p>
                        <StatusBadge status={status} size="sm" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      {inv.dueDate && (
                        <span className={`flex items-center gap-1 text-xs ${status === 'Overdue' ? 'text-destructive' : 'text-muted-foreground'}`}>
                          <Clock size={10} /> Due {inv.dueDate}
                        </span>
                      )}
                      {inv.issuedAt && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Send size={10} /> Sent {formatDateInTenantTz(inv.issuedAt, tz)}
                        </span>
                      )}
                      {status === 'Draft' && (
                        <span className="text-xs text-muted-foreground">Not sent yet</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-muted-foreground group-hover:text-muted-foreground transition-colors" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <EmptyState title="No invoices" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
