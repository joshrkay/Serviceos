import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeft, Phone, MessageSquare, Navigation,
  MapPin, AlertCircle, AlertTriangle, Package,
  Play, Video, ChevronLeft, ChevronRight, X, Trash2, ExternalLink,
  Plus, Cpu, Camera, Receipt, Eye, FileText, Mail, Star,
  CheckCircle2, Circle, MoreHorizontal, Zap, Calendar, User, Clock,
  ChevronDown,
} from 'lucide-react';
import { jobs, technicians, customers, calcMaterialsTotal, estimates, calcEstimateTotal } from '../../data/mock-data';
import type { Job, JobActivity, MaterialItem, Customer, Technician } from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';
import { ActivityTimeline } from './ActivityTimeline';
import { AddEntrySheet } from './AddEntrySheet';
import { MaterialsSheet } from './MaterialsSheet';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import { CallScreen, TextSheet, EstimateSheet, InvoiceSheet } from './JobSheets';
import { CameraCapture } from '../shared/CameraCapture';
import type { CapturedMedia } from '../shared/CameraCapture';
import { SuppliersSheet } from './SuppliersSheet';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SERVICE_COLOR: Record<string, { bg: string; text: string }> = {
  HVAC:     { bg: 'bg-blue-100',   text: 'text-blue-700' },
  Plumbing: { bg: 'bg-cyan-100',   text: 'text-cyan-700' },
  Painting: { bg: 'bg-purple-100', text: 'text-purple-700' },
};

type Modal = 'call' | 'text' | 'estimate' | 'invoice' | 'addEntry' | 'materials' | 'cancel' | 'suppliers' | null;

// ─── Status Stepper ────────────────────────────────────────────────────────
const STEPS: { key: string; label: string; short: string }[] = [
  { key: 'Created',     label: 'Created',     short: 'New'    },
  { key: 'Scheduled',   label: 'Scheduled',   short: 'Schd.'  },
  { key: 'Dispatched',  label: 'Dispatched',  short: 'Sent'   },
  { key: 'On Site',     label: 'On Site',     short: 'Site'   },
  { key: 'In Progress', label: 'In Progress', short: 'Active' },
  { key: 'Completed',   label: 'Completed',   short: 'Done'   },
];

function resolveStepIndex(job: Job): number {
  const history = job.statusHistory.map(h => h.status);
  if (history.some(s => s === 'Completed'))                    return 5;
  if (history.some(s => s === 'In Progress' || s === 'Day 2')) return 4;
  if (history.some(s => s === 'On Site' || s === 'Active'))    return 3;
  if (history.some(s => s === 'Dispatched'))                   return 2;
  if (history.some(s => s === 'Scheduled'))                    return 1;
  return 0;
}

