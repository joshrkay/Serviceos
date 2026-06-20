import { useState, useEffect } from 'react';
import {
  Plus, Send, Pencil, ChevronRight, Clock, ArrowLeft, Check,
  Eye, FileText, X, Trash2, TrendingUp, AlertTriangle,
  CheckCircle2, Copy, Phone, Mail, Sparkles, MessageSquare,
  Briefcase, MapPin, RotateCcw, Download,
} from 'lucide-react';
import type { EstimateResponse, LineItem as EstimateLineItem } from '@ai-service-os/shared';
import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { apiFetch } from '../../utils/api-fetch';
import { printEstimateDocument } from '../../lib/estimatePdf';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateInTenantTz, formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';
import { normalizeEstimateStatus, centsToDisplay } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { NewEstimateFlow } from './NewEstimateFlow';
import { ConvertToInvoiceSheet } from './ConvertToInvoiceSheet';
import { ConvertToJobSheet } from './ConvertToJobSheet';
import { AttachmentSection } from '../attachments/AttachmentSection';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

type EstimateStatus = 'Draft' | 'Sent' | 'Viewed' | 'Approved' | 'Declined' | 'Expired';

interface EstCompat {
  id: string;
  estimateNumber: string;
  customer: string;
  customerId: string;
  description: string;
  lineItems: LineItem[];
  status: EstimateStatus;
  createdDate: string;
  sentDate?: string;
  viewedDate?: string;
  approvedDate?: string;
  validUntil?: string;
}

/** Convert a shared line item to UI LineItem for the editor */
function apiLineToUi(item: EstimateLineItem): LineItem {
  return {
    id: item.id,
    description: item.description,
    qty: item.quantity,
    rate: item.unitPriceCents / 100,
    taxable: item.taxable,
    // Preserve good-better-best metadata so an inline edit + save doesn't
    // strip the tier/add-on structure the customer approves against.
    groupKey: item.groupKey,
    groupLabel: item.groupLabel,
    isOptional: item.isOptional,
    isDefaultSelected: item.isDefaultSelected,
  };
}

/** Convert UI LineItem back to a shared line item for saving */
function uiLineToApi(item: LineItem, sortOrder: number): Partial<EstimateLineItem> {
  return {
    ...(item.id ? { id: item.id } : {}),
    description: item.description,
    quantity: item.qty,
    unitPriceCents: Math.round(item.rate * 100),
    totalCents: Math.round(item.qty * item.rate * 100),
    sortOrder,
    taxable: item.taxable ?? false,
    groupKey: item.groupKey,
    groupLabel: item.groupLabel,
    isOptional: item.isOptional,
    isDefaultSelected: item.isDefaultSelected,
  };
}

type LineItem = {
  id?: string;
  description: string;
  qty: number;
  rate: number;
  taxable?: boolean;
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
};

// ─── AI suggestion types ──────────────────────────────────────────────────
interface AISuggestion {
  id: string;
  type: 'ok' | 'tip' | 'warn';
  text: string;
  /** If present, "Accept" will append this line item to the estimate */
  lineItem?: { description: string; qty: number; rate: number };
}

