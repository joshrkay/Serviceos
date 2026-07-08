import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useUser } from '@clerk/clerk-react';
import {
  ArrowLeft, Phone, MessageSquare, Navigation,
  MapPin, AlertCircle, AlertTriangle, Package,
  X, ExternalLink,
  Plus, Cpu, Camera, Receipt, Eye, FileText, Mail, Star,
  CheckCircle2, Circle, MoreHorizontal, Zap, Calendar, User, Clock,
  ChevronDown,
} from 'lucide-react';
import type { Job, JobActivity, MaterialItem, Customer, Technician } from '../../data/mock-data';
import type { JobDetailResponse } from '@ai-service-os/shared';
import { calcMaterialsTotal, calcEstimateTotalFromLines } from '../../utils/job-ui-math';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { useApiClient } from '../../lib/apiClient';
import { useWorkerTerm } from '../../hooks/useWorkerTerm';
import { normalizeJobStatus } from '../../utils/statusNormalize';
import { apiFetch } from '../../utils/api-fetch';
import { firstNameFromUser } from '../../utils/greeting';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateInTenantTz, formatTimeInTenantTz } from '../../utils/formatInTenantTz';

function buildJobCompat(api: JobDetailResponse): Job {
  const techName = api.technician
    ? [api.technician.firstName, api.technician.lastName].filter(Boolean).join(' ')
    : undefined;
  const customerName = api.customer
    ? (api.customer.displayName || [api.customer.firstName, api.customer.lastName].filter(Boolean).join(' ') || 'Customer')
    : 'Customer';

  // Use the job's specific location (most accurate), falling back to customer's primary location
  const jobLocation = api.location ?? api.customer?.locations?.find(l => l.isPrimary) ?? api.customer?.locations?.[0];
  const address = jobLocation
    ? [jobLocation.street1, jobLocation.city, jobLocation.state, jobLocation.postalCode].filter(Boolean).join(', ')
    : '';

  return {
    id: api.id,
    jobNumber: api.jobNumber,
    customer: customerName,
    customerId: api.customerId ?? api.customer?.id ?? '',
    address,
    serviceType: (api.serviceType ?? 'HVAC') as 'HVAC' | 'Plumbing' | 'Painting',
    status: normalizeJobStatus(api.status) as Job['status'],
    assignedTech: techName,
    description: api.summary,
    priority: api.priority === 'urgent' ? 'Urgent' : 'Normal',
    statusHistory: [],
    activity: [],
    materials: [],
  };
}