function StatusStepper({ job }: { job: Job }) {
  const currentIdx = resolveStepIndex(job);
  const isCanceled = job.status === 'Canceled';
  const isNoShow   = job.status === 'No Show';
  const isIssue    = isCanceled || isNoShow;

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-slate-700">Job Progress</h4>
        {isIssue && (
          <span className={`text-xs rounded-full px-2.5 py-1 ${isCanceled ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
            {job.status}
          </span>
        )}
      </div>

      <div className="relative flex items-start">
        {/* Background line */}
        <div className="absolute top-3 left-3 right-3 h-px bg-slate-200 z-0" />
        {/* Progress fill */}
        {!isIssue && currentIdx > 0 && (
          <div
            className="absolute top-3 left-3 h-px bg-green-400 z-0 transition-all duration-500"
            style={{
              width: `${(currentIdx / (STEPS.length - 1)) * 100}%`,
              maxWidth: 'calc(100% - 24px)',
            }}
          />
        )}

        {STEPS.map((step, i) => {
          const done    = i < currentIdx;
          const current = i === currentIdx && !isIssue;
          const historyEntry = job.statusHistory.find(
            h => h.status === step.key || (step.key === 'On Site' && h.status === 'Active')
          );
          return (
            <div key={step.key} className="flex-1 flex flex-col items-center relative z-10">
              <div className={`flex size-6 items-center justify-center rounded-full border-2 transition-all ${
                done    ? 'bg-green-500 border-green-500' :
                current ? 'bg-white border-blue-500 shadow-sm' :
                isIssue && i <= currentIdx ? 'bg-slate-300 border-slate-300' :
                'bg-white border-slate-200'
              }`}>
                {done    && <CheckCircle2 size={14} className="text-white" />}
                {current && <div className="size-2 rounded-full bg-blue-500" />}
                {!done && !current && <Circle size={10} className="text-slate-300" />}
              </div>
              <p
                className={`mt-1.5 text-center hidden md:block ${done ? 'text-green-700' : current ? 'text-blue-700' : 'text-slate-400'}`}
                style={{ fontSize: 10 }}
              >{step.label}</p>
              <p
                className={`mt-1.5 text-center md:hidden ${done ? 'text-green-700' : current ? 'text-blue-700' : 'text-slate-400'}`}
                style={{ fontSize: 10 }}
              >{step.short}</p>
              {historyEntry && (
                <p className="text-center text-slate-400 hidden md:block mt-0.5" style={{ fontSize: 9 }}>
                  {historyEntry.time.split(' ').slice(-2).join(' ')}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {job.statusHistory.length > 0 && (
        <div className="flex flex-col gap-1 mt-4 border-t border-slate-100 pt-3">
          {job.statusHistory.map((entry, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`size-1.5 rounded-full shrink-0 ${
                entry.status === 'Completed' ? 'bg-green-500' :
                entry.status === 'Canceled'  ? 'bg-red-400'   :
                entry.status === 'No Show'   ? 'bg-orange-400' : 'bg-slate-400'
              }`} />
              <span className="text-slate-600">{entry.status}</span>
              <span className="text-slate-400 ml-auto shrink-0">{entry.time}</span>
              {entry.note && (
                <span className="text-slate-400 italic truncate ml-1 max-w-[140px]">· {entry.note}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Customer Card ─────────────────────────────────────────────────────────
function CustomerCard({ customer, job, onCall, onText, onViewCustomer }: {
  customer: Customer; job: Job; onCall: () => void; onText: () => void; onViewCustomer: () => void;
}) {
  const initials = customer.name.split(' ').map((n: string) => n[0]).join('');
  const svcCfg   = SERVICE_COLOR[customer.serviceType] ?? SERVICE_COLOR.HVAC;
  const mapsUrl  = `https://maps.google.com/?q=${encodeURIComponent(customer.address)}`;
  const isVIP    = customer.notes?.toLowerCase().includes('vip') ||
                   customer.notes?.toLowerCase().includes('contract');

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className="relative shrink-0">
          <div
            className="flex size-12 items-center justify-center rounded-full bg-slate-900 text-white"
            style={{ fontSize: 16 }}
          >{initials}</div>
          <span className="absolute -bottom-1 -right-1 text-base">{SERVICE_ICON[job.serviceType]}</span>
        </div>

        <div className="flex-1 min-w-0">
          <button
            onClick={onViewCustomer}
            className="flex items-center gap-1.5 group text-left"
          >
            <p className="text-sm text-slate-900 truncate group-hover:text-blue-600 transition-colors">
              {customer.name}
            </p>
            <ExternalLink size={11} className="text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
          </button>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={`text-xs rounded-full px-1.5 py-0.5 ${svcCfg.bg} ${svcCfg.text}`}>
              {customer.serviceType}
            </span>
            {customer.jobCount > 1 && (
              <span className="text-xs text-slate-400">
                {customer.jobCount} jobs · {customer.lastService}
              </span>
            )}
            {isVIP && (
              <span className="flex items-center gap-0.5 text-xs rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5">
                <Star size={9} className="fill-amber-500 text-amber-500" /> VIP
              </span>
            )}
          </div>
          {customer.notes && (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-100 px-2.5 py-1.5">
              <p className="text-xs text-amber-700">{customer.notes}</p>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-slate-100 divide-x divide-slate-100">
        <button
          onClick={onCall}
          className="flex items-center gap-2 px-3 py-3 hover:bg-green-50 transition-colors group text-left"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-green-100 shrink-0 group-hover:bg-green-200 transition-colors">
            <Phone size={13} className="text-green-600" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-slate-400">Phone</p>
            <p className="text-sm text-slate-700 truncate">{customer.phone}</p>
          </div>
        </button>

        <button
          onClick={onText}
          className="flex items-center gap-2 px-3 py-3 hover:bg-blue-50 transition-colors group text-left"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-blue-100 shrink-0 group-hover:bg-blue-200 transition-colors">
            <MessageSquare size={13} className="text-blue-600" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-slate-400">Text</p>
            <p className="text-sm text-slate-700 truncate">{customer.phone}</p>
          </div>
        </button>

        <a
          href={mapsUrl}
          target="_blank"
          rel="noreferrer"
          className="col-span-2 flex items-center gap-2 px-3 py-3 hover:bg-violet-50 transition-colors group"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-violet-100 shrink-0 group-hover:bg-violet-200 transition-colors">
            <MapPin size={13} className="text-violet-600" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-400">Address</p>
            <p className="text-sm text-slate-700 truncate">{customer.address}</p>
          </div>
          <Navigation size={12} className="text-violet-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>

        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className="col-span-2 flex items-center gap-2 px-3 py-3 hover:bg-slate-50 transition-colors border-t border-slate-100"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-slate-100 shrink-0">
              <Mail size={13} className="text-slate-500" />
            </span>
            <p className="text-sm text-slate-600 truncate">{customer.email}</p>
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Schedule + Tech Card ──────────────────────────────────────────────────
function ScheduleTechCard({ job, tech, onCallTech }: {
  job: Job; tech: Technician | undefined; onCallTech: () => void;
}) {
  const techStatusLabel =
    job.status === 'Active' || job.status === 'In Progress' ? 'On site now' :
    job.status === 'Scheduled' ? 'Dispatching soon' :
    job.status === 'Completed' ? 'Job complete' : '';

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-slate-100">
        <div className="px-4 py-4">
          <div className="flex items-center gap-1.5 mb-3">
            <Calendar size={13} className="text-slate-400" />
            <p className="text-xs text-slate-400">Schedule</p>
          </div>
          {job.scheduledDate ? (
            <>
              <p className="text-slate-700 mb-0.5">{job.scheduledDate}</p>
              {job.scheduledTime && (
                <p className="text-2xl text-slate-900 leading-none">{job.scheduledTime}</p>
              )}
              <p className="text-xs text-slate-400 mt-2">Est. 2–3 hours</p>
            </>
          ) : (
            <div>
              <p className="text-sm text-slate-400 italic">Not scheduled</p>
              <button className="text-xs text-blue-600 hover:underline mt-1">Schedule now →</button>
            </div>
          )}
        </div>

        <div className="px-4 py-4">
          <div className="flex items-center gap-1.5 mb-3">
            <User size={13} className="text-slate-400" />
            <p className="text-xs text-slate-400">Technician</p>
          </div>
          {tech ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ background: tech.color, fontSize: 12 }}
                >{tech.initials}</span>
                <div>
                  <p className="text-sm text-slate-900">{tech.name}</p>
                  {techStatusLabel && (
                    <p className="text-xs text-green-600">{techStatusLabel}</p>
                  )}
                </div>
              </div>
              <button
                onClick={onCallTech}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-green-700 transition-colors"
              >
                <Phone size={11} /> {tech.phone}
              </button>
            </>
          ) : (
            <button className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 transition-colors">
              <Plus size={13} /> Assign technician
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Description Card ─────────────────────────────────────────────────────
function DescriptionCard({ job }: { job: Job }) {
  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex items-center gap-2 mb-2">
          <FileText size={13} className="text-slate-400" />
          <h4 className="text-slate-700">Description</h4>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed">{job.description}</p>
      </div>
      {job.notes && (
        <div className="border-t border-amber-100 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap size={12} className="text-amber-600" />
            <p className="text-xs text-amber-700">Access Notes</p>
          </div>
          <p className="text-sm text-amber-800 leading-relaxed">{job.notes}</p>
        </div>
      )}
    </div>
  );
}

// ─── Estimate Scope Card ──────────────────────────────────────────────────
function EstimateScopeCard({ estimateId, onOpen }: { estimateId: string; onOpen: () => void }) {
  const estimate = estimates.find(e => e.id === estimateId);
  if (!estimate) return null;

  const total    = calcEstimateTotal(estimate);
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2 flex-wrap">
          <FileText size={14} className="text-indigo-500 shrink-0" />
          <h4 className="text-slate-700">Estimate Scope</h4>
          <span className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2 py-0.5">
            {estimate.estimateNumber}
          </span>
          <StatusBadge status={estimate.status} size="sm" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onOpen} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors">
            <Eye size={11} /> Full view
          </button>
          <button onClick={() => setOpen(v => !v)} className="text-slate-400 hover:text-slate-600 transition-colors">
            <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_40px_70px_70px] gap-x-2 px-4 py-2 bg-slate-50 border-b border-slate-100">
            <p className="text-xs text-slate-400">Item</p>
            <p className="text-xs text-slate-400 text-right">Qty</p>
            <p className="text-xs text-slate-400 text-right">Rate</p>
            <p className="text-xs text-slate-400 text-right">Total</p>
          </div>

          <div className="divide-y divide-slate-50">
            {estimate.lineItems.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_40px_70px_70px] gap-x-2 px-4 py-2.5 items-center">
                <p className="text-sm text-slate-800 leading-snug">{item.description}</p>
                <p className="text-sm text-slate-500 text-right">{item.qty}</p>
                <p className="text-sm text-slate-500 text-right">${item.rate.toLocaleString()}</p>
                <p className="text-sm text-slate-800 text-right">${(item.qty * item.rate).toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-4 py-3.5 border-t border-slate-100 bg-slate-900 rounded-b-xl">
            <p className="text-sm text-slate-300">Agreed total</p>
            <p className="text-white">${total.toLocaleString()}</p>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Materials Table ──────────────────────────────────────────────────────
const CAT_CONFIG: Record<MaterialItem['category'], { label: string; dot: string; text: string; bg: string }> = {
  Part:      { label: 'Parts',     dot: 'bg-blue-500',   text: 'text-blue-700',   bg: 'bg-blue-50'   },
  Material:  { label: 'Materials', dot: 'bg-green-500',  text: 'text-green-700',  bg: 'bg-green-50'  },
  Labor:     { label: 'Labor',     dot: 'bg-violet-500', text: 'text-violet-700', bg: 'bg-violet-50' },
  Equipment: { label: 'Equipment', dot: 'bg-amber-500',  text: 'text-amber-700',  bg: 'bg-amber-50'  },
};

function MaterialsTable({ materials, onEdit, onSuppliers }: { materials: MaterialItem[]; onEdit: () => void; onSuppliers: () => void; }) {
  const total   = calcMaterialsTotal(materials);
  const grouped = materials.reduce<Record<string, MaterialItem[]>>((acc, m) => {
    if (!acc[m.category]) acc[m.category] = [];
    acc[m.category].push(m);
    return acc;
  }, {});

  if (materials.length === 0) {
    return (
      <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-amber-500" />
            <h4 className="text-slate-700">Materials & Parts</h4>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onSuppliers} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors">
              <MapPin size={12} /> Find parts
            </button>
            <button onClick={onEdit} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors">
              <Plus size={12} /> Add parts
            </button>
          </div>
        </div>
        <button
          onClick={onEdit}
          className="flex flex-col items-center gap-2 py-8 w-full rounded-xl border-2 border-dashed border-slate-200 hover:border-amber-300 hover:bg-amber-50/50 transition-colors"
        >
          <Package size={24} className="text-slate-300" />
          <p className="text-sm text-slate-400">No materials logged yet</p>
          <p className="text-xs text-slate-300">Tap to add parts & materials used</p>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-amber-500" />
          <h4 className="text-slate-700">Materials & Parts</h4>
          <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">{materials.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onSuppliers} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors">
            <MapPin size={12} /> Find parts
          </button>
          <button onClick={onEdit} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors">
            <Plus size={12} /> Edit
          </button>
        </div>
      </div>

      <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 bg-slate-50 border-b border-slate-100">
        <p className="text-xs text-slate-400">Item / Part #</p>
        <p className="text-xs text-slate-400 text-right w-8">Qty</p>
        <p className="text-xs text-slate-400 text-right w-20">Unit cost</p>
        <p className="text-xs text-slate-400 text-right w-20">Total</p>
      </div>

      {(Object.entries(grouped) as [MaterialItem['category'], MaterialItem[]][]).map(([cat, items]) => {
        const cfg      = CAT_CONFIG[cat];
        const catTotal = items.reduce((s, m) => s + m.qty * m.unitCost, 0);
        return (
          <div key={cat}>
            <div className={`flex items-center justify-between px-4 py-2 ${cfg.bg}`}>
              <div className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${cfg.dot}`} />
                <span className={`text-xs ${cfg.text}`}>{cfg.label}</span>
              </div>
              <span className={`text-xs ${cfg.text}`}>${catTotal.toFixed(2)}</span>
            </div>
            {items.map((m, i) => (
              <div key={m.id} className={`px-4 py-3 ${i < items.length - 1 ? 'border-b border-slate-50' : ''}`}>
                <div className="flex items-center justify-between gap-2 md:hidden">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800 truncate">{m.name}</p>
                    {m.partNumber && <p className="text-xs text-slate-400">{m.partNumber}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-slate-400">×{m.qty} @ ${m.unitCost}/ea</p>
                    <p className="text-sm text-slate-800">${(m.qty * m.unitCost).toFixed(2)}</p>
                  </div>
                </div>
                <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800 truncate">{m.name}</p>
                    {m.partNumber && <p className="text-xs text-slate-400 mt-0.5">{m.partNumber}</p>}
                  </div>
                  <p className="text-sm text-slate-500 text-right w-8">×{m.qty}</p>
                  <p className="text-sm text-slate-500 text-right w-20">${m.unitCost.toFixed(2)}</p>
                  <p className="text-sm text-slate-800 text-right w-20">${(m.qty * m.unitCost).toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      <div className="flex items-center justify-between px-4 py-3.5 bg-slate-900 text-white">
        <p className="text-sm">Total materials cost</p>
        <p className="text-sm">${total.toFixed(2)}</p>
      </div>
    </div>
  );
}

// ─── Site Media ───────────────────────────────────────────────────────────
const MOCK_DOCUMENTS = [
  { id: 'doc-1', name: 'Work order #1042.pdf',     size: '84 KB',  date: 'Mar 10' },
  { id: 'doc-2', name: 'Permit – Austin HVAC.pdf', size: '210 KB', date: 'Mar 8'  },
];

function SiteMedia({ media, onAdd, onLightbox }: {
  media: CapturedMedia[]; onAdd: () => void; onLightbox: (i: number) => void;
}) {
  const [showDocs, setShowDocs] = useState(false);

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Camera size={14} className="text-slate-500" />
          <h4 className="text-slate-700">Site Media</h4>
          {media.length > 0 && (
            <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">{media.length}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDocs(v => !v)}
            className={`flex items-center gap-1 text-xs transition-colors ${showDocs ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <FileText size={12} /> Docs ({MOCK_DOCUMENTS.length})
          </button>
          <button onClick={onAdd} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors">
            <Camera size={12} /> Add
          </button>
        </div>
      </div>

      {media.length > 0 ? (
        <div className="p-3 grid grid-cols-3 md:grid-cols-4 gap-2">
          {media.map((item, i) => (
            <button
              key={item.id}
              onClick={() => onLightbox(i)}
              className="relative aspect-square rounded-xl overflow-hidden bg-slate-100 hover:opacity-90 active:scale-95 transition-all"
            >
              {item.type === 'photo'
                ? <img src={item.url} className="w-full h-full object-cover" alt="" />
                : <>
                    {item.thumb
                      ? <img src={item.thumb} className="w-full h-full object-cover" alt="" />
                      : <div className="w-full h-full bg-slate-800 flex items-center justify-center"><Video size={18} className="text-white/60" /></div>
                    }
                    <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                      <span className="flex size-8 items-center justify-center rounded-full bg-black/50">
                        <Play size={13} className="text-white ml-0.5" />
                      </span>
                    </div>
                  </>
              }
            </button>
          ))}
          <button
            onClick={onAdd}
            className="aspect-square rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-1 hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
          >
            <Plus size={16} className="text-slate-300" />
            <span className="text-xs text-slate-300">Add</span>
          </button>
        </div>
      ) : (
        <button
          onClick={onAdd}
          className="flex flex-col items-center gap-3 py-10 px-4 w-full hover:bg-slate-50 transition-colors"
        >
          <div className="flex size-14 items-center justify-center rounded-full bg-slate-100">
            <Camera size={20} className="text-slate-400" />
          </div>
          <div className="text-center">
            <p className="text-sm text-slate-600">Add site photos</p>
            <p className="text-xs text-slate-400 mt-0.5">Capture before/after and site conditions</p>
          </div>
        </button>
      )}

      {showDocs && (
        <div className="border-t border-slate-100">
          {MOCK_DOCUMENTS.map(doc => (
            <div key={doc.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 border-b border-slate-50 last:border-0 transition-colors">
              <div className="flex size-8 items-center justify-center rounded-lg bg-red-50 shrink-0">
                <FileText size={14} className="text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700 truncate">{doc.name}</p>
                <p className="text-xs text-slate-400">{doc.size} · {doc.date}</p>
              </div>
              <button className="text-xs text-blue-600 hover:text-blue-700 shrink-0">View</button>
            </div>
          ))}
          <button className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 px-4 py-2.5 transition-colors">
            <Plus size={11} /> Attach document
          </button>
        </div>
      )}
    </div>
  );
}

// ─── AI Hints ─────────────────────────────────────────────────────────────
interface AIHint {
  id: string;
  icon: React.ElementType;
  label: string;
  desc: string;
  action: Modal;
  color: string;
}

function getAIHints(job: Job, materials: MaterialItem[], customer: Customer | undefined): AIHint[] {
  const hints: AIHint[] = [];

  if (job.status === 'Active' && materials.length > 0) {
    hints.push({
      id: 'h-mat', icon: Package,
      label: `$${calcMaterialsTotal(materials).toFixed(0)} in parts logged`,
      desc: 'Consider adding to estimate before invoicing',
      action: 'estimate', color: 'amber',
    });
  }
  if ((job.status === 'Completed' || job.status === 'Active') && !job.invoiceId) {
    hints.push({
      id: 'h-inv', icon: Receipt,
      label: 'Ready to invoice',
      desc: job.status === 'Completed' ? 'Job complete — create and send invoice' : 'Create a draft invoice now',
      action: 'invoice', color: 'blue',
    });
  }
  if (job.status === 'Scheduled') {
    hints.push({
      id: 'h-remind', icon: MessageSquare,
      label: 'Send appointment reminder',
      desc: `Remind ${customer?.name.split(' ')[0] ?? 'customer'} of their upcoming appointment`,
      action: 'text', color: 'violet',
    });
  }
  if (job.estimateId && !job.invoiceId && job.status !== 'Canceled' && job.status !== 'No Show') {
    hints.push({
      id: 'h-est', icon: Eye,
      label: 'Review estimate',
      desc: 'Check line items before finalizing invoice',
      action: 'estimate', color: 'indigo',
    });
  }
  return hints.slice(0, 3);
}

const HINT_CFG: Record<string, { bg: string; icon: string; btn: string }> = {
  amber:  { bg: 'bg-amber-50',  icon: 'text-amber-600',  btn: 'bg-amber-600  hover:bg-amber-700'  },
  blue:   { bg: 'bg-blue-50',   icon: 'text-blue-600',   btn: 'bg-blue-600   hover:bg-blue-700'   },
  violet: { bg: 'bg-violet-50', icon: 'text-violet-600', btn: 'bg-violet-600 hover:bg-violet-700' },
  indigo: { bg: 'bg-indigo-50', icon: 'text-indigo-600', btn: 'bg-indigo-600 hover:bg-indigo-700' },
  green:  { bg: 'bg-green-50',  icon: 'text-green-600',  btn: 'bg-green-600  hover:bg-green-700'  },
};

function AIHintsPanel({ hints, onAction }: { hints: AIHint[]; onAction: (a: Modal) => void }) {
  if (!hints.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Zap size={13} className="text-indigo-500" />
        <p className="text-sm text-slate-700">AI Suggestions</p>
      </div>
      <div className="flex flex-col divide-y divide-slate-100">
        {hints.map(hint => {
          const cfg  = HINT_CFG[hint.color] ?? HINT_CFG.blue;
          const Icon = hint.icon;
          return (
            <div key={hint.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`flex size-7 shrink-0 items-center justify-center rounded-full mt-0.5 ${cfg.bg}`}>
                <Icon size={13} className={cfg.icon} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">{hint.label}</p>
                <p className="text-xs text-slate-400 mt-0.5">{hint.desc}</p>
              </div>
              {hint.action && (
                <button
                  onClick={() => onAction(hint.action)}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-white transition-colors ${cfg.btn}`}
                >
                  Go
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Banners ─────────────────────────────────────────────────────────────
function DuplicateBanner({ warning, onDismiss }: {
  warning: NonNullable<Job['duplicateWarning']>; onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-sm text-amber-900">Possible duplicate detected</p>
            <span className="text-xs bg-amber-200 text-amber-800 rounded-full px-2 py-0.5">{warning.similarity}% match</span>
          </div>
          <p className="text-xs text-amber-700">{warning.reason}</p>
          <div className="flex items-center gap-3 mt-2.5">
            <button className="flex items-center gap-1 text-xs text-amber-800 hover:text-amber-900 underline underline-offset-2">
              <ExternalLink size={11} /> View Job #{warning.matchJobNumber}
            </button>
            <button onClick={onDismiss} className="text-xs text-amber-600 hover:text-amber-800 transition-colors">
              Continue as new
            </button>
          </div>
        </div>
        <button onClick={onDismiss} className="text-amber-400 hover:text-amber-600"><X size={14} /></button>
      </div>
    </div>
  );
}

function IssueBanner({ job, onText }: { job: Job; onText: () => void }) {
  if (job.status !== 'Canceled' && job.status !== 'No Show') return null;
  const isCanceled = job.status === 'Canceled';
  return (
    <div className={`rounded-xl border px-4 py-3.5 ${isCanceled ? 'border-red-200 bg-red-50' : 'border-orange-200 bg-orange-50'}`}>
      <div className="flex items-start gap-3">
        {isCanceled
          ? <X size={16} className="text-red-500 shrink-0 mt-0.5" />
          : <AlertCircle size={16} className="text-orange-500 shrink-0 mt-0.5" />
        }
        <div>
          <p className={`text-sm ${isCanceled ? 'text-red-800' : 'text-orange-800'}`}>
            {isCanceled ? 'Job canceled' : 'No-show recorded'}
          </p>
          <p className={`text-xs mt-0.5 ${isCanceled ? 'text-red-600' : 'text-orange-600'}`}>
            {job.cancelReason ?? job.noShowNotes}
          </p>
          <div className="flex gap-3 mt-2.5">
            <button className={`text-xs underline underline-offset-2 ${isCanceled ? 'text-red-700' : 'text-orange-700'}`}>
              Reschedule
            </button>
            <button onClick={onText} className={`text-xs underline underline-offset-2 ${isCanceled ? 'text-red-700' : 'text-orange-700'}`}>
              Text customer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Media Lightbox ───────────────────────────────────────────────────────
function MediaLightbox({ media, index, onIndexChange, onDelete, onClose }: {
  media: CapturedMedia[]; index: number;
  onIndexChange: (i: number) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const current = media[index];
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col" onClick={onClose}>
      <div
        className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-5 pb-8"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} className="flex size-9 items-center justify-center rounded-full bg-black/40">
          <X size={18} className="text-white" />
        </button>
        <span className="text-sm text-white/70">{index + 1} / {media.length}</span>
        <button onClick={() => onDelete(current.id)} className="flex size-9 items-center justify-center rounded-full bg-red-500/80">
          <Trash2 size={15} className="text-white" />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center relative" onClick={e => e.stopPropagation()}>
        {current.type === 'photo'
          ? <img key={current.id} src={current.url} className="max-w-full object-contain" style={{ maxHeight: 'calc(100vh - 160px)' }} alt="" />
          : <video key={current.id} src={current.url} className="max-w-full" style={{ maxHeight: 'calc(100vh - 160px)' }} controls autoPlay />
        }
        {media.length > 1 && (
          <>
            <button onClick={() => onIndexChange((index - 1 + media.length) % media.length)} className="absolute left-3 flex size-10 items-center justify-center rounded-full bg-black/40">
              <ChevronLeft size={20} className="text-white" />
            </button>
            <button onClick={() => onIndexChange((index + 1) % media.length)} className="absolute right-3 flex size-10 items-center justify-center rounded-full bg-black/40">
              <ChevronRight size={20} className="text-white" />
            </button>
          </>
        )}
      </div>

      <div
        className="shrink-0 px-4 pb-8 pt-4"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
        onClick={e => e.stopPropagation()}
      >
        <p className="text-center text-xs text-white/50 mb-3">
          {current.type === 'video' ? '🎬 Video' : '📷 Photo'} · {new Date(current.capturedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </p>
        {media.length > 1 && (
          <div className="flex gap-1.5 justify-center overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {media.map((item, i) => (
              <button
                key={item.id}
                onClick={() => onIndexChange(i)}
                className={`shrink-0 rounded-lg overflow-hidden transition-all ${i === index ? 'ring-2 ring-white scale-105' : 'opacity-50 hover:opacity-80'}`}
                style={{ width: 48, height: 48 }}
              >
                {item.type === 'photo'
                  ? <img src={item.url} className="w-full h-full object-cover" alt="" />
                  : <div className="w-full h-full bg-slate-700 flex items-center justify-center"><Play size={12} className="text-white" /></div>
                }
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────
export function JobDetailView({ id }: { id: string }) {
  const navigate = useNavigate();

  const job      = jobs.find(j => j.id === id);
  const tech     = technicians.find(t => t.name === job?.assignedTech);
  const customer = customers.find(c => c.id === job?.customerId);

  const [modal,         setModal]         = useState<Modal>(null);
  const [cameraOpen,    setCameraOpen]    = useState(false);
  const [jobMedia,      setJobMedia]      = useState<CapturedMedia[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [activities,    setActivities]    = useState<JobActivity[]>(job?.activity ?? []);
  const [materials,     setMaterials]     = useState<MaterialItem[]>(job?.materials ?? []);
  const [showDuplicate, setShowDuplicate] = useState(!!job?.duplicateWarning);

  if (!job) {
    return (
      <div className="h-full overflow-y-auto pb-20 p-6">
        <button onClick={() => navigate('/jobs')} className="flex items-center gap-2 text-sm text-slate-500 mb-4">
          <ArrowLeft size={14} /> Back
        </button>
        <p className="text-slate-400">Job not found.</p>
      </div>
    );
  }

  const customerPhone = customer?.phone ?? '(512) 555-0000';
  const mapsUrl       = `https://maps.google.com/?q=${encodeURIComponent(job.address)}`;
  const hints         = getAIHints(job, materials, customer);

  function addActivity(entry: Partial<JobActivity>) {
    setActivities(prev => [...prev, {
      id: `new-${Date.now()}`, type: 'note', content: '', time: 'Just now', ...entry,
    }]);
  }

  const secondaryActions = [
    { key: 'camera',   icon: Camera,        label: 'Photos',   badge: jobMedia.length, disabled: false },
    { key: 'estimate', icon: Eye,           label: 'Estimate', badge: 0,               disabled: !job.estimateId },
    { key: 'invoice',  icon: Receipt,       label: 'Invoice',  badge: 0,               disabled: false },
    { key: 'addEntry', icon: FileText,      label: 'Note',     badge: 0,               disabled: false },
    { key: 'materials',icon: Package,       label: 'Parts',    badge: 0,               disabled: false },
    { key: 'cancel',   icon: MoreHorizontal,label: 'More',     badge: 0,               disabled: false },
  ];

  function onSecondaryAction(key: string) {
    if      (key === 'camera')                    setCameraOpen(true);
    else if (key === 'estimate' && job.estimateId) setModal('estimate');
    else if (key === 'invoice')                    setModal('invoice');
    else if (key === 'addEntry')                   setModal('addEntry');
    else if (key === 'materials')                  setModal('materials');
    else if (key === 'cancel')                     setModal('cancel');
  }

  const LeftContent = () => (
    <div className="flex flex-col gap-4">
      {customer && (
        <CustomerCard
          customer={customer}
          job={job}
          onCall={() => setModal('call')}
          onText={() => setModal('text')}
          onViewCustomer={() => navigate(`/customers/${customer.id}`)}
        />
      )}
      <StatusStepper job={job} />
      <ScheduleTechCard job={job} tech={tech} onCallTech={() => setModal('call')} />
      <DescriptionCard job={job} />
      {job.estimateId && (
        <EstimateScopeCard
          estimateId={job.estimateId}
          onOpen={() => setModal('estimate')}
        />
      )}
      <MaterialsTable materials={materials} onEdit={() => setModal('materials')} onSuppliers={() => setModal('suppliers')} />
      <SiteMedia
        media={jobMedia}
        onAdd={() => setCameraOpen(true)}
        onLightbox={i => setLightboxIndex(i)}
      />
    </div>
  );

  const RightRail = () => (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
          <h4 className="text-slate-700">Activity Log</h4>
          <button
            onClick={() => setModal('addEntry')}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors"
          >
            <Plus size={12} /> Add entry
          </button>
        </div>
        <div className="px-4 py-4 max-h-[480px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          <ActivityTimeline activities={activities} />
        </div>
      </div>
      <AIHintsPanel hints={hints} onAction={setModal} />
    </div>
  );

  return (
    <>
      <div className="h-full overflow-y-auto pb-24 md:pb-6" style={{ scrollbarWidth: 'thin' }}>
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 md:py-6">

          {/* Top nav */}
          <div className="flex items-center justify-between mb-5">
            <button
              onClick={() => navigate('/jobs')}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              <ArrowLeft size={14} /> Back to Jobs
            </button>
            {tech && (
              <button
                onClick={() => navigate(`/jobs/${job.id}?view=tech`)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              >
                <Cpu size={12} /> Tech View
              </button>
            )}
          </div>

          {/* Banners */}
          <div className="flex flex-col gap-3 mb-5">
            {showDuplicate && job.duplicateWarning && (
              <DuplicateBanner warning={job.duplicateWarning} onDismiss={() => setShowDuplicate(false)} />
            )}
            <IssueBanner job={job} onText={() => setModal('text')} />
          </div>

          {/* Page header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-2xl shrink-0">
                {SERVICE_ICON[job.serviceType]}
              </div>
              <div>
                <h1 className="text-slate-900" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>
                  {job.customer}
                </h1>
                <p className="text-sm text-slate-400 mt-0.5">
                  Job #{job.jobNumber} · {job.serviceType}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {job.priority === 'Urgent' && <StatusBadge status="Urgent" />}
              <StatusBadge status={job.status} />
            </div>
          </div>

          {/* Primary actions */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[
              { icon: Phone,         label: 'Call',       sub: customerPhone.split(' ')[0],  onClick: () => setModal('call'),              bg: 'bg-green-600  hover:bg-green-700'  },
              { icon: MessageSquare, label: 'Text',       sub: 'Send message',                onClick: () => setModal('text'),              bg: 'bg-blue-600   hover:bg-blue-700'   },
              { icon: Navigation,    label: 'Directions', sub: job.address.split(',')[0],     onClick: () => window.open(mapsUrl, '_blank'), bg: 'bg-violet-600 hover:bg-violet-700' },
            ].map(({ icon: Icon, label, sub, onClick, bg }) => (
              <button
                key={label}
                onClick={onClick}
                className={`flex flex-col items-center gap-2 rounded-xl py-4 text-white transition-colors active:scale-95 ${bg}`}
              >
                <Icon size={20} />
                <div className="text-center">
                  <p className="text-sm">{label}</p>
                  {sub && <p className="text-xs text-white/70 truncate max-w-[80px]">{sub}</p>}
                </div>
              </button>
            ))}
          </div>

          {/* Secondary actions */}
          <div className="flex gap-1.5 mb-5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {secondaryActions.map(({ key, icon: Icon, label, badge, disabled }) => (
              <button
                key={key}
                onClick={() => onSecondaryAction(key)}
                disabled={disabled}
                className={`relative flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <Icon size={14} className="text-slate-500" />
                {label}
                {badge > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-blue-500 text-white border-2 border-white" style={{ fontSize: 8 }}>
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Mobile AI hints */}
          {hints.length > 0 && (
            <div className="md:hidden flex flex-col gap-2 mb-5">
              <div className="flex items-center gap-2 px-1">
                <Zap size={12} className="text-indigo-500" />
                <p className="text-xs text-slate-500">Suggested actions</p>
              </div>
              {hints.map(h => {
                const cfg   = HINT_CFG[h.color] ?? HINT_CFG.blue;
                const HIcon = h.icon;
                return (
                  <div key={h.id} className={`flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-3 ${cfg.bg}`}>
                    <HIcon size={15} className={cfg.icon} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800">{h.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{h.desc}</p>
                    </div>
                    {h.action && (
                      <button
                        onClick={() => setModal(h.action)}
                        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs text-white transition-colors ${cfg.btn}`}
                      >
                        Go
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Desktop 2-column */}
          <div className="hidden md:grid md:grid-cols-[1fr_360px] md:gap-6 md:items-start">
            <LeftContent />
            <div className="sticky top-0">
              <RightRail />
            </div>
          </div>

          {/* Mobile single column */}
          <div className="md:hidden flex flex-col gap-4">
            <LeftContent />
            <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
                <h4 className="text-slate-700">Activity Log</h4>
                <button
                  onClick={() => setModal('addEntry')}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
              <div className="px-4 py-4">
                <ActivityTimeline activities={activities} onAddEntry={() => setModal('addEntry')} />
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Modals */}
      {modal === 'call' && customer && (
        <CallScreen
          name={customer.name}
          phone={customerPhone}
          initials={customer.name.split(' ').map((n: string) => n[0]).join('')}
          color={tech?.color ?? '#475569'}
          onEnd={() => setModal(null)}
        />
      )}
      {modal === 'text'     && customer   && <TextSheet name={customer.name} phone={customerPhone} onClose={() => setModal(null)} />}
      {modal === 'estimate' && job.estimateId && <EstimateSheet estimateId={job.estimateId} onClose={() => setModal(null)} />}
      {modal === 'invoice'  && (
        <InvoiceSheet
          invoiceId={job.invoiceId ?? ''}
          customerName={job.customer}
          customerPhone={customerPhone}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'addEntry' && (
        <AddEntrySheet
          author={tech?.name ?? 'Mike (owner)'}
          authorInitials={tech?.initials ?? 'MO'}
          authorColor={tech?.color ?? '#475569'}
          onClose={() => setModal(null)}
          onSubmit={entry => { addActivity(entry); setModal(null); }}
        />
      )}
      {modal === 'materials' && (
        <MaterialsSheet
          serviceType={job.serviceType}
          existing={materials}
          onClose={updated => { setMaterials(updated); setModal(null); }}
        />
      )}
      {modal === 'cancel' && customer && (
        <CancelNoShowSheet
          job={job}
          customerName={customer.name}
          customerPhone={customerPhone}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'suppliers' && (
        <SuppliersSheet serviceType={job.serviceType} onClose={() => setModal(null)} />
      )}

      {cameraOpen && (
        <CameraCapture
          onClose={newMedia => {
            if (newMedia.length) setJobMedia(prev => [...prev, ...newMedia]);
            setCameraOpen(false);
          }}
        />
      )}

      {lightboxIndex !== null && jobMedia.length > 0 && (
        <MediaLightbox
          media={jobMedia}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onDelete={did => { setJobMedia(prev => prev.filter(m => m.id !== did)); setLightboxIndex(null); }}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}