/** Generate context-aware AI suggestions from actual line items */
function deriveAISuggestions(items: LineItem[]): AISuggestion[] {
  const text = items.map(i => i.description.toLowerCase()).join(' ');
  const total = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const suggestions: AISuggestion[] = [];

  const hasLabor = /labor|labour|hrs|hours|install/i.test(text);
  const hasHVAC  = /hvac|ac|condenser|refrigerant|furnace|thermostat|capacitor/i.test(text);
  const hasPlumb = /drain|pipe|faucet|heater|plumb|clog/i.test(text);
  const hasPaint = /paint|primer|coat|wall|exterior|interior/i.test(text);

  if (hasHVAC) {
    if (!hasLabor) {
      suggestions.push({ id: 'ai-hvac-labor', type: 'tip',
        text: 'No labor line item detected — typical HVAC jobs include 2–4 hours at $95/hr',
        lineItem: { description: 'Labor – 2 hrs', qty: 2, rate: 95 } });
    } else {
      suggestions.push({ id: 'ai-hvac-labor-ok', type: 'ok',
        text: 'Labor line detected — verify hours match job complexity' });
    }
    if (/capacitor/i.test(text)) {
      suggestions.push({ id: 'ai-cap-ok', type: 'ok',
        text: 'Capacitor replacement pricing ($25–45) is in the standard Austin range' });
      if (!/diagnostic|service.?call/i.test(text)) {
        suggestions.push({ id: 'ai-diag', type: 'tip',
          text: 'Add a diagnostic fee — covers assessment if customer declines repair',
          lineItem: { description: 'Diagnostic fee', qty: 1, rate: 85 } });
      }
    }
    if (/refrigerant/i.test(text)) {
      suggestions.push({ id: 'ai-refrig', type: 'warn',
        text: 'Confirm R-410A charge amount — full recharge requires 2–4 lbs depending on system size' });
    }
  }

  if (hasPlumb) {
    if (!hasLabor) {
      suggestions.push({ id: 'ai-plumb-labor', type: 'tip',
        text: 'No labor line item — plumbing repairs typically include 1–2 hours at $110/hr',
        lineItem: { description: 'Labor – 2 hrs', qty: 2, rate: 110 } });
    } else {
      suggestions.push({ id: 'ai-plumb-labor-ok', type: 'ok',
        text: 'Labor line detected — confirm hours match drain or pipe complexity' });
    }
  }

  if (hasPaint) {
    if (!hasLabor) {
      suggestions.push({ id: 'ai-paint-labor', type: 'tip',
        text: 'No labor line — painting projects typically bill by full day ($650) or half day ($350)',
        lineItem: { description: 'Labor – 2 hrs', qty: 2, rate: 95 } });
    }
    if (/exterior/i.test(text) && !/power.?wash|wash/i.test(text)) {
      suggestions.push({ id: 'ai-wash', type: 'tip',
        text: 'Exterior jobs typically require power washing before painting',
        lineItem: { description: 'Power wash & surface prep', qty: 1, rate: 180 } });
    }
  }

  if (!hasHVAC && !hasPlumb && !hasPaint && items.length > 0) {
    if (!hasLabor) {
      suggestions.push({ id: 'ai-generic-labor', type: 'tip',
        text: 'Consider adding a labor line item to account for technician time',
        lineItem: { description: 'Labor – 2 hrs', qty: 2, rate: 95 } });
    }
    if (total > 0) {
      suggestions.push({ id: 'ai-generic-ok', type: 'ok',
        text: `Estimate total $${total.toFixed(2)} — verify line items match the approved scope` });
    }
  }

  return suggestions;
}

const HINT_STYLE = {
  ok:   { bg: 'bg-green-50  border-green-200',  icon: 'text-green-600',  dot: 'bg-green-500'  },
  tip:  { bg: 'bg-blue-50   border-blue-200',   icon: 'text-blue-600',   dot: 'bg-blue-500'   },
  warn: { bg: 'bg-amber-50  border-amber-200',  icon: 'text-amber-600',  dot: 'bg-amber-500'  },
};
const HINT_ICON = { ok: CheckCircle2, tip: TrendingUp, warn: AlertTriangle };

