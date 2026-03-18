import { useState } from 'react';
import {
  Plus, Send, ArrowLeft, DollarSign, CheckCircle, CheckCircle2,
  Clock, AlertCircle, FileText, CreditCard, ChevronRight, X,
  Phone, Mail, Copy, Check, Pencil, Trash2, MessageSquare,
  ExternalLink, Lock, Building2, Smartphone,
} from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { normalizeInvoiceStatus, centsToDisplay } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { customers } from '../../data/mock-data';

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

interface ApiLineItem {
  id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

interface ApiCustomer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
}

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  jobId?: string;
  totalCents: number;
  subtotalCents: number;
  amountDueCents?: number;
  amountPaidCents?: number;
  discountCents?: number;
  dueDate?: string;
  issuedAt?: string;
  lineItems?: ApiLineItem[];
  createdAt?: string;
  customer?: ApiCustomer;
  customerId?: string;
}

/** Convert ApiLineItem to UI LineItem */
function apiLineToUi(item: ApiLineItem): LineItem {
  return {
    description: item.description,
    qty: item.quantity,
    rate: item.unitPriceCents / 100,
  };
}

/** Build an invoice-compat object for sub-components */
function buildInvCompat(inv: ApiInvoice, uiStatus: InvoiceStatus) {
  const customerName = inv.customer
    ? (inv.customer.displayName || [inv.customer.firstName, inv.customer.lastName].filter(Boolean).join(' ') || 'Customer')
    : 'Customer';
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    customer: customerName,
    customerId: inv.customerId ?? inv.customer?.id ?? '',
    description: '',
    status: uiStatus,
    lineItems: (inv.lineItems ?? []).map(apiLineToUi),
    dueDate: inv.dueDate,
    sentDate: inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : undefined,
    paidDate: undefined as string | undefined,
  };
}

type LineItem = { description: string; qty: number; rate: number };

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
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
      <p className="text-xs text-slate-400 mb-3">Payment journey</p>
      <div className="relative flex items-start">
        <div className="absolute top-3 left-3 right-3 h-px bg-slate-200 z-0" />
        <div
          className={`absolute top-3 left-3 h-px z-0 transition-all ${inv.status === 'Paid' ? 'bg-green-400' : 'bg-blue-400'}`}
          style={{ width: `${(currentIdx / (steps.length - 1)) * 100}%`, maxWidth: 'calc(100% - 24px)' }}
        />
        {steps.map((step, i) => (
          <div key={step.label} className="flex-1 flex flex-col items-center relative z-10">
            <div className={`flex size-6 items-center justify-center rounded-full border-2 transition-all ${
              step.done && inv.status === 'Paid' ? 'bg-green-500 border-green-500' :
              step.done                          ? 'bg-blue-600 border-blue-600'   :
              i === currentIdx + 1               ? 'bg-white border-blue-300'      :
                                                   'bg-white border-slate-200'
            }`}>
              {step.done && <Check size={12} className="text-white" />}
            </div>
            <p className="text-xs text-slate-600 mt-1.5 text-center" style={{ fontSize: 10 }}>{step.label}</p>
            {step.date && <p className="text-center text-slate-400 mt-0.5" style={{ fontSize: 9 }}>{step.date}</p>}
          </div>
        ))}
      </div>

      {/* Overdue warning */}
      {inv.status === 'Overdue' && inv.dueDate && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-100 px-3 py-2">
          <AlertCircle size={12} className="text-red-500 shrink-0" />
          <p className="text-xs text-red-700">Payment was due {inv.dueDate}</p>
        </div>
      )}
    </div>
  );
}

