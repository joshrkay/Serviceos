import { useState } from 'react';
import {
  Plus, Send, Pencil, ChevronRight, Clock, ArrowLeft, Check,
  Eye, FileText, X, Trash2, TrendingUp, AlertTriangle, Info,
  CheckCircle2, Copy, Phone, Mail, Sparkles,
} from 'lucide-react';
import { estimates, customers, calcEstimateTotal } from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';
import type { EstimateStatus, Estimate } from '../../data/mock-data';
import { NewEstimateFlow } from './NewEstimateFlow';
import { ConvertToInvoiceSheet } from './ConvertToInvoiceSheet';

type LineItem = { description: string; qty: number; rate: number };

// ─── Pricing Suggestions (mock AI) ───────────────────────────────────────
const PRICING_HINTS: Record<string, Array<{ id: string; type: 'ok' | 'tip' | 'warn'; text: string; action?: string }>> = {
  e1: [
    { id: 'e1-s1', type: 'ok',   text: 'Labor rate ($650/day) is competitive for Austin exterior painting' },
    { id: 'e1-s2', type: 'tip',  text: 'Consider adding a surface repair contingency line (+$150–200)', action: 'Add line' },
    { id: 'e1-s3', type: 'warn', text: '4 gal of paint at 2,400 sq ft may run tight — 5 gal recommended', action: 'Adjust qty' },
  ],
  e2: [
    { id: 'e2-s1', type: 'ok',  text: 'Carrier 4-ton unit pricing ($2,800) is within current wholesale range' },
    { id: 'e2-s2', type: 'tip', text: 'Installation labor at $950 is below Austin market ($1,100–$1,400)', action: 'Adjust rate' },
    { id: 'e2-s3', type: 'tip', text: 'Add 1-year parts & labor warranty (+$250 typical)', action: 'Add line' },
  ],
  e3: [
    { id: 'e3-s1', type: 'ok', text: 'Carrier 3.5-ton unit at $2,200 is competitive' },
    { id: 'e3-s2', type: 'ok', text: 'Installation labor at $850 is within Austin market range' },
  ],
  e4: [
    { id: 'e4-s1', type: 'ok',  text: 'Drain cleaning at $120/drain is within Austin service range' },
    { id: 'e4-s2', type: 'tip', text: 'Consider adding a service-call base fee (+$65–85)', action: 'Add line' },
  ],
  e5: [
    { id: 'e5-s1', type: 'ok',  text: 'Nest thermostat install price ($220) is standard for Austin' },
    { id: 'e5-s2', type: 'tip', text: 'Refrigerant top-off at $85/unit may not cover a full charge — check qty', action: 'Check qty' },
  ],
};

const HINT_STYLE = {
  ok:   { bg: 'bg-green-50  border-green-200',  icon: 'text-green-600',  dot: 'bg-green-500'  },
  tip:  { bg: 'bg-blue-50   border-blue-200',   icon: 'text-blue-600',   dot: 'bg-blue-500'   },
  warn: { bg: 'bg-amber-50  border-amber-200',  icon: 'text-amber-600',  dot: 'bg-amber-500'  },
};
const HINT_ICON = { ok: CheckCircle2, tip: TrendingUp, warn: AlertTriangle };