// ─── Approval Stepper ─────────────────────────────────────────────────────
function ApprovalStepper({ est }: { est: EstCompat }) {
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
function AIPricingSuggestions({ estimateId, items, onLineItemAccepted }: {
  estimateId: string;
  items: LineItem[];
  onLineItemAccepted?: (item: LineItem) => void;
}) {
  const [triggered, setTriggered] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [hints, setHints]         = useState<AISuggestion[]>([]);
  const [accepted, setAccepted]   = useState<Set<string>>(new Set());
  const [accepting, setAccepting] = useState<string | null>(null);

  async function triggerSuggestions() {
    setLoading(true);
    setTriggered(true);
    // Simulate brief AI processing delay, then derive suggestions from line items
    await new Promise(r => setTimeout(r, 1200));
    setHints(deriveAISuggestions(items));
    setLoading(false);
  }

  async function acceptSuggestion(hint: AISuggestion) {
    if (!hint.lineItem) return;
    setAccepting(hint.id);
    try {
      // estimate_line_items.id is a UUID; the pg repo wipes-and-reinserts on
      // update, so generating fresh UUIDs (instead of synthetic "li-..." ids)
      // keeps the PATCH payload valid against the Postgres schema.
      const newItem = {
        description: hint.lineItem.description,
        quantity: hint.lineItem.qty,
        unitPriceCents: Math.round(hint.lineItem.rate * 100),
        totalCents: Math.round(hint.lineItem.qty * hint.lineItem.rate * 100),
        sortOrder: items.length,
        taxable: false,
        id: crypto.randomUUID(),
      };
      const res = await apiFetch(`/api/estimates/${estimateId}`, {
        method: 'PATCH',
        body: JSON.stringify({ lineItems: [
          ...items.map((item, i) => ({
            description: item.description,
            quantity: item.qty,
            unitPriceCents: Math.round(item.rate * 100),
            totalCents: Math.round(item.qty * item.rate * 100),
            sortOrder: i,
            taxable: false,
            id: crypto.randomUUID(),
          })),
          newItem,
        ]}),
      });
      if (res.ok) {
        setAccepted(prev => new Set([...prev, hint.id]));
        onLineItemAccepted?.(hint.lineItem!);
      }
    } finally {
      setAccepting(null);
    }
  }

  if (!triggered) {
    return (
      <button
        onClick={triggerSuggestions}
        className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 hover:bg-indigo-100 transition-colors w-full"
      >
        <Sparkles size={13} className="text-indigo-500 shrink-0" />
        Get AI line-item suggestions
        <span className="ml-auto text-xs text-indigo-400">~5s</span>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <Sparkles size={13} className="text-indigo-500 animate-pulse shrink-0" />
        <p className="text-sm text-indigo-700">Analyzing line items…</p>
      </div>
    );
  }

  if (!hints.length) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Sparkles size={13} className="text-indigo-500" />
        <p className="text-sm text-slate-700">AI pricing suggestions</p>
        <span className="ml-auto text-xs text-slate-400">{hints.length} suggestions</span>
      </div>
      <div className="flex flex-col divide-y divide-slate-50">
        {hints.map(h => {
          const style = HINT_STYLE[h.type];
          const Icon  = HINT_ICON[h.type];
          const isAccepted = accepted.has(h.id);
          const isAccepting = accepting === h.id;
          return (
            <div key={h.id} className={`flex items-start gap-3 px-4 py-3 ${isAccepted ? 'opacity-50' : ''}`}>
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full mt-0.5 ${style.bg.split(' ')[0]}`}>
                <Icon size={11} className={style.icon} />
              </span>
              <p className="flex-1 text-sm text-slate-700 leading-snug">{h.text}</p>
              {h.lineItem && !isAccepted && (
                <button
                  onClick={() => acceptSuggestion(h)}
                  disabled={isAccepting}
                  className="shrink-0 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-1 hover:bg-green-100 transition-colors disabled:opacity-50"
                >
                  {isAccepting ? '…' : `+ ${h.lineItem.description}`}
                </button>
              )}
              {isAccepted && (
                <span className="shrink-0 text-xs text-green-600 flex items-center gap-1">
                  <Check size={10} /> Added
                </span>
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
  est: EstCompat; lineItems: LineItem[]; onClose: () => void;
}) {
  const total    = lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const [copied, setCopied] = useState(false);
  const link = `rivet.ai/e/${est.estimateNumber.toLowerCase().replace('-', '')}`;

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
          <div className="flex items-center gap-1">
            <button
              onClick={() => printEstimateDocument({
                estimateNumber: est.estimateNumber,
                customerName: est.customer,
                businessName: 'Rivet Pro Services',
                businessContact: 'Austin, TX · (512) 555-0000',
                description: est.description,
                validUntil: est.validUntil,
                lineItems: lineItems.map((i) => ({ description: i.description, qty: i.qty, rate: i.rate })),
              })}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <Download size={12} /> PDF
            </button>
            <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
              <X size={15} className="text-slate-500" />
            </button>
          </div>
        </div>

        {/* Document body */}
        <div className="p-5">
          {/* Business header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="flex size-8 items-center justify-center rounded-lg bg-slate-900 text-white" style={{ fontSize: 12 }}>F</div>
                <p className="text-sm text-slate-900">Rivet Pro Services</p>
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
            <p className="text-sm text-slate-900">{est.customer}</p>
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
function SendEstimateSheet({ est, total, onClose, onSent, apiId }: {
  est: EstCompat; total: number; onClose: () => void; onSent: () => void;
  /** When set, the sheet calls the real /api/estimates/:id/send endpoint. */
  apiId?: string;
}) {
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [recipient, setRecipient] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [msg, setMsg] = useState('');

  type SendBody = {
    channel: 'sms' | 'email';
    recipientPhone?: string;
    recipientEmail?: string;
    customMessage?: string;
  };
  type SendResp = { viewUrl: string; viewToken: string };
  const { mutate: sendEstimate } = useMutation<SendBody, SendResp>(
    'POST',
    apiId ? `/api/estimates/${apiId}/send` : '/api/estimates/_/send'
  );

  async function handleSend() {
    setSending(true);
    setSendError(null);
    try {
      if (apiId) {
        await sendEstimate({
          channel,
          recipientPhone: channel === 'sms' ? recipient : undefined,
          recipientEmail: channel === 'email' ? recipient : undefined,
          customMessage: msg,
        });
      } else {
        // No API id: fall back to local animation only (used by mock-data screens).
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
                  onClick={() => {
                    setChannel(c);
                    if (c !== channel) setRecipient('');
                  }}
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
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400 bg-white"
            />
          </div>

          {/* Personal note */}
          <div>
            <p className="text-xs text-slate-500 mb-1.5">Personal note <span className="text-slate-400">(optional)</span></p>
            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              rows={3}
              placeholder="Add a personal note to your customer..."
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 bg-white resize-none leading-relaxed"
            />
          </div>

          {/* Valid until */}
          {est.validUntil && (
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <Clock size={11} /> Estimate valid until {est.validUntil}
            </p>
          )}

          {sendError && (
            <p className="text-xs text-red-600 -mt-2">Send failed: {sendError}</p>
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
function EstimateDetail({ estimateId, onBack }: { estimateId: string; onBack: () => void }) {
  const navigate = useNavigate();
  const tz = useTenantTimezone();
  const { data: est, isLoading, error, refetch } = useDetailQuery<EstimateResponse>('/api/estimates', estimateId);
  const { mutate: updateEstimate } = useMutation<Record<string, unknown>, EstimateResponse>('PUT', `/api/estimates/${estimateId}`);
  const { mutate: transitionEstimate } = useMutation<{ status: string }, EstimateResponse>('POST', `/api/estimates/${estimateId}/transition`);

  const [lineItems,    setLineItems]    = useState<LineItem[]>([]);
  const [sendOpen,     setSendOpen]     = useState(false);
  const [previewOpen,  setPreviewOpen]  = useState(false);
  const [wasSent,      setWasSent]      = useState(false);
  const [convertOpen,  setConvertOpen]  = useState(false);
  const [convertJobOpen, setConvertJobOpen] = useState(false);
  const [actionBusy,   setActionBusy]   = useState(false);
  const [actionError,  setActionError]  = useState<string | null>(null);

  async function handleClone() {
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/estimates/${estimateId}/clone`, { method: 'POST' });
      if (!res.ok) throw new Error(`Could not clone estimate (HTTP ${res.status})`);
      const clone = (await res.json()) as { id: string };
      navigate(`/estimates/${clone.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to clone estimate');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this estimate? It will be removed from your list.')) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/estimates/${estimateId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`Could not delete estimate (HTTP ${res.status})`);
      onBack();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete estimate');
      setActionBusy(false);
    }
  }

  async function handleReopen() {
    setActionBusy(true);
    setActionError(null);
    try {
      await transitionEstimate({ status: 'draft' });
      await refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reopen estimate');
    } finally {
      setActionBusy(false);
    }
  }

  // Enriched customer/location from the linked job
  const [enrichedCustomer, setEnrichedCustomer] = useState<{ name: string; id: string; phone?: string; email?: string } | null>(null);
  const [enrichedLocation, setEnrichedLocation] = useState<string | null>(null);

  useEffect(() => {
    if (!est?.jobId) return;
    let cancelled = false;
    apiFetch(`/api/jobs/${est.jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then((job) => {
        if (!job || cancelled) return;
        const cust = job.customer;
        if (cust && job.customerId) {
          const name = cust.displayName || [cust.firstName, cust.lastName].filter(Boolean).join(' ') || 'Customer';
          setEnrichedCustomer({ name, id: job.customerId, phone: cust.primaryPhone, email: cust.email });
        }
        const loc = cust?.locations?.find((l: { id: string }) => l.id === job.locationId);
        if (loc) {
          setEnrichedLocation([loc.street1, loc.city, loc.state].filter(Boolean).join(', '));
        }
      })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [est?.jobId]);

  // Notes
  const [notes, setNotes]       = useState<Array<{ id: string; content: string; createdAt: string }>>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteText,    setNoteText]    = useState('');
  const [savingNote,  setSavingNote]  = useState(false);

  useEffect(() => {
    apiFetch(`/api/notes?entityType=estimate&entityId=${estimateId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Array<{ id: string; content: string; createdAt: string }>) => {
        setNotes(data);
        setNotesLoaded(true);
      })
      .catch(() => setNotesLoaded(true));
  }, [estimateId]);

  async function saveNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      const res = await apiFetch('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ entityType: 'estimate', entityId: estimateId, content: noteText.trim() }),
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

  // Sync lineItems from API data when it loads
  // Once accepted with a good-better-best selection, show only the billed
  // rows so the line items and the total match what the customer agreed to
  // (the estimate keeps every option row underneath for history/clone).
  const acceptedSel = est?.acceptedSelection;
  const apiLineItems = (() => {
    const all = est?.lineItems ?? [];
    if (acceptedSel && acceptedSel.length > 0) {
      return all.filter((li) => li.id && acceptedSel.includes(li.id));
    }
    return all;
  })();
  const uiLineItems = lineItems.length > 0 ? lineItems : apiLineItems.map(apiLineToUi);

  const total    = uiLineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const customer = est?.customer;
  const apiStatus = wasSent ? 'sent' : (est?.status ?? 'draft');
  const status   = normalizeEstimateStatus(apiStatus) as EstimateStatus;
  // Editability follows the RAW status, not the normalized label: the API
  // folds `expired` into the "Draft" label, but the backend blocks edits on
  // expired/rejected. Keying off the raw status avoids offering an edit that
  // would 409. Reopen (rejected/expired -> draft) is the supported path.
  const editable = apiStatus === 'draft' || apiStatus === 'ready_for_review';

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner size="md" className="text-slate-900" label="Loading estimate" />
      </div>
    );
  }

  if (error || !est) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-500">Failed to load estimate</p>
        <button onClick={onBack} className="text-xs text-blue-500 hover:underline">Go back</button>
      </div>
    );
  }

  // Build a mock Estimate-like object for the sub-components that still need it
  const effectiveCustomerName = enrichedCustomer?.name
    ?? (customer ? (customer.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer') : 'Customer');
  const effectiveCustomerId = enrichedCustomer?.id ?? customer?.id ?? '';
  const estCompat = {
    id: est.id,
    estimateNumber: est.estimateNumber,
    customer: effectiveCustomerName,
    customerId: effectiveCustomerId,
    description: est.customerMessage ?? '',
    status,
    lineItems: uiLineItems,
    createdDate: est.createdAt ? formatDateInTenantTz(est.createdAt, tz) : '',
    sentDate: undefined as string | undefined,
    viewedDate: undefined as string | undefined,
    approvedDate: undefined as string | undefined,
    validUntil: est.validUntil,
  };

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
              <h1 className="text-slate-900" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>{estCompat.customer}</h1>
              <p className="text-sm text-slate-400 mt-0.5">{est.estimateNumber} · {estCompat.description}</p>
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
                items={uiLineItems}
                editable={editable}
                onChange={async (items) => {
                  setLineItems(items);
                  try {
                    await updateEstimate(
                      { lineItems: items.map((item, i) => uiLineToApi(item, i)) },
                      // Optimistic concurrency: reject (409) a clobber of a
                      // concurrent edit rather than silently overwriting it.
                      est.version !== undefined ? { headers: { 'If-Match': String(est.version) } } : undefined,
                    );
                  } catch (err) {
                    if ((err as { status?: number }).status === 409) {
                      toast.error('This estimate was changed elsewhere — reloading the latest version.');
                      refetch();
                    } else {
                      throw err;
                    }
                  }
                }}
              />
              <AIPricingSuggestions
                estimateId={est.id}
                items={uiLineItems}
                onLineItemAccepted={(item) => {
                  setLineItems(prev => [...(prev.length ? prev : uiLineItems), item]);
                  refetch();
                }}
              />
              <AttachmentSection entityType="estimate" entityId={estimateId} />

              {/* Notes section */}
              <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
                  <MessageSquare size={13} className="text-slate-400" />
                  <p className="text-sm text-slate-700">Notes</p>
                  <span className="ml-auto text-xs text-slate-400">{notes.length}</span>
                </div>
                {notesLoaded && notes.length > 0 && (
                  <div className="divide-y divide-slate-50">
                    {notes.map(n => (
                      <div key={n.id} className="px-4 py-3">
                        <p className="text-sm text-slate-700 leading-snug">{n.content}</p>
                        <p className="text-xs text-slate-400 mt-1">{formatDateTimeInTenantTz(n.createdAt, tz)}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-4 py-3 border-t border-slate-50 flex flex-col gap-2">
                  <textarea
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    rows={2}
                    placeholder="Add a note…"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400 transition-colors"
                  />
                  <button
                    onClick={saveNote}
                    disabled={savingNote || !noteText.trim()}
                    className="self-end rounded-lg bg-slate-900 text-white text-xs px-3 py-1.5 hover:bg-slate-700 disabled:opacity-50 transition-colors"
                  >
                    {savingNote ? 'Saving…' : 'Save note'}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Right rail ── */}
            <div className="flex flex-col gap-4">
              <ApprovalStepper est={estCompat} />

              {/* Job link */}
              {est.jobId && (
                <button
                  onClick={() => navigate(`/jobs/${est.jobId}`)}
                  className="flex items-center gap-2 rounded-xl bg-white border border-slate-200 px-4 py-3 hover:border-slate-300 hover:bg-slate-50 transition-colors text-left"
                >
                  <Briefcase size={13} className="text-slate-400 shrink-0" />
                  <p className="text-sm text-slate-700 flex-1">View linked job</p>
                  <ChevronRight size={13} className="text-slate-300" />
                </button>
              )}

              {/* Customer card */}
              {(customer || enrichedCustomer) && (
                <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
                  <p className="text-xs text-slate-400 mb-2">Customer</p>
                  <button
                    onClick={() => estCompat.customerId && navigate(`/customers/${estCompat.customerId}`)}
                    className="text-sm text-slate-900 hover:text-blue-600 transition-colors text-left"
                  >
                    {estCompat.customer}
                  </button>
                  {enrichedLocation && (
                    <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                      <MapPin size={10} /> {enrichedLocation}
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5 mt-2">
                    {(enrichedCustomer?.phone ?? customer?.primaryPhone) && (
                      <a href={`tel:${enrichedCustomer?.phone ?? customer?.primaryPhone}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-green-700 transition-colors">
                        <Phone size={11} /> {enrichedCustomer?.phone ?? customer?.primaryPhone}
                      </a>
                    )}
                    {(enrichedCustomer?.email ?? customer?.email) && (
                      <a href={`mailto:${enrichedCustomer?.email ?? customer?.email}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-700 transition-colors">
                        <Mail size={11} /> {enrichedCustomer?.email ?? customer?.email}
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Price summary */}
              <div className="rounded-xl bg-slate-900 text-white px-4 py-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm text-white/60">Estimate total</p>
                  <p className="text-sm text-white/60">{uiLineItems.length} items</p>
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
                {(status === 'Sent' || status === 'Viewed') && est.jobId && (
                  <button
                    onClick={() => setConvertJobOpen(true)}
                    className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-800 transition-colors"
                  >
                    <Briefcase size={14} /> Convert to job
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
                {(est.status === 'rejected' || est.status === 'expired') && (
                  <button
                    onClick={() => void handleReopen()}
                    disabled={actionBusy}
                    className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors disabled:opacity-50"
                  >
                    <RotateCcw size={14} /> Reopen as draft
                  </button>
                )}
                <button
                  onClick={() => setPreviewOpen(true)}
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors"
                >
                  <Eye size={14} /> Preview document
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleClone()}
                    disabled={actionBusy}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-700 py-3 text-sm hover:bg-slate-50 transition-colors disabled:opacity-50"
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  {est.status !== 'accepted' && (
                    <button
                      onClick={() => void handleDelete()}
                      disabled={actionBusy}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-200 bg-white text-red-600 py-3 text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                </div>
                {actionError && <p className="text-xs text-red-600">{actionError}</p>}
              </div>

              {/* Follow-up note for viewed/sent */}
              {(status === 'Sent' || status === 'Viewed') && (
                <div className={`rounded-xl border px-4 py-3 ${status === 'Viewed' ? 'bg-violet-50 border-violet-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {status === 'Viewed' ? <Eye size={12} className="text-violet-600" /> : <Clock size={12} className="text-amber-600" />}
                    <p className={`text-xs ${status === 'Viewed' ? 'text-violet-700' : 'text-amber-700'}`}>
                      {status === 'Viewed' ? `${estCompat.customer.split(' ')[0]} viewed this estimate` : 'Awaiting customer review'}
                    </p>
                  </div>
                  <p className={`text-xs ${status === 'Viewed' ? 'text-violet-600' : 'text-amber-600'}`}>
                    {status === 'Viewed' ? 'Follow up if they have questions' : 'Awaiting response'}
                  </p>
                </div>
              )}

              {(status === 'Expired' || status === 'Declined') && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock size={12} className="text-slate-500" />
                    <p className="text-xs text-slate-600">
                      {status === 'Expired' ? 'This estimate expired' : 'Customer declined this estimate'}
                    </p>
                  </div>
                  <p className="text-xs text-slate-500">
                    Reopen it as a draft to revise and resend.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {sendOpen && (
        <SendEstimateSheet
          est={estCompat}
          total={total}
          apiId={est?.id}
          onClose={() => setSendOpen(false)}
          onSent={async () => {
            setWasSent(true);
            // Backend send route already transitions the estimate to "sent" —
            // skip the redundant transition call here.
          }}
        />
      )}
      {previewOpen && (
        <EstimateDocPreview
          est={estCompat}
          lineItems={uiLineItems}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {convertJobOpen && est && (
        <ConvertToJobSheet
          input={{
            estimateId: est.id,
            estimateNumber: est.estimateNumber,
            customerName: estCompat.customer,
            description: estCompat.description,
          }}
          onClose={() => setConvertJobOpen(false)}
          onConverted={(jobId) => {
            setConvertJobOpen(false);
            navigate(`/jobs/${jobId}`);
          }}
        />
      )}
      {convertOpen && est.jobId && (
        <ConvertToInvoiceSheet
          input={{
            estimateId: est.id,
            jobId: est.jobId,
            estimateNumber: est.estimateNumber,
            customerName: estCompat.customer,
            description: estCompat.description,
            lineItems: uiLineItems,
            discountCents: est.totals.discountCents,
            taxRateBps: 0,
            approvedLabel: status === 'Approved' ? 'Customer approved' : undefined,
          }}
          onClose={() => setConvertOpen(false)}
          onConverted={(invoiceId) => {
            setConvertOpen(false);
            navigate(`/invoices/${invoiceId}`);
          }}
        />
      )}
    </>
  );
}

// ─── API status → UI tab value mapping ───────────────────────────────────
const API_STATUS_FOR_TAB: Record<EstimateStatus | 'All', string[]> = {
  All:      [],
  Draft:    ['draft'],
  Sent:     ['ready_for_review', 'sent'],
  Viewed:   [],
  Approved: ['accepted'],
  Declined: ['rejected'],
  Expired:  ['expired'],
};

// ─── Estimates List ───────────────────────────────────────────────────────
const TABS: { label: string; value: EstimateStatus | 'All' }[] = [
  { label: 'All',      value: 'All'      },
  { label: 'Draft',    value: 'Draft'    },
  { label: 'Sent',     value: 'Sent'     },
  { label: 'Viewed',   value: 'Viewed'   },
  { label: 'Approved', value: 'Approved' },
  { label: 'Declined', value: 'Declined' },
  { label: 'Expired',  value: 'Expired'  },
];

export function EstimatesPage({ defaultSelectedId }: { defaultSelectedId?: string } = {}) {
  const navigate = useNavigate();
  const tz = useTenantTimezone();
  const [tab,              setTab]           = useState<EstimateStatus | 'All'>('All');
  const [selected,         setSelected]      = useState<string | null>(defaultSelectedId ?? null);
  const [newEstimateOpen,  setNewEstimate]   = useState(false);

  // Keep `selected` in sync with the route param so deep-links and in-place
  // route changes (/estimates/:id → /estimates/:other) reopen the right
  // detail view instead of holding onto the previous selection.
  useEffect(() => {
    setSelected(defaultSelectedId ?? null);
  }, [defaultSelectedId]);

  const { data, total, isLoading, error, setFilters, refetch } = useListQuery<EstimateResponse>('/api/estimates');

  if (selected) {
    return <EstimateDetail estimateId={selected} onBack={() => {
      setSelected(null);
      if (defaultSelectedId) navigate('/estimates');
    }} />;
  }

  const normalizedData = data.map(e => ({
    ...e,
    uiStatus: normalizeEstimateStatus(e.status) as EstimateStatus,
  }));

  const filtered = tab === 'All'
    ? normalizedData
    : normalizedData.filter(e => e.uiStatus === tab);

  const pendingCount  = normalizedData.filter(e => e.uiStatus === 'Sent' || e.uiStatus === 'Viewed').length;
  const approvedCount = normalizedData.filter(e => e.uiStatus === 'Approved').length;
  const totalValue    = normalizedData.reduce((s, e) => s + e.totals.totalCents, 0);

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
            { label: 'Pending review', value: pendingCount,                 color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100' },
            { label: 'Approved',       value: approvedCount,                color: 'text-green-700', bg: 'bg-green-50 border-green-100' },
            { label: 'Total value',    value: centsToDisplay(totalValue),   color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-100'   },
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
              onClick={() => {
                setTab(t.value);
                if (t.value !== 'All') {
                  const apiStatuses = API_STATUS_FOR_TAB[t.value];
                  if (apiStatuses.length > 0) setFilters({ status: apiStatuses[0] });
                } else {
                  setFilters({});
                }
              }}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* Loading / Error */}
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="md" className="text-slate-900" label="Loading estimates" />
          </div>
        )}
        {error && (
          <ErrorState message="Failed to load estimates" onRetry={refetch} />
        )}

        {/* List */}
        {!isLoading && !error && (
          <div className="flex flex-col gap-2">
            {filtered.map(est => {
              const status = est.uiStatus;
              const customerName = est.customer
                ? (est.customer.displayName || [est.customer.firstName, est.customer.lastName].filter(Boolean).join(' ') || 'Customer')
                : 'Customer';
              return (
                <button
                  key={est.id}
                  onClick={() => setSelected(est.id)}
                  className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-4 text-left hover:border-slate-300 hover:shadow-sm transition-all group"
                >
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
                    status === 'Approved' ? 'bg-green-50' :
                    status === 'Viewed'   ? 'bg-violet-50' :
                    status === 'Sent'     ? 'bg-blue-50' : 'bg-slate-100'
                  }`}>
                    <FileText size={16} className={
                      status === 'Approved' ? 'text-green-500' :
                      status === 'Viewed'   ? 'text-violet-500' :
                      status === 'Sent'     ? 'text-blue-500' : 'text-slate-400'
                    } />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-900">{customerName}</p>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">{est.estimateNumber}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <p className="text-sm text-slate-800">{centsToDisplay(est.totals.totalCents)}</p>
                        <StatusBadge status={status} size="sm" />
                      </div>
                    </div>
                    {est.createdAt && (
                      <div className="flex items-center gap-3 mt-2">
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          <Clock size={10} /> {formatDateInTenantTz(est.createdAt, tz)}
                        </span>
                      </div>
                    )}
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-slate-300 group-hover:text-slate-400 transition-colors" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <EmptyState title="No estimates" />
            )}
          </div>
        )}
      </div>
      {newEstimateOpen && (
        <NewEstimateFlow
          onClose={() => setNewEstimate(false)}
          onCreated={() => { setNewEstimate(false); refetch(); }}
        />
      )}
    </div>
  );
}