// ─── Payment Methods Card ─────────────────────────────────────────────────
function PaymentMethodsCard({ paymentLink }: { paymentLink: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="px-4 py-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Lock size={13} className="text-slate-400" />
          <h4 className="text-slate-700">Payment options</h4>
        </div>
        <p className="text-xs text-slate-400 mt-0.5">Customer pays via secure hosted page — no account required</p>
      </div>

      {/* Methods */}
      <div className="px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-100 px-3 py-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-blue-100 shrink-0">
            <CreditCard size={15} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-slate-800">Credit or debit card</p>
            <p className="text-xs text-slate-400">Visa · Mastercard · Amex · Discover</p>
          </div>
          <div className="flex gap-1 shrink-0">
            {['V', 'M', 'A'].map(b => (
              <span key={b} className="flex size-5 items-center justify-center rounded bg-white border border-slate-200 text-xs text-slate-600">{b}</span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-100 px-3 py-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-green-100 shrink-0">
            <Building2 size={15} className="text-green-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-slate-800">ACH / Bank transfer</p>
            <p className="text-xs text-slate-400">Direct debit from checking account</p>
          </div>
          <span className="text-xs text-green-700 bg-green-100 rounded-full px-2 py-0.5 shrink-0">Lower fee</span>
        </div>

        {/* Trust */}
        <div className="flex items-center gap-2 pt-1">
          <Lock size={11} className="text-slate-400" />
          <p className="text-xs text-slate-400">Secured by Stripe · 256-bit SSL encryption</p>
        </div>

        {/* Payment link */}
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 mt-1">
          <p className="flex-1 text-xs text-slate-500 truncate">{paymentLink}</p>
          <button
            onClick={() => { navigator.clipboard?.writeText(paymentLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors shrink-0"
          >
            {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy link</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Line Items Editor (inline) ───────────────────────────────────────────
function InvoiceLineItems({ items, editable, onChange }: {
  items: LineItem[]; editable: boolean; onChange?: (items: LineItem[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState<LineItem[]>(items);
  const total      = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const draftTotal = draft.reduce((s, i) => s + i.qty * i.rate, 0);

  function update(idx: number, field: keyof LineItem, val: string) {
    setDraft(prev => prev.map((item, i) =>
      i === idx ? { ...item, [field]: field === 'description' ? val : parseFloat(val) || 0 } : item
    ));
  }
  function addRow()            { setDraft(prev => [...prev, { description: '', qty: 1, rate: 0 }]); }
  function removeRow(idx: number) { setDraft(prev => prev.filter((_, j) => j !== idx)); }
  function save()   { onChange?.(draft); setEditing(false); }
  function cancel() { setDraft(items); setEditing(false); }

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
        <h4 className="text-slate-700">Line items</h4>
        {editable && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 transition-colors"
          >
            <Pencil size={11} /> Edit
          </button>
        )}
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-[1fr_52px_80px_80px] gap-x-2 px-4 py-2 bg-slate-50 border-b border-slate-100">
        <p className="text-xs text-slate-400">Description</p>
        <p className="text-xs text-slate-400 text-right">Qty</p>
        <p className="text-xs text-slate-400 text-right">Rate</p>
        <p className="text-xs text-slate-400 text-right">Total</p>
      </div>

      <div className="divide-y divide-slate-50">
        {(editing ? draft : items).map((item, i) => (
          <div key={i} className={`grid gap-x-2 px-4 py-2.5 items-center ${editing ? 'grid-cols-[1fr_52px_80px_80px_20px]' : 'grid-cols-[1fr_52px_80px_80px]'}`}>
            {editing ? (
              <>
                <input
                  value={item.description}
                  onChange={e => update(i, 'description', e.target.value)}
                  className="text-sm text-slate-800 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 w-full"
                />
                <input
                  value={item.qty}
                  onChange={e => update(i, 'qty', e.target.value)}
                  type="number" min="0"
                  className="text-sm text-slate-700 border border-slate-200 rounded-lg px-2 py-1.5 text-right focus:outline-none focus:border-blue-400 w-full"
                />
                <input
                  value={item.rate}
                  onChange={e => update(i, 'rate', e.target.value)}
                  type="number" min="0" step="0.01"
                  className="text-sm text-slate-700 border border-slate-200 rounded-lg px-2 py-1.5 text-right focus:outline-none focus:border-blue-400 w-full"
                />
                <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toFixed(2)}</p>
                <button onClick={() => removeRow(i)} className="text-slate-300 hover:text-red-400 transition-colors">
                  <Trash2 size={13} />
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-800 truncate">{item.description}</p>
                <p className="text-sm text-slate-500 text-right">{item.qty}</p>
                <p className="text-sm text-slate-500 text-right">${item.rate.toLocaleString()}</p>
                <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toLocaleString()}</p>
              </>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <button
          onClick={addRow}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50/50 w-full transition-colors border-t border-slate-50"
        >
          <Plus size={11} /> Add line item
        </button>
      )}

      <div className="px-4 py-3.5 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
        <p className="text-sm text-slate-600">Total due</p>
        <p className="text-sm text-slate-900">${(editing ? draftTotal : total).toLocaleString()}</p>
      </div>

      {editing && (
        <div className="flex gap-2 px-4 py-3 border-t border-slate-100">
          <button
            onClick={save}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 text-white py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            <Check size={13} /> Save changes
          </button>
          <button
            onClick={cancel}
            className="flex items-center justify-center rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Send Payment Sheet ────────────────────────────────────────────────────
function SendPaymentSheet({ inv, total, paymentLink, onClose, onSent }: {
  inv: InvCompat; total: number; paymentLink: string;
  onClose: () => void; onSent: () => void;
}) {
  const customer = customers.find(c => c.id === inv.customerId);
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);

  const firstName = customer?.name.split(' ')[0] ?? 'there';

  const smsMsg  = `Hi ${firstName},\n\nYour invoice for ${inv.description} is ready.\n\nAmount due: $${total.toLocaleString()}\n\nPay securely online:\n${paymentLink}\n\nQuestions? Call (512) 555-0000.\nThanks! – Mike`;
  const emailMsg = `Hi ${firstName},\n\nYour invoice ${inv.invoiceNumber} is ready for payment.\n\nDescription: ${inv.description}\nAmount due: $${total.toLocaleString()}${inv.dueDate ? `\nDue date: ${inv.dueDate}` : ''}\n\nPay by card or ACH:\n${paymentLink}\n\nThank you,\nMike\nFieldly Pro Services\n(512) 555-0000`;

  const [msg, setMsg] = useState(smsMsg);

  function handleSend() {
    setSending(true);
    setTimeout(() => { setSending(false); setSent(true); setTimeout(() => { onSent(); onClose(); }, 1200); }, 1500);
  }

  const isOverdue = inv.status === 'Overdue';

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-white rounded-t-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <p className="text-sm text-slate-900">{isOverdue ? 'Send payment reminder' : 'Send payment link'}</p>
            <p className="text-xs text-slate-400">{inv.invoiceNumber} · {inv.customer}</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Invoice summary */}
          <div className={`rounded-xl border px-4 py-4 ${isOverdue ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-start justify-between">
              <div>
                <p className={`text-sm ${isOverdue ? 'text-red-800' : 'text-slate-800'}`}>{inv.description}</p>
                <p className={`text-xs mt-0.5 ${isOverdue ? 'text-red-600' : 'text-slate-400'}`}>
                  {inv.invoiceNumber}{inv.dueDate ? ` · Due ${inv.dueDate}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-lg ${isOverdue ? 'text-red-900' : 'text-slate-900'}`}>${total.toLocaleString()}</p>
                {isOverdue && <p className="text-xs text-red-600">Overdue</p>}
              </div>
            </div>
            {/* Payment methods mini */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-200/50">
              <CreditCard size={12} className="text-slate-400" />
              <p className="text-xs text-slate-500">Card · ACH bank transfer</p>
              <Lock size={11} className="text-slate-400 ml-auto" />
              <p className="text-xs text-slate-400">SSL secured</p>
            </div>
          </div>

          {/* Channel toggle */}
          <div>
            <p className="text-xs text-slate-500 mb-2">Send via</p>
            <div className="flex gap-2">
              {(['sms', 'email'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => { setChannel(c); setMsg(c === 'sms' ? smsMsg : emailMsg); }}
                  className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors ${
                    channel === c ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {c === 'sms' ? <><Smartphone size={13} /> SMS</> : <><Mail size={13} /> Email</>}
                </button>
              ))}
            </div>
          </div>

          {/* Recipient */}
          <div>
            <p className="text-xs text-slate-500 mb-1.5">{channel === 'sms' ? 'Phone number' : 'Email address'}</p>
            <input
              defaultValue={channel === 'sms' ? customer?.phone : customer?.email}
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400 bg-white"
            />
          </div>

          {/* Message */}
          <div>
            <p className="text-xs text-slate-500 mb-1.5">Message</p>
            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              rows={channel === 'sms' ? 8 : 10}
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 bg-white resize-none leading-relaxed"
            />
          </div>

          {/* Payment link row */}
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
            <ExternalLink size={11} className="text-slate-400 shrink-0" />
            <p className="text-xs text-slate-500 truncate flex-1">{paymentLink}</p>
          </div>

          {/* Due date */}
          {inv.dueDate && (
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <Clock size={11} /> Payment due {inv.dueDate}
            </p>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={sending || sent}
            className={`flex items-center justify-center gap-2 w-full rounded-xl py-3.5 text-sm transition-all ${
              sent    ? 'bg-green-600 text-white' :
              sending ? 'bg-blue-400  text-white' :
              isOverdue ? 'bg-red-600 hover:bg-red-700 text-white' :
                        'bg-blue-600  hover:bg-blue-700 text-white'
            }`}
          >
            {sent ? <><Check size={15} /> Sent!</> : sending ? 'Sending…' : <><Send size={15} /> {isOverdue ? 'Send reminder' : 'Send payment link'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mark Paid Sheet ──────────────────────────────────────────────────────
function MarkPaidSheet({ inv, total, onClose, onPaid }: {
  inv: InvCompat; total: number; onClose: () => void; onPaid: () => void;
}) {
  const [method, setMethod] = useState<'card' | 'ach' | 'cash' | 'check'>('card');
  const [saving, setSaving] = useState(false);

  const METHODS = [
    { key: 'card',  label: 'Credit / Debit card', icon: CreditCard },
    { key: 'ach',   label: 'ACH / Bank transfer',  icon: Building2 },
    { key: 'cash',  label: 'Cash',                  icon: DollarSign },
    { key: 'check', label: 'Check',                 icon: FileText },
  ] as const;

  function handleSave() {
    setSaving(true);
    setTimeout(() => { setSaving(false); onPaid(); onClose(); }, 1200);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-white rounded-t-2xl max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <p className="text-sm text-slate-900">Mark as paid</p>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100">
            <X size={15} className="text-slate-500" />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-xl bg-green-50 border border-green-200 px-4 py-4">
            <div>
              <p className="text-sm text-green-800">{inv.description}</p>
              <p className="text-xs text-green-600 mt-0.5">{inv.invoiceNumber}</p>
            </div>
            <p className="text-lg text-green-900">${total.toLocaleString()}</p>
          </div>

          <div>
            <p className="text-xs text-slate-500 mb-2">Payment method received</p>
            <div className="grid grid-cols-2 gap-2">
              {METHODS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setMethod(key as typeof method)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-left transition-colors ${
                    method === key ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Icon size={14} />
                  <p className="text-sm">{label}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-slate-500 mb-1.5">Payment date</p>
            <input
              defaultValue="Today"
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400"
            />
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 w-full rounded-xl bg-green-600 text-white py-3.5 text-sm hover:bg-green-700 transition-colors"
          >
            {saving ? 'Saving…' : <><CheckCircle2 size={15} /> Confirm payment received</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Invoice Detail ───────────────────────────────────────────────────────
function InvoiceDetail({ invoiceId, onBack }: { invoiceId: string; onBack: () => void }) {
  const { data: inv, isLoading, error } = useDetailQuery<ApiInvoice>('/api/invoices', invoiceId);
  const { mutate: transitionInvoice } = useMutation<{ status: string }, ApiInvoice>('POST', `/api/invoices/${invoiceId}/transition`);

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [sendOpen,  setSendOpen]  = useState(false);
  const [markOpen,  setMarkOpen]  = useState(false);
  const [paid,      setPaid]      = useState(false);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
      </div>
    );
  }

  if (error || !inv) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-500">Failed to load invoice</p>
        <button onClick={onBack} className="text-xs text-blue-500 hover:underline">Go back</button>
      </div>
    );
  }

  const apiStatus   = paid ? 'paid' : inv.status;
  const uiStatus    = normalizeInvoiceStatus(apiStatus) as InvoiceStatus;
  const invCompat   = buildInvCompat(inv, uiStatus);
  const apiLineItems = inv.lineItems ?? [];
  const uiLineItems = lineItems.length > 0 ? lineItems : apiLineItems.map(apiLineToUi);

  const total      = uiLineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const customer   = inv.customer;
  const status: InvoiceStatus = uiStatus;
  const editable   = status === 'Draft';
  const paymentLink = `pay.fieldly.app/${inv.invoiceNumber.toLowerCase()}`;

  return (
    <>
      <div className="h-full overflow-y-auto pb-24 md:pb-6">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6">
          {/* Back */}
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors mb-5">
            <ArrowLeft size={14} /> Back to Invoices
          </button>

          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>{invCompat.customer}</h1>
              <p className="text-sm text-slate-400 mt-0.5">{inv.invoiceNumber}</p>
              {inv.dueDate && (
                <p className={`text-xs mt-1 flex items-center gap-1 ${status === 'Overdue' ? 'text-red-500' : 'text-slate-400'}`}>
                  <Clock size={10} /> Due {inv.dueDate}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge status={status} />
              <p className="text-sm text-slate-900">${total.toLocaleString()}</p>
            </div>
          </div>

          {/* Payment status banner */}
          {status === 'Paid' && (
            <div className="flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-4 mb-5">
              <div className="flex size-10 items-center justify-center rounded-full bg-green-100 shrink-0">
                <CheckCircle2 size={20} className="text-green-600" />
              </div>
              <div>
                <p className="text-sm text-green-800">Payment received</p>
                <p className="text-xs text-green-600 mt-0.5">{paid ? 'Just now' : ''} · ${total.toLocaleString()}</p>
              </div>
            </div>
          )}
          {status === 'Overdue' && (
            <div className="flex items-start gap-3 rounded-xl bg-red-50 border border-red-200 px-4 py-4 mb-5">
              <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-red-800">Payment overdue</p>
                <p className="text-xs text-red-600 mt-0.5">Due {inv.dueDate} · {total.toLocaleString()} outstanding</p>
              </div>
              <button
                onClick={() => setSendOpen(true)}
                className="flex items-center gap-1.5 shrink-0 rounded-lg bg-red-600 text-white px-3 py-1.5 text-xs hover:bg-red-700 transition-colors"
              >
                <MessageSquare size={11} /> Remind
              </button>
            </div>
          )}
          {status === 'Draft' && (
            <div className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 mb-5">
              <FileText size={16} className="text-slate-400 shrink-0" />
              <p className="text-sm text-slate-600">Draft — review line items then send to customer</p>
            </div>
          )}

          {/* 2-col layout */}
          <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_320px] md:gap-6 md:items-start">
            {/* Left column */}
            <div className="flex flex-col gap-4">
              <InvoiceLineItems
                items={uiLineItems}
                editable={editable}
                onChange={setLineItems}
              />
              {status !== 'Paid' && (
                <PaymentMethodsCard paymentLink={paymentLink} />
              )}
            </div>

            {/* Right rail */}
            <div className="flex flex-col gap-4">
              <PaymentTimeline inv={invCompat} />

              {/* Customer card */}
              {customer && (
                <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
                  <p className="text-xs text-slate-400 mb-2">Billed to</p>
                  <p className="text-sm text-slate-900">{invCompat.customer}</p>
                  <div className="flex flex-col gap-1.5 mt-2">
                    {customer.primaryPhone && (
                      <a href={`tel:${customer.primaryPhone}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-green-700 transition-colors">
                        <Phone size={11} /> {customer.primaryPhone}
                      </a>
                    )}
                    {customer.email && (
                      <a href={`mailto:${customer.email}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-700 transition-colors">
                        <Mail size={11} /> {customer.email}
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Amount due */}
              <div className={`rounded-xl px-4 py-4 ${status === 'Paid' ? 'bg-green-600' : status === 'Overdue' ? 'bg-red-600' : 'bg-slate-900'} text-white`}>
                <p className="text-sm text-white/60 mb-1">
                  {status === 'Paid' ? 'Amount paid' : 'Amount due'}
                </p>
                <p className="text-3xl text-white mb-1">${total.toLocaleString()}</p>
                {inv.dueDate && status !== 'Paid' && (
                  <p className={`text-xs ${status === 'Overdue' ? 'text-red-200' : 'text-white/40'}`}>
                    {status === 'Overdue' ? 'Overdue since' : 'Due'} {inv.dueDate}
                  </p>
                )}
                {status === 'Paid' && (
                  <p className="text-xs text-green-200">{paid ? 'Just now' : ''}</p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-col gap-2">
                {status !== 'Paid' && (
                  <button
                    onClick={() => setSendOpen(true)}
                    className={`flex items-center justify-center gap-2 rounded-xl py-3 text-sm transition-colors text-white ${
                      status === 'Overdue' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    <Send size={14} />
                    {status === 'Draft'   ? 'Send payment link' :
                     status === 'Overdue' ? 'Send reminder'     : 'Resend payment link'}
                  </button>
                )}
                {status !== 'Paid' && (
                  <button
                    onClick={() => setMarkOpen(true)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors"
                  >
                    <CheckCircle size={14} /> Mark as paid
                  </button>
                )}
                {status === 'Paid' && (
                  <button className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors">
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
          total={total}
          paymentLink={paymentLink}
          onClose={() => setSendOpen(false)}
          onSent={() => {}}
        />
      )}
      {markOpen && (
        <MarkPaidSheet
          inv={invCompat}
          total={total}
          onClose={() => setMarkOpen(false)}
          onPaid={async () => {
            setPaid(true);
            await transitionInvoice({ status: 'paid' });
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

export function InvoicesPage() {
  const [tab,      setTab]      = useState<InvoiceStatus | 'All'>('All');
  const [selected, setSelected] = useState<string | null>(null);

  const { data, total, isLoading, error, setFilters, refetch } = useListQuery<ApiInvoice>('/api/invoices');

  if (selected) {
    return <InvoiceDetail invoiceId={selected} onBack={() => setSelected(null)} />;
  }

  const normalizedData = data.map(i => ({
    ...i,
    uiStatus: normalizeInvoiceStatus(i.status) as InvoiceStatus,
  }));

  const filtered = tab === 'All'
    ? normalizedData
    : normalizedData.filter(i => i.uiStatus === tab);

  const totalUnpaid  = normalizedData.filter(i => i.uiStatus === 'Unpaid' || i.uiStatus === 'Overdue').reduce((s, i) => s + i.totalCents, 0);
  const totalPaid    = normalizedData.filter(i => i.uiStatus === 'Paid').reduce((s, i) => s + i.totalCents, 0);
  const overdueCount = normalizedData.filter(i => i.uiStatus === 'Overdue').length;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="px-4 md:px-6 py-4 md:py-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-slate-900">Invoices</h1>
          <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors">
            <Plus size={14} /> New invoice
          </button>
        </div>

        {/* Financial summary */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <DollarSign size={12} className="text-amber-600" />
              <p className="text-xs text-amber-700">Outstanding</p>
            </div>
            <p className="text-sm text-amber-800">{centsToDisplay(totalUnpaid)}</p>
            {overdueCount > 0 && <p className="text-xs text-red-600 mt-0.5">{overdueCount} overdue</p>}
          </div>
          <div className="rounded-xl border border-green-100 bg-green-50 px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <CheckCircle size={12} className="text-green-600" />
              <p className="text-xs text-green-700">Collected</p>
            </div>
            <p className="text-sm text-green-800">{centsToDisplay(totalPaid)}</p>
            <p className="text-xs text-green-600 mt-0.5">this week</p>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <FileText size={12} className="text-slate-500" />
              <p className="text-xs text-slate-600">Total</p>
            </div>
            <p className="text-sm text-slate-700">{total} invoices</p>
            <p className="text-xs text-slate-400 mt-0.5">this month</p>
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
                tab === t.value ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t.value === 'Overdue' && <AlertCircle size={11} className="text-red-400" />}
              {t.label}
            </button>
          ))}
        </div>

        {/* Loading / Error */}
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center py-12 gap-2 text-center">
            <p className="text-sm text-red-500">Failed to load invoices</p>
            <button onClick={refetch} className="text-xs text-blue-500 hover:underline">Retry</button>
          </div>
        )}

        {/* List */}
        {!isLoading && !error && (
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
                  className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-4 text-left hover:border-slate-300 hover:shadow-sm transition-all group"
                >
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
                    status === 'Paid'    ? 'bg-green-50' :
                    status === 'Overdue' ? 'bg-red-50'   : 'bg-slate-100'
                  }`}>
                    {status === 'Paid'
                      ? <CheckCircle size={16} className="text-green-500" />
                      : status === 'Overdue'
                      ? <AlertCircle size={16} className="text-red-500" />
                      : <FileText size={16} className="text-slate-400" />
                    }
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-900">{customerName}</p>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">{inv.invoiceNumber}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <p className="text-sm text-slate-800">{centsToDisplay(inv.totalCents)}</p>
                        <StatusBadge status={status} size="sm" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      {inv.dueDate && (
                        <span className={`flex items-center gap-1 text-xs ${status === 'Overdue' ? 'text-red-500' : 'text-slate-400'}`}>
                          <Clock size={10} /> Due {inv.dueDate}
                        </span>
                      )}
                      {inv.issuedAt && (
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          <Send size={10} /> Sent {new Date(inv.issuedAt).toLocaleDateString()}
                        </span>
                      )}
                      {status === 'Draft' && (
                        <span className="text-xs text-slate-400">Not sent yet</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-slate-300 group-hover:text-slate-400 transition-colors" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="py-12 text-center text-sm text-slate-400">No invoices</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