// ─── Approval Stepper ─────────────────────────────────────────────────────
function ApprovalStepper({ est }: { est: Estimate }) {
  const steps = [
    { label: 'Created', date: est.createdDate,  done: true },
    { label: 'Sent',    date: est.sentDate,     done: !!est.sentDate },
    { label: 'Viewed',  date: est.viewedDate,   done: !!est.viewedDate },
    { label: 'Approved',date: est.approvedDate, done: est.status === 'Approved' },
  ];
  const currentIdx = steps.reduce((last, s, i) => s.done ? i : last, 0);

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
      <p className="text-xs text-slate-400 mb-3">Approval tracking</p>
      <div className="relative flex items-start">
        <div className="absolute top-3 left-3 right-3 h-px bg-slate-200 z-0" />
        <div
          className="absolute top-3 left-3 h-px bg-blue-400 z-0 transition-all"
          style={{ width: `${(currentIdx / (steps.length - 1)) * 100}%`, maxWidth: 'calc(100% - 24px)' }}
        />
        {steps.map((step, i) => (
          <div key={step.label} className="flex-1 flex flex-col items-center relative z-10">
            <div className={`flex size-6 items-center justify-center rounded-full border-2 transition-all ${
              step.done
                ? 'bg-blue-600 border-blue-600'
                : i === currentIdx + 1
                ? 'bg-white border-blue-400'
                : 'bg-white border-slate-200'
            }`}>
              {step.done && <Check size={12} className="text-white" />}
            </div>
            <p className="text-xs text-slate-600 mt-1.5 text-center" style={{ fontSize: 10 }}>{step.label}</p>
            {step.date && (
              <p className="text-center text-slate-400 mt-0.5" style={{ fontSize: 9 }}>{step.date}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI Pricing Suggestions ───────────────────────────────────────────────
function AIPricingSuggestions({ estimateId, onAddLine }: { estimateId: string; onAddLine?: () => void }) {
  const hints = PRICING_HINTS[estimateId] ?? [];
  if (!hints.length) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Sparkles size={13} className="text-indigo-500" />
        <p className="text-sm text-slate-700">Pricing review</p>
        <span className="ml-auto text-xs text-slate-400">AI analysis</span>
      </div>
      <div className="flex flex-col divide-y divide-slate-50">
        {hints.map(h => {
          const style = HINT_STYLE[h.type];
          const Icon  = HINT_ICON[h.type];
          return (
            <div key={h.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full mt-0.5 ${style.bg.split(' ')[0]}`}>
                <Icon size={11} className={style.icon} />
              </span>
              <p className="flex-1 text-sm text-slate-700 leading-snug">{h.text}</p>
              {h.action && (
                <button
                  onClick={h.action === 'Add line' ? onAddLine : undefined}
                  className="shrink-0 text-xs text-blue-600 hover:text-blue-700 hover:underline transition-colors"
                >
                  {h.action}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Line Items Editor ────────────────────────────────────────────────────
function LineItemsEditor({ items, editable, onChange, onAddRow }: {
  items: LineItem[]; editable: boolean;
  onChange?: (items: LineItem[]) => void;
  onAddRow?: () => void;
}) {
  const [editing, setEditing]   = useState(false);
  const [draft,   setDraft]     = useState<LineItem[]>(items);
  const total                   = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const draftTotal              = draft.reduce((s, i) => s + i.qty * i.rate, 0);

  function update(idx: number, field: keyof LineItem, val: string) {
    setDraft(prev => prev.map((item, i) =>
      i === idx ? { ...item, [field]: field === 'description' ? val : parseFloat(val) || 0 } : item
    ));
  }
  function addRow()          { setDraft(prev => [...prev, { description: '', qty: 1, rate: 0 }]); }
  function removeRow(i: number) { setDraft(prev => prev.filter((_, j) => j !== i)); }

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

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_52px_80px_80px] gap-x-2 px-4 py-2 bg-slate-50 border-b border-slate-100">
        <p className="text-xs text-slate-400">Description</p>
        <p className="text-xs text-slate-400 text-right">Qty</p>
        <p className="text-xs text-slate-400 text-right">Rate</p>
        <p className="text-xs text-slate-400 text-right">Total</p>
      </div>

      {/* Rows */}
      <div className="divide-y divide-slate-50">
        {(editing ? draft : items).map((item, i) => (
          <div key={i} className={`grid gap-x-2 px-4 py-2.5 items-center ${editing ? 'grid-cols-[1fr_52px_80px_80px_20px]' : 'grid-cols-[1fr_52px_80px_80px]'}`}>
            {editing ? (
              <>
                <input
                  value={item.description}
                  onChange={e => update(i, 'description', e.target.value)}
                  className="text-sm text-slate-800 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 w-full"
                  placeholder="Description"
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
                <div className="min-w-0">
                  <p className="text-sm text-slate-800 truncate">{item.description}</p>
                </div>
                <p className="text-sm text-slate-500 text-right">{item.qty}</p>
                <p className="text-sm text-slate-500 text-right">${item.rate.toLocaleString()}</p>
                <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toLocaleString()}</p>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Add row (edit mode) */}
      {editing && (
        <button
          onClick={addRow}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50/50 w-full transition-colors border-t border-slate-50"
        >
          <Plus size={11} /> Add line item
        </button>
      )}

      {/* Totals */}
      <div className="px-4 py-3.5 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
        <p className="text-sm text-slate-600">Total</p>
        <p className="text-sm text-slate-900">${(editing ? draftTotal : total).toLocaleString()}</p>
      </div>

      {/* Edit actions */}
      {editing && (
        <div className="flex gap-2 px-4 py-3 border-t border-slate-100 bg-white">
          <button
            onClick={save}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 text-white py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            <Check size={13} /> Save changes
          </button>
          <button
            onClick={cancel}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Document Preview Modal ───────────────────────────────────────────────
function EstimateDocPreview({ est, lineItems, onClose }: {
  est: Estimate; lineItems: LineItem[]; onClose: () => void;
}) {
  const customer = customers.find(c => c.id === est.customerId);
  const total    = lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const [copied, setCopied] = useState(false);
  const link = `fieldly.app/e/${est.estimateNumber.toLowerCase().replace('-', '')}`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <p className="text-sm text-slate-700">Customer preview</p>
            <p className="text-xs text-slate-400">What {est.customer.split(' ')[0]} sees when they open the link</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        {/* Document body */}
        <div className="p-5">
          {/* Business header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="flex size-8 items-center justify-center rounded-lg bg-slate-900 text-white" style={{ fontSize: 12 }}>F</div>
                <p className="text-sm text-slate-900">Fieldly Pro Services</p>
              </div>
              <p className="text-xs text-slate-400">Austin, TX · (512) 555-0000</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400">Estimate</p>
              <p className="text-sm text-slate-900">{est.estimateNumber}</p>
              {est.validUntil && <p className="text-xs text-slate-400 mt-0.5">Valid until {est.validUntil}</p>}
            </div>
          </div>

          {/* Bill to */}
          <div className="mb-5">
            <p className="text-xs text-slate-400 mb-1">Prepared for</p>
            <p className="text-sm text-slate-900">{customer?.name ?? est.customer}</p>
            <p className="text-xs text-slate-500">{customer?.address}</p>
          </div>

          <p className="text-xs text-slate-600 mb-4 italic">{est.description}</p>

          {/* Line items table */}
          <div className="rounded-xl border border-slate-100 overflow-hidden mb-4">
            <div className="grid grid-cols-[1fr_32px_72px_72px] gap-x-2 px-3 py-2 bg-slate-50">
              <p className="text-xs text-slate-400">Description</p>
              <p className="text-xs text-slate-400 text-right">Qty</p>
              <p className="text-xs text-slate-400 text-right">Rate</p>
              <p className="text-xs text-slate-400 text-right">Total</p>
            </div>
            <div className="divide-y divide-slate-50">
              {lineItems.map((item, i) => (
                <div key={i} className="grid grid-cols-[1fr_32px_72px_72px] gap-x-2 px-3 py-2.5 items-center">
                  <p className="text-sm text-slate-700">{item.description}</p>
                  <p className="text-sm text-slate-500 text-right">{item.qty}</p>
                  <p className="text-sm text-slate-500 text-right">${item.rate.toLocaleString()}</p>
                  <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toLocaleString()}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Total */}
          <div className="flex items-center justify-between px-3 py-3 rounded-xl bg-slate-900 text-white mb-5">
            <p className="text-sm">Total</p>
            <p className="text-sm">${total.toLocaleString()}</p>
          </div>

          {/* CTA */}
          <div className="rounded-xl bg-blue-600 px-4 py-4 text-center mb-4">
            <p className="text-white text-sm">Accept this estimate</p>
            <p className="text-white/60 text-xs mt-0.5">{link}</p>
          </div>

          {/* Link copy */}
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5">
            <p className="flex-1 text-xs text-slate-500 truncate">{link}</p>
            <button
              onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors shrink-0"
            >
              {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Send Estimate Sheet ──────────────────────────────────────────────────
function SendEstimateSheet({ est, total, onClose, onSent }: {
  est: Estimate; total: number; onClose: () => void; onSent: () => void;
}) {
  const customer = customers.find(c => c.id === est.customerId);
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);

  const smsMsg = `Hi ${customer?.name.split(' ')[0] ?? 'there'},\n\nI've prepared an estimate for ${est.description}.\n\nTotal: $${total.toLocaleString()}\n\nReview and approve here:\nfieldly.app/e/${est.estimateNumber.toLowerCase().replace('-','')}\n\nQuestions? Call (512) 555-0000.\n– Mike from Fieldly Pro`;
  const emailMsg = `Hi ${customer?.name.split(' ')[0] ?? 'there'},\n\nPlease find your estimate attached below.\n\nEstimate: ${est.estimateNumber}\nDescription: ${est.description}\nTotal: $${total.toLocaleString()}\n\nClick the button below to review and accept.\n\nThank you,\nMike\nFieldly Pro Services`;

  const [msg, setMsg] = useState(smsMsg);

  function handleSend() {
    setSending(true);
    setTimeout(() => { setSending(false); setSent(true); setTimeout(() => { onSent(); onClose(); }, 1200); }, 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-white rounded-t-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <p className="text-sm text-slate-900">Send estimate</p>
            <p className="text-xs text-slate-400">{est.estimateNumber} · {est.customer}</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Estimate summary */}
          <div className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm text-slate-800">{est.description}</p>
              <p className="text-xs text-slate-400">{est.estimateNumber} · {est.lineItems.length} line items</p>
            </div>
            <p className="text-sm text-slate-900">${total.toLocaleString()}</p>
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
                  {c === 'sms' ? <><Phone size={13} /> SMS</> : <><Mail size={13} /> Email</>}
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
              rows={channel === 'sms' ? 7 : 9}
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 bg-white resize-none leading-relaxed"
            />
          </div>

          {/* Valid until */}
          {est.validUntil && (
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <Clock size={11} /> Estimate valid until {est.validUntil}
            </p>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={sending || sent}
            className={`flex items-center justify-center gap-2 w-full rounded-xl py-3.5 text-sm transition-all ${
              sent    ? 'bg-green-600 text-white' :
              sending ? 'bg-blue-400  text-white' :
                        'bg-blue-600  text-white hover:bg-blue-700'
            }`}
          >
            {sent ? <><Check size={15} /> Sent!</> : sending ? 'Sending…' : <><Send size={15} /> Send estimate</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Estimate Detail ──────────────────────────────────────────────────────
function EstimateDetail({ estimate: est, onBack }: { estimate: Estimate; onBack: () => void }) {
  const [lineItems,    setLineItems]    = useState<LineItem[]>(est.lineItems);
  const [sendOpen,     setSendOpen]     = useState(false);
  const [previewOpen,  setPreviewOpen]  = useState(false);
  const [wasSent,      setWasSent]      = useState(false);
  const [convertOpen,  setConvertOpen]  = useState(false);

  const total    = lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const customer = customers.find(c => c.id === est.customerId);
  const status   = wasSent ? 'Sent' : est.status;
  const editable = status === 'Draft';

  return (
    <>
      <div className="h-full overflow-y-auto pb-24 md:pb-6">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6">
          {/* Back */}
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors mb-5">
            <ArrowLeft size={14} /> Back to Estimates
          </button>

          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>{est.customer}</h1>
              <p className="text-sm text-slate-400 mt-0.5">{est.estimateNumber} · {est.description}</p>
              {est.validUntil && (
                <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                  <Clock size={10} /> Valid until {est.validUntil}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge status={status} />
              <p className="text-sm text-slate-900">${total.toLocaleString()}</p>
            </div>
          </div>

          {/* Desktop 2-col / Mobile single col */}
          <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_320px] md:gap-6 md:items-start">

            {/* ── Left column ── */}
            <div className="flex flex-col gap-4">
              <LineItemsEditor
                items={lineItems}
                editable={editable}
                onChange={setLineItems}
              />
              <AIPricingSuggestions estimateId={est.id} />
            </div>

            {/* ── Right rail ── */}
            <div className="flex flex-col gap-4">
              <ApprovalStepper est={est} />

              {/* Customer card */}
              {customer && (
                <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
                  <p className="text-xs text-slate-400 mb-2">Customer</p>
                  <p className="text-sm text-slate-900">{customer.name}</p>
                  <div className="flex flex-col gap-1.5 mt-2">
                    <a href={`tel:${customer.phone}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-green-700 transition-colors">
                      <Phone size={11} /> {customer.phone}
                    </a>
                    <a href={`mailto:${customer.email}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-700 transition-colors">
                      <Mail size={11} /> {customer.email}
                    </a>
                  </div>
                </div>
              )}

              {/* Price summary */}
              <div className="rounded-xl bg-slate-900 text-white px-4 py-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm text-white/60">Estimate total</p>
                  <p className="text-sm text-white/60">{lineItems.length} items</p>
                </div>
                <p className="text-3xl text-white mb-1">${total.toLocaleString()}</p>
                {est.validUntil && <p className="text-xs text-white/40">Valid until {est.validUntil}</p>}
              </div>

              {/* Action buttons */}
              <div className="flex flex-col gap-2">
                {(status === 'Draft' || status === 'Sent' || status === 'Viewed') && (
                  <button
                    onClick={() => setSendOpen(true)}
                    className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 text-white py-3 text-sm hover:bg-blue-700 transition-colors"
                  >
                    <Send size={14} />
                    {status === 'Draft' ? 'Send to customer' :
                     status === 'Sent'  ? 'Send follow-up'   : 'Send reminder'}
                  </button>
                )}
                {status === 'Approved' && (
                  <button
                    onClick={() => setConvertOpen(true)}
                    className="flex items-center justify-center gap-2 rounded-xl bg-green-600 text-white py-3 text-sm hover:bg-green-700 transition-colors"
                  >
                    <FileText size={14} /> Convert to invoice
                  </button>
                )}
                <button
                  onClick={() => setPreviewOpen(true)}
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors"
                >
                  <Eye size={14} /> Preview document
                </button>
              </div>

              {/* Follow-up note for viewed/sent */}
              {(status === 'Sent' || status === 'Viewed') && (
                <div className={`rounded-xl border px-4 py-3 ${status === 'Viewed' ? 'bg-violet-50 border-violet-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {status === 'Viewed' ? <Eye size={12} className="text-violet-600" /> : <Clock size={12} className="text-amber-600" />}
                    <p className={`text-xs ${status === 'Viewed' ? 'text-violet-700' : 'text-amber-700'}`}>
                      {status === 'Viewed' ? `${est.customer.split(' ')[0]} viewed this estimate` : 'Awaiting customer review'}
                    </p>
                  </div>
                  <p className={`text-xs ${status === 'Viewed' ? 'text-violet-600' : 'text-amber-600'}`}>
                    {status === 'Viewed' ? `Viewed ${est.viewedDate} — follow up if they have questions` : `Sent ${est.sentDate}`}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {sendOpen && (
        <SendEstimateSheet
          est={est}
          total={total}
          onClose={() => setSendOpen(false)}
          onSent={() => setWasSent(true)}
        />
      )}
      {previewOpen && (
        <EstimateDocPreview
          est={est}
          lineItems={lineItems}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {convertOpen && (
        <ConvertToInvoiceSheet
          est={est}
          onClose={() => setConvertOpen(false)}
          onConverted={() => setConvertOpen(false)}
        />
      )}
    </>
  );
}

// ─── Estimates List ───────────────────────────────────────────────────────
const TABS: { label: string; value: EstimateStatus | 'All' }[] = [
  { label: 'All',      value: 'All'      },
  { label: 'Draft',    value: 'Draft'    },
  { label: 'Sent',     value: 'Sent'     },
  { label: 'Viewed',   value: 'Viewed'   },
  { label: 'Approved', value: 'Approved' },
];

export function EstimatesPage() {
  const [tab,              setTab]           = useState<EstimateStatus | 'All'>('All');
  const [selected,         setSelected]      = useState<string | null>(null);
  const [newEstimateOpen,  setNewEstimate]   = useState(false);

  const filtered = estimates.filter(e => tab === 'All' || e.status === tab);
  const estimate = estimates.find(e => e.id === selected);

  if (selected && estimate) {
    return <EstimateDetail estimate={estimate} onBack={() => setSelected(null)} />;
  }

  const pendingCount = estimates.filter(e => e.status === 'Sent' || e.status === 'Viewed').length;
  const approvedCount = estimates.filter(e => e.status === 'Approved').length;
  const totalValue = estimates.reduce((s, e) => s + calcEstimateTotal(e), 0);

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="px-4 md:px-6 py-4 md:py-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-slate-900">Estimates</h1>
          <button
            onClick={() => setNewEstimate(true)}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            <Plus size={14} /> New estimate
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: 'Pending review', value: pendingCount,           color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100' },
            { label: 'Approved',       value: approvedCount,          color: 'text-green-700', bg: 'bg-green-50 border-green-100' },
            { label: 'Total value',    value: `$${totalValue.toLocaleString()}`, color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-100'  },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border px-3 py-3 ${bg}`}>
              <p className={`text-xs mb-0.5 ${color}`}>{label}</p>
              <p className={`text-sm ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* List */}
        <div className="flex flex-col gap-2">
          {filtered.map(est => {
            const total = calcEstimateTotal(est);
            return (
              <button
                key={est.id}
                onClick={() => setSelected(est.id)}
                className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-4 text-left hover:border-slate-300 hover:shadow-sm transition-all group"
              >
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
                  est.status === 'Approved' ? 'bg-green-50' :
                  est.status === 'Viewed'   ? 'bg-violet-50' :
                  est.status === 'Sent'     ? 'bg-blue-50' : 'bg-slate-100'
                }`}>
                  <FileText size={16} className={
                    est.status === 'Approved' ? 'text-green-500' :
                    est.status === 'Viewed'   ? 'text-violet-500' :
                    est.status === 'Sent'     ? 'text-blue-500' : 'text-slate-400'
                  } />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900">{est.customer}</p>
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{est.estimateNumber} · {est.description}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <p className="text-sm text-slate-800">${total.toLocaleString()}</p>
                      <StatusBadge status={est.status} size="sm" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="flex items-center gap-1 text-xs text-slate-400">
                      <Clock size={10} /> {est.createdDate}
                    </span>
                    {est.sentDate && (
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Send size={10} /> Sent {est.sentDate}
                      </span>
                    )}
                    {est.viewedDate && (
                      <span className="flex items-center gap-1 text-xs text-violet-500">
                        <Eye size={10} /> Viewed {est.viewedDate}
                      </span>
                    )}
                    {est.approvedDate && (
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <Check size={10} /> Approved {est.approvedDate}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={14} className="shrink-0 text-slate-300 group-hover:text-slate-400 transition-colors" />
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-12 text-center text-sm text-slate-400">No estimates</p>
          )}
        </div>
      </div>
      {newEstimateOpen && (
        <NewEstimateFlow
          onClose={() => setNewEstimate(false)}
          onCreated={() => setNewEstimate(false)}
        />
      )}
    </div>
  );
}