function buildCustomerCompat(api: JobDetailResponse['customer']): Customer | undefined {
  if (!api) return undefined;
  const name = api.displayName || [api.firstName, api.lastName].filter(Boolean).join(' ') || 'Customer';
  const primaryLocation = api.locations?.find(l => l.isPrimary) ?? api.locations?.[0];
  return {
    id: api.id,
    name,
    phone: api.primaryPhone ?? '',
    email: api.email ?? '',
    address: primaryLocation
      ? [primaryLocation.street1, primaryLocation.city, primaryLocation.state, primaryLocation.postalCode].filter(Boolean).join(', ')
      : (api.locations?.[0]?.street1 ?? ''),
    notes: api.communicationNotes,
    serviceType: 'HVAC',
    locations: [],
    jobCount: 0,
    openJobs: 0,
  };
}
import { StatusBadge } from '../shared/StatusBadge';
import { Spinner, EmptyState, Input, Select } from '../ui';
import { ErrorState } from '../ErrorState';
import { ActivityTimeline } from './ActivityTimeline';
import { AddEntrySheet } from './AddEntrySheet';
import { MaterialsSheet } from './MaterialsSheet';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import { CallScreen, TextSheet, EstimateSheet, InvoiceSheet } from './JobSheets';
import { CameraCapture } from '../shared/CameraCapture';
import type { CapturedMedia } from '../shared/CameraCapture';
import { SuppliersSheet } from './SuppliersSheet';
import { JobPhotoGallery } from './JobPhotoGallery';
import { JobProfitCard } from './JobProfitCard';
import { JobFormsPanel } from './JobFormsPanel';
import { JobCustomFieldsPanel } from './JobCustomFieldsPanel';
import {
  uploadJobPhoto as uploadJobPhotoApi,
  listJobPhotos as listJobPhotosApi,
  deleteJobPhoto as deleteJobPhotoApi,
  type JobPhoto,
  type JobPhotoCategory,
} from '../../api/job-photos';
import { capturedMediaToFile } from './capturedMediaToFile';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SERVICE_COLOR: Record<string, { bg: string; text: string }> = {
  HVAC:     { bg: 'bg-primary/15',   text: 'text-primary' },
  Plumbing: { bg: 'bg-primary/15',   text: 'text-primary' },
  Painting: { bg: 'bg-primary/15', text: 'text-primary' },
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

// Map the job's real (normalized display) status onto the stepper index. Post
// buildJobCompat, `statusHistory` is empty — the source of truth is the live
// job.status, so the stepper reflects where the job actually is.
const STATUS_STEP_INDEX: Record<string, number> = {
  New: 0, Created: 0,
  Scheduled: 1,
  Dispatched: 2,
  'On Site': 3, Active: 3,
  'In Progress': 4, 'Day 2': 4,
  Completed: 5, Invoiced: 5, Closed: 5,
};

function resolveStepIndex(job: Job): number {
  return STATUS_STEP_INDEX[job.status] ?? 0;
}

function StatusStepper({ job }: { job: Job }) {
  const currentIdx = resolveStepIndex(job);
  const isCanceled = job.status === 'Canceled';
  const isNoShow   = job.status === 'No Show';
  const isIssue    = isCanceled || isNoShow;

  return (
    <div
      className="rounded-xl bg-card border border-border px-4 py-4"
      data-testid="status-stepper"
      data-current-step={STEPS[currentIdx]?.key ?? ''}
    >
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-foreground">Job Progress</h4>
        {isIssue && (
          <span className={`text-xs rounded-full px-2.5 py-1 ${isCanceled ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'}`}>
            {job.status}
          </span>
        )}
      </div>

      <div className="relative flex items-start">
        {/* Background line */}
        <div className="absolute top-3 left-3 right-3 h-px bg-border z-0" />
        {/* Progress fill */}
        {!isIssue && currentIdx > 0 && (
          <div
            className="absolute top-3 left-3 h-px bg-success z-0 transition-all duration-500"
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
                done    ? 'bg-success border-success' :
                current ? 'bg-card border-primary shadow-sm' :
                isIssue && i <= currentIdx ? 'bg-muted border-border' :
                'bg-card border-border'
              }`}>
                {done    && <CheckCircle2 size={14} className="text-primary-foreground" />}
                {current && <div className="size-2 rounded-full bg-primary" />}
                {!done && !current && <Circle size={10} className="text-muted-foreground" />}
              </div>
              <p
                className={`mt-1.5 text-center hidden md:block ${done ? 'text-success' : current ? 'text-primary' : 'text-muted-foreground'}`}
                style={{ fontSize: 10 }}
              >{step.label}</p>
              <p
                className={`mt-1.5 text-center md:hidden ${done ? 'text-success' : current ? 'text-primary' : 'text-muted-foreground'}`}
                style={{ fontSize: 10 }}
              >{step.short}</p>
              {historyEntry && (
                <p className="text-center text-muted-foreground hidden md:block mt-0.5" style={{ fontSize: 9 }}>
                  {historyEntry.time.split(' ').slice(-2).join(' ')}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {job.statusHistory.length > 0 && (
        <div className="flex flex-col gap-1 mt-4 border-t border-border pt-3">
          {job.statusHistory.map((entry, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`size-1.5 rounded-full shrink-0 ${
                entry.status === 'Completed' ? 'bg-success' :
                entry.status === 'Canceled'  ? 'bg-destructive'   :
                entry.status === 'No Show'   ? 'bg-warning' : 'bg-muted-foreground'
              }`} />
              <span className="text-foreground">{entry.status}</span>
              <span className="text-muted-foreground ml-auto shrink-0">{entry.time}</span>
              {entry.note && (
                <span className="text-muted-foreground italic truncate ml-1 max-w-[140px]">· {entry.note}</span>
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
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className="relative shrink-0">
          <div
            className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"
            style={{ fontSize: 16 }}
          >{initials}</div>
          <span className="absolute -bottom-1 -right-1 text-base">{SERVICE_ICON[job.serviceType]}</span>
        </div>

        <div className="flex-1 min-w-0">
          <button
            onClick={onViewCustomer}
            className="flex items-center gap-1.5 group text-left"
          >
            <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">
              {customer.name}
            </p>
            <ExternalLink size={11} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={`text-xs rounded-full px-1.5 py-0.5 ${svcCfg.bg} ${svcCfg.text}`}>
              {customer.serviceType}
            </span>
            {customer.jobCount > 1 && (
              <span className="text-xs text-muted-foreground">
                {customer.jobCount} jobs · {customer.lastService}
              </span>
            )}
            {isVIP && (
              <span className="flex items-center gap-0.5 text-xs rounded-full bg-warning/15 text-warning px-1.5 py-0.5">
                <Star size={9} className="fill-warning text-warning" /> VIP
              </span>
            )}
          </div>
          {customer.notes && (
            <div className="mt-2 rounded-lg bg-warning/10 border border-warning/20 px-2.5 py-1.5">
              <p className="text-xs text-warning">{customer.notes}</p>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-border divide-x divide-border">
        <button
          onClick={onCall}
          className="flex items-center gap-2 px-3 py-3 hover:bg-success/10 transition-colors group text-left"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-success/15 shrink-0 group-hover:bg-success/15 transition-colors">
            <Phone size={13} className="text-success" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Phone</p>
            <p className="text-sm text-foreground truncate">{customer.phone}</p>
          </div>
        </button>

        <button
          onClick={onText}
          className="flex items-center gap-2 px-3 py-3 hover:bg-primary/10 transition-colors group text-left"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 shrink-0 group-hover:bg-primary/15 transition-colors">
            <MessageSquare size={13} className="text-primary" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Text</p>
            <p className="text-sm text-foreground truncate">{customer.phone}</p>
          </div>
        </button>

        <a
          href={mapsUrl}
          target="_blank"
          rel="noreferrer"
          className="col-span-2 flex items-center gap-2 px-3 py-3 hover:bg-primary/10 transition-colors group"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 shrink-0 group-hover:bg-primary/15 transition-colors">
            <MapPin size={13} className="text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Address</p>
            <p className="text-sm text-foreground truncate">{customer.address}</p>
          </div>
          <Navigation size={12} className="text-primary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>

        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className="col-span-2 flex items-center gap-2 px-3 py-3 hover:bg-secondary transition-colors border-t border-border"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-secondary shrink-0">
              <Mail size={13} className="text-muted-foreground" />
            </span>
            <p className="text-sm text-foreground truncate">{customer.email}</p>
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Schedule + Tech Card ──────────────────────────────────────────────────
function ScheduleTechCard({ job, tech, onCallTech, onSchedule, workerTerm }: {
  job: Job; tech: Technician | undefined; onCallTech: () => void; onSchedule: () => void; workerTerm: string;
}) {
  const techStatusLabel =
    job.status === 'Active' || job.status === 'In Progress' ? 'On site now' :
    job.status === 'Scheduled' ? 'Dispatching soon' :
    job.status === 'Completed' ? 'Job complete' : '';

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="px-4 py-4">
          <div className="flex items-center gap-1.5 mb-3">
            <Calendar size={13} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Schedule</p>
          </div>
          {job.scheduledDate ? (
            <>
              <p className="text-foreground mb-0.5">{job.scheduledDate}</p>
              {job.scheduledTime && (
                <p className="text-2xl text-foreground leading-none">{job.scheduledTime}</p>
              )}
              <p className="text-xs text-muted-foreground mt-2">Est. 2–3 hours</p>
            </>
          ) : (
            <div>
              <p className="text-sm text-muted-foreground italic">Not scheduled</p>
              <button onClick={onSchedule} className="text-xs text-primary hover:underline mt-1">Schedule now →</button>
            </div>
          )}
        </div>

        <div className="px-4 py-4">
          <div className="flex items-center gap-1.5 mb-3">
            <User size={13} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{workerTerm}</p>
          </div>
          {tech ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-primary-foreground"
                  style={{ background: tech.color, fontSize: 12 }}
                >{tech.initials}</span>
                <div>
                  <p className="text-sm text-foreground">{tech.name}</p>
                  {techStatusLabel && (
                    <p className="text-xs text-success">{techStatusLabel}</p>
                  )}
                </div>
              </div>
              <button
                onClick={onCallTech}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-success transition-colors"
              >
                <Phone size={11} /> {tech.phone}
              </button>
            </>
          ) : (
            <button onClick={onSchedule} className="flex items-center gap-1.5 text-sm text-primary hover:text-primary transition-colors">
              <Plus size={13} /> Assign {workerTerm.toLowerCase()}
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
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex items-center gap-2 mb-2">
          <FileText size={13} className="text-muted-foreground" />
          <h4 className="text-foreground">Description</h4>
        </div>
        <p className="text-sm text-foreground leading-relaxed">{job.description}</p>
      </div>
      {job.notes && (
        <div className="border-t border-warning/20 bg-warning/10 px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap size={12} className="text-warning" />
            <p className="text-xs text-warning">Access Notes</p>
          </div>
          <p className="text-sm text-warning leading-relaxed">{job.notes}</p>
        </div>
      )}
    </div>
  );
}

// ─── Estimate Scope Card ──────────────────────────────────────────────────
function EstimateScopeCard({ estimateId, onOpen }: { estimateId: string; onOpen: () => void }) {
  const [estimate, setEstimate] = useState<{
    estimateNumber: string;
    status: string;
    lineItems: Array<{ description: string; qty: number; rate: number }>;
  } | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/api/estimates/${estimateId}`);
      if (!res.ok || cancelled) return;
      const body = await res.json();
      const items = (body.lineItems ?? []).map(
        (li: { description: string; quantity: number; unitPriceCents: number }) => ({
          description: li.description,
          qty: li.quantity,
          rate: li.unitPriceCents / 100,
        }),
      );
      if (!cancelled && items.length > 0) {
        setEstimate({
          estimateNumber: body.estimateNumber ?? estimateId,
          status: body.status ?? 'draft',
          lineItems: items,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [estimateId]);

  if (!estimate) return null;

  const total = calcEstimateTotalFromLines(estimate.lineItems);

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <FileText size={14} className="text-primary shrink-0" />
          <h4 className="text-foreground">Estimate Scope</h4>
          <span className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5">
            {estimate.estimateNumber}
          </span>
          <StatusBadge status={estimate.status as 'Draft'} size="sm" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onOpen} className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors">
            <Eye size={11} /> Full view
          </button>
          <button onClick={() => setOpen(v => !v)} className="text-muted-foreground hover:text-foreground transition-colors">
            <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_40px_70px_70px] gap-x-2 px-4 py-2 bg-secondary border-b border-border">
            <p className="text-xs text-muted-foreground">Item</p>
            <p className="text-xs text-muted-foreground text-right">Qty</p>
            <p className="text-xs text-muted-foreground text-right">Rate</p>
            <p className="text-xs text-muted-foreground text-right">Total</p>
          </div>

          <div className="divide-y divide-border">
            {estimate.lineItems.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_40px_70px_70px] gap-x-2 px-4 py-2.5 items-center">
                <p className="text-sm text-foreground leading-snug">{item.description}</p>
                <p className="text-sm text-muted-foreground text-right">{item.qty}</p>
                <p className="text-sm text-muted-foreground text-right">${item.rate.toLocaleString()}</p>
                <p className="text-sm text-foreground text-right">${(item.qty * item.rate).toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-4 py-3.5 border-t border-border bg-primary rounded-b-xl">
            <p className="text-sm text-muted-foreground">Agreed total</p>
            <p className="text-primary-foreground">${total.toLocaleString()}</p>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Materials Table ──────────────────────────────────────────────────────
const CAT_CONFIG: Record<MaterialItem['category'], { label: string; dot: string; text: string; bg: string }> = {
  Part:      { label: 'Parts',     dot: 'bg-primary',   text: 'text-primary',   bg: 'bg-primary/10'   },
  Material:  { label: 'Materials', dot: 'bg-success',  text: 'text-success',  bg: 'bg-success/10'  },
  Labor:     { label: 'Labor',     dot: 'bg-primary', text: 'text-primary', bg: 'bg-primary/10' },
  Equipment: { label: 'Equipment', dot: 'bg-warning',  text: 'text-warning',  bg: 'bg-warning/10'  },
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
      <div className="rounded-xl bg-card border border-border px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-warning" />
            <h4 className="text-foreground">Materials & Parts</h4>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onSuppliers} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <MapPin size={12} /> Find parts
            </button>
            <button onClick={onEdit} className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors">
              <Plus size={12} /> Add parts
            </button>
          </div>
        </div>
        <button
          onClick={onEdit}
          className="flex flex-col items-center gap-2 py-8 w-full rounded-xl border-2 border-dashed border-border hover:border-warning/30 hover:bg-warning/10 transition-colors"
        >
          <Package size={24} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No materials logged yet</p>
          <p className="text-xs text-muted-foreground">Tap to add parts & materials used</p>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-warning" />
          <h4 className="text-foreground">Materials & Parts</h4>
          <span className="text-xs bg-secondary text-muted-foreground rounded-full px-2 py-0.5">{materials.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onSuppliers} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <MapPin size={12} /> Find parts
          </button>
          <button onClick={onEdit} className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors">
            <Plus size={12} /> Edit
          </button>
        </div>
      </div>

      <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 bg-secondary border-b border-border">
        <p className="text-xs text-muted-foreground">Item / Part #</p>
        <p className="text-xs text-muted-foreground text-right w-8">Qty</p>
        <p className="text-xs text-muted-foreground text-right w-20">Unit cost</p>
        <p className="text-xs text-muted-foreground text-right w-20">Total</p>
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
              <div key={m.id} className={`px-4 py-3 ${i < items.length - 1 ? 'border-b border-border' : ''}`}>
                <div className="flex items-center justify-between gap-2 md:hidden">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{m.name}</p>
                    {m.partNumber && <p className="text-xs text-muted-foreground">{m.partNumber}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground">×{m.qty} @ ${m.unitCost}/ea</p>
                    <p className="text-sm text-foreground">${(m.qty * m.unitCost).toFixed(2)}</p>
                  </div>
                </div>
                <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{m.name}</p>
                    {m.partNumber && <p className="text-xs text-muted-foreground mt-0.5">{m.partNumber}</p>}
                  </div>
                  <p className="text-sm text-muted-foreground text-right w-8">×{m.qty}</p>
                  <p className="text-sm text-muted-foreground text-right w-20">${m.unitCost.toFixed(2)}</p>
                  <p className="text-sm text-foreground text-right w-20">${(m.qty * m.unitCost).toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      <div className="flex items-center justify-between px-4 py-3.5 bg-primary text-primary-foreground">
        <p className="text-sm">Total materials cost</p>
        <p className="text-sm">${total.toFixed(2)}</p>
      </div>
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
  amber:  { bg: 'bg-warning/10',  icon: 'text-warning',  btn: 'bg-warning  hover:bg-warning/90'  },
  blue:   { bg: 'bg-primary/10',   icon: 'text-primary',   btn: 'bg-primary   hover:bg-primary/90'   },
  violet: { bg: 'bg-primary/10', icon: 'text-primary', btn: 'bg-primary hover:bg-primary/90' },
  indigo: { bg: 'bg-primary/10', icon: 'text-primary', btn: 'bg-primary hover:bg-primary/90' },
  green:  { bg: 'bg-success/10',  icon: 'text-success',  btn: 'bg-success  hover:bg-success/90'  },
};

function AIHintsPanel({ hints, onAction }: { hints: AIHint[]; onAction: (a: Modal) => void }) {
  if (!hints.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Zap size={13} className="text-primary" />
        <p className="text-sm text-foreground">AI Suggestions</p>
      </div>
      <div className="flex flex-col divide-y divide-border">
        {hints.map(hint => {
          const cfg  = HINT_CFG[hint.color] ?? HINT_CFG.blue;
          const Icon = hint.icon;
          return (
            <div key={hint.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`flex size-7 shrink-0 items-center justify-center rounded-full mt-0.5 ${cfg.bg}`}>
                <Icon size={13} className={cfg.icon} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground">{hint.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{hint.desc}</p>
              </div>
              {hint.action && (
                <button
                  onClick={() => onAction(hint.action)}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-primary-foreground transition-colors ${cfg.btn}`}
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
    <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-sm text-warning">Possible duplicate detected</p>
            <span className="text-xs bg-warning/15 text-warning rounded-full px-2 py-0.5">{warning.similarity}% match</span>
          </div>
          <p className="text-xs text-warning">{warning.reason}</p>
          <div className="flex items-center gap-3 mt-2.5">
            <button className="flex items-center gap-1 text-xs text-warning hover:text-warning underline underline-offset-2">
              <ExternalLink size={11} /> View Job #{warning.matchJobNumber}
            </button>
            <button onClick={onDismiss} className="text-xs text-warning hover:text-warning transition-colors">
              Continue as new
            </button>
          </div>
        </div>
        <button onClick={onDismiss} className="text-warning hover:text-warning"><X size={14} /></button>
      </div>
    </div>
  );
}

function IssueBanner({ job, onText, onReschedule }: { job: Job; onText: () => void; onReschedule: () => void }) {
  if (job.status !== 'Canceled' && job.status !== 'No Show') return null;
  const isCanceled = job.status === 'Canceled';
  return (
    <div className={`rounded-xl border px-4 py-3.5 ${isCanceled ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning/10'}`}>
      <div className="flex items-start gap-3">
        {isCanceled
          ? <X size={16} className="text-destructive shrink-0 mt-0.5" />
          : <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
        }
        <div>
          <p className={`text-sm ${isCanceled ? 'text-destructive' : 'text-warning'}`}>
            {isCanceled ? 'Job canceled' : 'No-show recorded'}
          </p>
          <p className={`text-xs mt-0.5 ${isCanceled ? 'text-destructive' : 'text-warning'}`}>
            {job.cancelReason ?? job.noShowNotes}
          </p>
          <div className="flex gap-3 mt-2.5">
            <button onClick={onReschedule} className={`text-xs underline underline-offset-2 ${isCanceled ? 'text-destructive' : 'text-warning'}`}>
              Reschedule
            </button>
            <button onClick={onText} className={`text-xs underline underline-offset-2 ${isCanceled ? 'text-destructive' : 'text-warning'}`}>
              Text customer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────
export interface JobDetailViewProps {
  id: string;
  /** Test seams for the persisted photo pipeline (default to the real API). */
  uploadPhoto?: (
    jobId: string,
    file: File,
    category: JobPhotoCategory,
    notes?: string,
    takenAt?: string,
  ) => Promise<JobPhoto>;
  fetchPhotos?: (jobId: string) => Promise<JobPhoto[]>;
  deletePhoto?: (jobId: string, photoId: string) => Promise<void>;
}

export function JobDetailView({
  id,
  uploadPhoto = uploadJobPhotoApi,
  fetchPhotos = listJobPhotosApi,
  deletePhoto = deleteJobPhotoApi,
}: JobDetailViewProps) {
  const navigate = useNavigate();
  const apiFetch = useApiClient();
  const workerTerm = useWorkerTerm();
  const timezone = useTenantTimezone();
  const { user } = useUser();
  const ownerLabel = `${firstNameFromUser(user?.fullName, user?.primaryEmailAddress?.emailAddress)} (owner)`;

  const { data: apiJob, isLoading, error, refetch: refetchJob } = useDetailQuery<JobDetailResponse>('/api/jobs', id);
  const { mutate: transitionJob } = useMutation<{ status: string; reason?: string }, JobDetailResponse>('POST', `/api/jobs/${id}/transition`);

  // Real linked documents / schedule, derived from the jobId-filtered lists
  // below. buildJobCompat leaves these unset, so without these fetches the
  // estimate/invoice actions and the schedule card had nothing to point at.
  const [estimateId, setEstimateId] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [appointmentStart, setAppointmentStart] = useState<string | null>(null);

  const job = apiJob ? buildJobCompat(apiJob) : null;
  if (job) {
    // Splice the fetched linked-doc ids + scheduled instant onto the compat
    // job so the stepper hints, estimate/invoice actions, and schedule card
    // read real data (not the always-undefined buildJobCompat defaults).
    job.estimateId = estimateId ?? undefined;
    job.invoiceId = invoiceId ?? undefined;
    if (appointmentStart) {
      job.scheduledDate = formatDateInTenantTz(appointmentStart, timezone, { withYear: true });
      job.scheduledTime = formatTimeInTenantTz(appointmentStart, timezone);
    }
  }
  const customer = apiJob?.customer ? buildCustomerCompat(apiJob.customer) : undefined;
  const tech: Technician | undefined = apiJob?.technician ? {
    id: apiJob.technician.id,
    name: [apiJob.technician.firstName, apiJob.technician.lastName].filter(Boolean).join(' '),
    initials: [apiJob.technician.firstName?.[0], apiJob.technician.lastName?.[0]].filter(Boolean).join(''),
    color: apiJob.technician.color ?? '#94a3b8',
    phone: '',
    activeJobs: 0,
  } : undefined;

  const [modal,         setModal]         = useState<Modal>(null);
  const [cameraOpen,    setCameraOpen]    = useState(false);
  // U9 (E7): captured photos persist to the backend (presign→PUT→attach) and
  // are rendered from the server, so they survive reloads and are visible to
  // every user/session on this job.
  const [photos,        setPhotos]        = useState<JobPhoto[]>([]);
  const [photoCategory, setPhotoCategory] = useState<JobPhotoCategory | 'all'>('all');
  const [photoError,    setPhotoError]    = useState<string | null>(null);
  const [photoSaving,   setPhotoSaving]   = useState(false);
  const [activities,    setActivities]    = useState<JobActivity[]>([]);
  const [materials,     setMaterials]     = useState<MaterialItem[]>([]);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Time entries state
  const [timeEntries, setTimeEntries] = useState<Array<{
    id: string; entryType: string; clockedInAt: string;
    clockedOutAt?: string; durationMinutes?: number; notes?: string;
  }>>([]);
  const [showTimeForm, setShowTimeForm] = useState(false);
  const [timeFormStart, setTimeFormStart] = useState('09:00');
  const [timeFormEnd, setTimeFormEnd] = useState('11:30');
  const [timeFormType, setTimeFormType] = useState<'job' | 'drive'>('job');
  const [timeFormSaving, setTimeFormSaving] = useState(false);

  const loadTimeEntries = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiFetch(`/api/time-entries?jobId=${id}`);
      if (!res.ok) return;
      const entries = await res.json();
      setTimeEntries(Array.isArray(entries) ? entries : []);
    } catch { /* non-fatal */ }
  }, [id]);

  useEffect(() => { loadTimeEntries(); }, [loadTimeEntries]);

  // U9 (E7): load persisted job photos; refetch after each capture so the
  // gallery reflects the server, not transient local state.
  const loadPhotos = useCallback(async () => {
    if (!id) return;
    try {
      setPhotos(await fetchPhotos(id));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Failed to load photos');
    }
  }, [id, fetchPhotos]);

  useEffect(() => { void loadPhotos(); }, [loadPhotos]);

  // Convert each captured data-URL into a File and persist it through the
  // job-photos pipeline. Surfaces any failure instead of claiming success.
  const persistCapturedMedia = useCallback(
    async (captured: CapturedMedia[]) => {
      if (!id || captured.length === 0) return;
      setPhotoSaving(true);
      setPhotoError(null);
      for (const item of captured) {
        try {
          const file = await capturedMediaToFile(item);
          const category: JobPhotoCategory = item.type === 'video' ? 'other' : 'before';
          await uploadPhoto(id, file, category, undefined, item.capturedAt);
        } catch (err) {
          // Surface the failure; the loop continues so other captures still upload.
          setPhotoError(err instanceof Error ? err.message : 'Photo upload failed');
        }
      }
      await loadPhotos();
      setPhotoSaving(false);
    },
    [id, uploadPhoto, loadPhotos],
  );

  // U2 (E9 follow-up): delete a wrong photo/video behind a confirm. On success
  // drop the row from local state; on failure surface the error and keep the
  // photo (no phantom removal). The DELETE endpoint audits + gates server-side.
  const handleDeletePhoto = useCallback(
    async (photo: JobPhoto) => {
      if (!id) return;
      if (!window.confirm('Delete this photo? This cannot be undone.')) return;
      setPhotoError(null);
      try {
        await deletePhoto(id, photo.id);
        setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : 'Failed to delete photo');
      }
    },
    [id, deletePhoto],
  );

  async function saveTimeEntry() {
    if (!timeFormStart || !timeFormEnd) return;
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    const startISO = new Date(today + 'T' + timeFormStart).toISOString();
    const endISO   = new Date(today + 'T' + timeFormEnd).toISOString();
    setTimeFormSaving(true);
    try {
      const clockInRes = await apiFetch('/api/time-entries/clock-in', {
        method: 'POST',
        body: JSON.stringify({ jobId: id, entryType: timeFormType, clockedInAt: startISO }),
      });
      if (!clockInRes.ok) return;
      await apiFetch('/api/time-entries/clock-out', {
        method: 'POST',
        body: JSON.stringify({ clockedOutAt: endISO }),
      });
      setShowTimeForm(false);
      await loadTimeEntries();
    } catch { /* non-fatal */ } finally {
      setTimeFormSaving(false);
    }
  }

  // Load persisted notes from API on mount / job change
  const loadNotes = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiFetch(`/api/notes?entityType=job&entityId=${id}`);
      if (!res.ok) return;
      const notes: Array<{ id: string; content: string; authorRole: string; createdAt: string }> = await res.json();
      const mapped: JobActivity[] = notes.map(n => ({
        id: n.id,
        type: 'note' as const,
        content: n.content,
        time: new Date(n.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        author: n.authorRole,
        authorInitials: n.authorRole[0]?.toUpperCase() ?? 'U',
        authorColor: '#475569',
      }));
      setActivities(mapped);
    } catch {
      // non-fatal
    }
  }, [id]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  // Load the job's real linked documents + schedule. Each endpoint returns a
  // bare array for a jobId lookup; we take the most recent of each. Non-fatal:
  // a failed fetch just leaves the derived id null (action stays disabled).
  const loadLinkedDocs = useCallback(async () => {
    if (!id) return;
    const first = async (path: string): Promise<{ id?: string; scheduledStart?: string } | null> => {
      try {
        const res = await apiFetch(path);
        if (!res.ok) return null;
        const list = await res.json();
        return Array.isArray(list) && list.length > 0 ? list[0] : null;
      } catch {
        return null;
      }
    };
    const [est, inv, appt] = await Promise.all([
      first(`/api/estimates?jobId=${id}`),
      first(`/api/invoices?jobId=${id}`),
      first(`/api/appointments?jobId=${id}`),
    ]);
    setEstimateId(est?.id ?? null);
    setInvoiceId(inv?.id ?? null);
    setAppointmentStart(appt?.scheduledStart ?? null);
  }, [id, apiFetch]);

  useEffect(() => { void loadLinkedDocs(); }, [loadLinkedDocs]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner size="md" className="text-foreground" label="Loading job" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto pb-20 p-6">
        <button onClick={() => navigate('/jobs')} className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <ArrowLeft size={14} /> Back
        </button>
        <ErrorState message="Failed to load job." onRetry={refetchJob} />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="h-full overflow-y-auto pb-20 p-6">
        <button onClick={() => navigate('/jobs')} className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <ArrowLeft size={14} /> Back
        </button>
        <EmptyState
          title="Job not found."
          description="This job may have been deleted, or you don't have access to it."
          actionLabel="Back to jobs"
          onAction={() => navigate('/jobs')}
        />
      </div>
    );
  }

  const customerPhone = customer?.phone ?? '(512) 555-0000';
  const mapsUrl       = `https://maps.google.com/?q=${encodeURIComponent(job.address)}`;
  const hints         = getAIHints(job, materials, customer);

  async function addActivity(entry: Partial<JobActivity>) {
    // Optimistically add to local state
    const localActivity: JobActivity = {
      id: `new-${Date.now()}`, type: 'note', content: '', time: 'Just now', ...entry,
    };
    setActivities(prev => [...prev, localActivity]);

    // Persist note entries to the API
    if (entry.type === 'note' && entry.content && id) {
      try {
        await apiFetch('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            entityType: 'job',
            entityId: id,
            content: entry.content,
          }),
        });
        // Reload from API to get the server-assigned ID and timestamp
        await loadNotes();
      } catch {
        // non-fatal: note remains in local state even if persist fails
      }
    }
  }

  const secondaryActions = [
    { key: 'camera',   icon: Camera,        label: 'Photos',   badge: photos.length, disabled: false },
    { key: 'estimate', icon: Eye,           label: 'Estimate', badge: 0,               disabled: !job.estimateId },
    { key: 'invoice',  icon: Receipt,       label: 'Invoice',  badge: 0,               disabled: false },
    { key: 'addEntry', icon: FileText,      label: 'Note',     badge: 0,               disabled: false },
    { key: 'materials',icon: Package,       label: 'Parts',    badge: 0,               disabled: false },
    { key: 'cancel',   icon: MoreHorizontal,label: 'More',     badge: 0,               disabled: false },
  ];

  function onSecondaryAction(key: string) {
    if      (key === 'camera')                    setCameraOpen(true);
    else if (key === 'estimate' && job?.estimateId) setModal('estimate');
    else if (key === 'invoice')                    setModal('invoice');
    else if (key === 'addEntry')                   setModal('addEntry');
    else if (key === 'materials')                  setModal('materials');
    else if (key === 'cancel')                     setModal('cancel');
  }

  // NOTE: LeftContent / RightRail are render helpers, invoked as
  // `{LeftContent()}` — NOT mounted as `<LeftContent />`. Mounting them would
  // create a brand-new component type every parent render, unmounting and
  // remounting the whole subtree (Time Tracking inputs lost focus per
  // keystroke; child cards refetched). Calling them splices their elements
  // straight into this component's tree. They must not use hooks.
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
      <ScheduleTechCard job={job} tech={tech} onCallTech={() => setModal('call')} onSchedule={() => navigate('/schedule')} workerTerm={workerTerm} />
      <DescriptionCard job={job} />
      {job.estimateId && (
        <EstimateScopeCard
          estimateId={job.estimateId}
          onOpen={() => setModal('estimate')}
        />
      )}
      <MaterialsTable materials={materials} onEdit={() => setModal('materials')} onSuppliers={() => setModal('suppliers')} />

      {/* Sweep-2 S4 — job P&L rollup (invoices:view-gated; hides itself
          when the report is unavailable or the viewer lacks access). */}
      <JobProfitCard jobId={job.id} />

      {/* ── Time Entries ── */}
      <div className="rounded-xl bg-card border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-muted-foreground" />
            <h4 className="text-foreground">Time Tracking</h4>
          </div>
          <div className="flex items-center gap-2">
            {timeEntries.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Total: {Math.floor(timeEntries.reduce((s, e) => s + (e.durationMinutes ?? 0), 0) / 60)}h{' '}
                {timeEntries.reduce((s, e) => s + (e.durationMinutes ?? 0), 0) % 60}m
              </span>
            )}
            <button
              onClick={() => setShowTimeForm(p => !p)}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary"
            >
              <Plus size={12} /> Add entry
            </button>
          </div>
        </div>
        {showTimeForm && (
          <div className="px-4 py-3 border-b border-border bg-secondary flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Start time
              <Input type="time" value={timeFormStart} onChange={e => setTimeFormStart(e.target.value)}
                className="min-h-11" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              End time
              <Input type="time" value={timeFormEnd} onChange={e => setTimeFormEnd(e.target.value)}
                className="min-h-11" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Type
              <Select value={timeFormType} onChange={e => setTimeFormType(e.target.value as 'job' | 'drive')}
                className="min-h-11">
                <option value="job">Job work</option>
                <option value="drive">Travel / Drive</option>
              </Select>
            </label>
            <button onClick={saveTimeEntry} disabled={timeFormSaving}
              className="rounded-lg bg-primary text-primary-foreground text-xs px-3 py-1.5 disabled:opacity-50">
              {timeFormSaving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setShowTimeForm(false)} className="text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        )}
        <div className="divide-y divide-border">
          {timeEntries.length === 0 && !showTimeForm && (
            <p className="px-4 py-3 text-xs text-muted-foreground italic">No time entries yet</p>
          )}
          {timeEntries.map(entry => {
            const start = new Date(entry.clockedInAt);
            const end = entry.clockedOutAt ? new Date(entry.clockedOutAt) : null;
            const mins = entry.durationMinutes ?? 0;
            const label = entry.entryType === 'drive' ? 'Travel' : 'Job work';
            return (
              <div key={entry.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">
                    {start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {end ? ` – ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (in progress)'}
                  </p>
                </div>
                {mins > 0 && (
                  <span className="text-sm text-foreground font-medium">
                    {Math.floor(mins / 60)}h {mins % 60}m
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl bg-card border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Camera size={14} className="text-muted-foreground" />
            <h4 className="text-foreground">Site Media</h4>
            {photos.length > 0 && (
              <span className="text-xs bg-secondary text-muted-foreground rounded-full px-2 py-0.5">{photos.length}</span>
            )}
          </div>
          <button
            data-testid="site-media-add"
            onClick={() => setCameraOpen(true)}
            disabled={photoSaving}
            className="flex items-center gap-1 min-h-11 px-2 text-xs text-primary hover:text-primary transition-colors disabled:opacity-50"
          >
            <Camera size={12} /> {photoSaving ? 'Saving…' : 'Add'}
          </button>
        </div>
        <div className="p-3">
          {photoError && (
            <p data-testid="job-photo-error" role="alert" className="mb-2 text-sm text-destructive">
              {photoError}
            </p>
          )}
          <JobPhotoGallery
            photos={photos}
            activeCategory={photoCategory}
            onCategoryChange={setPhotoCategory}
            onDelete={handleDeletePhoto}
          />
        </div>
      </div>

      <JobCustomFieldsPanel jobId={id} />
      <JobFormsPanel jobId={id} />
    </div>
  );

  const RightRail = () => (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
          <h4 className="text-foreground">Activity Log</h4>
          <button
            onClick={() => setModal('addEntry')}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors"
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
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft size={14} /> Back to Jobs
            </button>
            {tech && (
              <button
                onClick={() => navigate(`/jobs/${job.id}?view=tech`)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <Cpu size={12} /> Tech View
              </button>
            )}
          </div>

          {/* Banners */}
          <div className="flex flex-col gap-3 mb-5">
            {transitionError && (
              <p data-testid="job-transition-error" role="alert" className="text-sm text-destructive">
                {transitionError}
              </p>
            )}
            {showDuplicate && job.duplicateWarning && (
              <DuplicateBanner warning={job.duplicateWarning} onDismiss={() => setShowDuplicate(false)} />
            )}
            <IssueBanner job={job} onText={() => setModal('text')} onReschedule={() => navigate('/schedule')} />
          </div>

          {/* Page header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary text-2xl shrink-0">
                {SERVICE_ICON[job.serviceType]}
              </div>
              <div>
                <h1 className="text-foreground" style={{ fontSize: '1.15rem', lineHeight: 1.2 }}>
                  {job.customer}
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Job #{job.jobNumber} · {job.serviceType}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {job.priority === 'Urgent' && <StatusBadge status="Urgent" />}
              <StatusBadge status={job.status} />
              {/* Status transition control */}
              {job.status !== 'Completed' && job.status !== 'Canceled' && (
                <select
                  className="text-xs rounded-lg border border-border px-2 py-1 text-foreground bg-card cursor-pointer hover:border-border"
                  value=""
                  onChange={async (e) => {
                    const newStatus = e.target.value;
                    if (!newStatus) return;
                    setTransitionError(null);
                    try {
                      // §5.8 — the API rejects backward moves (in_progress →
                      // scheduled) without a recorded reason.
                      const backward = apiJob?.status === 'in_progress' && newStatus === 'scheduled';
                      await transitionJob(
                        backward
                          ? { status: newStatus, reason: 'Rescheduled from job detail' }
                          : { status: newStatus },
                      );
                      // Reload job data to reflect new status in UI
                      await refetchJob();
                    } catch (err) {
                      setTransitionError(err instanceof Error ? err.message : 'Failed to update job status');
                    }
                  }}
                  title="Change job status"
                >
                  <option value="" disabled>Change status…</option>
                  {/* Only show valid transitions from the current API status */}
                  {apiJob?.status === 'new' && <option value="scheduled">→ Scheduled</option>}
                  {apiJob?.status === 'scheduled' && <option value="in_progress">→ In Progress</option>}
                  {apiJob?.status === 'in_progress' && (
                    <>
                      <option value="completed">→ Completed</option>
                      <option value="scheduled">← Scheduled (reschedule)</option>
                    </>
                  )}
                </select>
              )}
            </div>
          </div>

          {/* Primary actions */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[
              { icon: Phone,         label: 'Call',       sub: customerPhone.split(' ')[0],  onClick: () => setModal('call'),              bg: 'bg-success  hover:bg-success/90'  },
              { icon: MessageSquare, label: 'Text',       sub: 'Send message',                onClick: () => setModal('text'),              bg: 'bg-primary   hover:bg-primary/90'   },
              { icon: Navigation,    label: 'Directions', sub: job.address.split(',')[0],     onClick: () => window.open(mapsUrl, '_blank'), bg: 'bg-primary hover:bg-primary/90' },
            ].map(({ icon: Icon, label, sub, onClick, bg }) => (
              <button
                key={label}
                onClick={onClick}
                className={`flex flex-col items-center gap-2 rounded-xl py-4 text-primary-foreground transition-colors active:scale-95 ${bg}`}
              >
                <Icon size={20} />
                <div className="text-center">
                  <p className="text-sm">{label}</p>
                  {sub && <p className="text-xs text-primary-foreground/70 truncate max-w-[80px]">{sub}</p>}
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
                className={`relative flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:border-border hover:bg-secondary transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <Icon size={14} className="text-muted-foreground" />
                {label}
                {badge > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground border-2 border-primary-foreground" style={{ fontSize: 8 }}>
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
                <Zap size={12} className="text-primary" />
                <p className="text-xs text-muted-foreground">Suggested actions</p>
              </div>
              {hints.map(h => {
                const cfg   = HINT_CFG[h.color] ?? HINT_CFG.blue;
                const HIcon = h.icon;
                return (
                  <div key={h.id} className={`flex items-center gap-3 rounded-xl border border-border px-3 py-3 ${cfg.bg}`}>
                    <HIcon size={15} className={cfg.icon} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{h.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{h.desc}</p>
                    </div>
                    {h.action && (
                      <button
                        onClick={() => setModal(h.action)}
                        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs text-primary-foreground transition-colors ${cfg.btn}`}
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
            {LeftContent()}
            <div className="sticky top-0">
              {RightRail()}
            </div>
          </div>

          {/* Mobile single column */}
          <div className="md:hidden flex flex-col gap-4">
            {LeftContent()}
            <div className="rounded-xl bg-card border border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
                <h4 className="text-foreground">Activity Log</h4>
                <button
                  onClick={() => setModal('addEntry')}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary transition-colors"
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
      {modal === 'text'     && customer   && <TextSheet name={customer.name} phone={customerPhone} customerId={customer.id} onClose={() => setModal(null)} />}
      {modal === 'estimate' && job.estimateId && <EstimateSheet jobId={job.id} onClose={() => setModal(null)} />}
      {modal === 'invoice'  && (
        <InvoiceSheet
          jobId={job.id}
          customerName={job.customer}
          customerPhone={customerPhone}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'addEntry' && (
        <AddEntrySheet
          jobId={id}
          author={tech?.name ?? ownerLabel}
          authorInitials={tech?.initials ?? [ownerLabel[0], ownerLabel.split(' ')[1]?.[0]].filter(Boolean).join('').toUpperCase()}
          authorColor={tech?.color ?? '#475569'}
          onClose={() => setModal(null)}
          onSubmit={entry => {
            void addActivity(entry);
            // AddEntrySheet persists Photo-tab captures via the job-photos
            // client; reload the server-backed gallery so they appear.
            if (entry.type === 'photo') void loadPhotos();
            setModal(null);
          }}
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
          customerId={customer.id}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'suppliers' && (
        <SuppliersSheet serviceType={job.serviceType} onClose={() => setModal(null)} />
      )}

      {cameraOpen && (
        <CameraCapture
          onClose={newMedia => {
            setCameraOpen(false);
            void persistCapturedMedia(newMedia);
          }}
        />
      )}
    </>
  );
}