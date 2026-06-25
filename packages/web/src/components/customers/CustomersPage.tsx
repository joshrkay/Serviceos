import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, Plus, ChevronRight, MapPin, X, Check,
  AlertTriangle, FileText, Briefcase, ArrowLeft,
  User, Phone, Mail,
} from 'lucide-react';
import type { ServiceType } from '../../data/mock-data';
import type { Customer, CustomerListItem } from '@ai-service-os/shared';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { nameSimilarity, FUZZY_NAME_THRESHOLD } from '../../utils/name-similarity';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { NewEstimateFlow } from '../estimates/NewEstimateFlow';
import { NewJobFlow } from '../jobs/NewJobFlow';

// Service type is a category, not a status — Path A keeps the chip calm and
// neutral; the emoji (SVC_ICON) + label carry the per-type distinction.
const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-secondary text-foreground border-border',
  Plumbing: 'bg-secondary text-foreground border-border',
  Painting: 'bg-secondary text-foreground border-border',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

function customerDisplayName(c: CustomerListItem): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';
}

function customerServiceTypes(c: CustomerListItem): ServiceType[] {
  // The contract models location serviceTypes as free strings; narrow to the
  // web's local ServiceType union at this single boundary.
  const all = (c.locations ?? []).flatMap(l => l.serviceTypes ?? []);
  return [...new Set(all)] as ServiceType[];
}

// ── Add Customer Sheet ───────────────────────────────────────────
const SERVICE_OPTIONS: ServiceType[] = ['HVAC', 'Plumbing', 'Painting'];

type SheetStep = 'contact' | 'location' | 'done';

function normalizePhone(p: string) { return p.replace(/\D/g, ''); }

// Acquisition channels ("How did you hear about us?") — must mirror the API's
// CUSTOMER_SOURCES enum (packages/api/src/customers/customer.ts).
const CUSTOMER_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'google', label: 'Google' },
  { value: 'social_media', label: 'Social media' },
  { value: 'advertising', label: 'Advertising' },
  { value: 'repeat_client', label: 'Repeat client' },
  { value: 'other', label: 'Other' },
];

interface AddCustomerSheetProps {
  onClose: () => void;
  onNewEstimate: () => void;
  onNewJob: () => void;
  existingCustomers: CustomerListItem[];
  onCreate: () => void;
}

function AddCustomerSheet({ onClose, onNewEstimate, onNewJob, existingCustomers, onCreate }: AddCustomerSheetProps) {
  const navigate = useNavigate();
  const { mutate: createCustomer } = useMutation<Record<string, unknown>, Customer>('POST', '/api/customers');
  const { mutate: createLocation } = useMutation<Record<string, unknown>, { id: string }>('POST', '/api/locations');

  const [step, setStep] = useState<SheetStep>('contact');
  const [form, setForm] = useState({
    name: '', phone: '', email: '', source: '',
    locNickname: 'Home', locAddress: '', locServiceTypes: [] as ServiceType[],
    locNotes: '', locAccessCode: '',
  });
  const [dismissedDupe, setDismissedDupe] = useState(false);

  // ── Live duplicate detection ─────────────────────────────────────
  const phoneDigits = normalizePhone(form.phone);
  const phoneMatch = !dismissedDupe && phoneDigits.length >= 10
    ? existingCustomers.find(c => normalizePhone(c.primaryPhone ?? '') === phoneDigits)
    : null;
  const emailNorm  = form.email.toLowerCase().trim();
  const emailMatch = !dismissedDupe && emailNorm.length >= 5 && emailNorm.includes('@')
    ? existingCustomers.find(c => (c.email ?? '').toLowerCase() === emailNorm)
    : null;
  // 4.4 — fuzzy name match (pg_trgm parity). Only a fallback when phone/email
  // didn't already pin an exact match, so the card surfaces the strongest
  // signal. The server re-checks on save (authoritative).
  const nameTrim = form.name.trim();
  const nameMatch = !dismissedDupe && !phoneMatch && !emailMatch && nameTrim.length >= 3
    ? existingCustomers.find(c => nameSimilarity(nameTrim, customerDisplayName(c)) >= FUZZY_NAME_THRESHOLD)
    : null;
  const duplicate = phoneMatch ?? emailMatch ?? nameMatch;
  const matchReason = phoneMatch
    ? 'Same phone number'
    : emailMatch
      ? 'Same email address'
      : 'Similar name';
  // A fuzzy name hit is a "possible" duplicate; an exact phone/email hit is
  // definite.
  const isFuzzyMatch = !phoneMatch && !emailMatch && !!nameMatch;

  function toggleSvc(s: ServiceType) {
    setForm(f => ({
      ...f,
      locServiceTypes: f.locServiceTypes.includes(s)
        ? f.locServiceTypes.filter(x => x !== s)
        : [...f.locServiceTypes, s],
    }));
  }

  const canGoToLocation = form.name.trim().length > 0;
  const canSave = form.locAddress.trim().length > 0 && form.locServiceTypes.length > 0;

  function splitAddress(value: string) {
    const [street1 = '', city = '', stateZip = ''] = value.split(',').map((part) => part.trim());
    const [state = '', postalCode = ''] = stateZip.split(/\s+/);
    return {
      street1: street1 || value,
      city: city || 'Unknown',
      state: state || 'NA',
      postalCode: postalCode || '00000',
    };
  }

  const stepDots: SheetStep[] = ['contact', 'location'];
  const stepIdx = stepDots.indexOf(step);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-card rounded-t-3xl max-h-[94vh] overflow-hidden flex flex-col"
        style={{ animation: 'slideUp 0.25s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-9 h-1 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
          {step === 'location' && (
            <button onClick={() => setStep('contact')} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft size={16} />
            </button>
          )}
          {step !== 'done' && (
            <div className="flex gap-1.5">
              {stepDots.map((_, i) => (
                <div key={i} className={`rounded-full transition-all duration-200 ${
                  i < stepIdx  ? 'w-2 h-2 bg-primary' :
                  i === stepIdx ? 'w-5 h-2 bg-primary' : 'w-2 h-2 bg-border'
                }`} />
              ))}
            </div>
          )}
          <p className="text-sm text-foreground flex-1">
            {step === 'contact'  ? 'Contact info' :
             step === 'location' ? 'Service location' : 'Customer added'}
          </p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* ── Step 1: Contact ── */}
          {step === 'contact' && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted-foreground">Customer name and contact details.</p>

              <div className="flex flex-col gap-2.5">
                {/* Name */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <User size={14} />
                  </div>
                  <input
                    value={form.name}
                    onChange={e => { setDismissedDupe(false); setForm(f => ({ ...f, name: e.target.value })); }}
                    placeholder="Full name *"
                    autoFocus
                    className={`w-full rounded-xl border pl-10 pr-4 py-3 text-sm focus:outline-none transition-colors ${
                      nameMatch && !dismissedDupe ? 'border-warning/30 bg-warning/5 focus:border-warning' : 'border-border focus:border-primary'
                    }`}
                  />
                </div>

                {/* Phone */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <Phone size={14} />
                  </div>
                  <input
                    value={form.phone}
                    onChange={e => { setDismissedDupe(false); setForm(f => ({ ...f, phone: e.target.value })); }}
                    placeholder="Phone number"
                    type="tel"
                    className={`w-full rounded-xl border pl-10 pr-4 py-3 text-sm focus:outline-none transition-colors ${
                      phoneMatch && !dismissedDupe ? 'border-warning/30 bg-warning/5 focus:border-warning' : 'border-border focus:border-primary'
                    }`}
                  />
                </div>

                {/* Email */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <Mail size={14} />
                  </div>
                  <input
                    value={form.email}
                    onChange={e => { setDismissedDupe(false); setForm(f => ({ ...f, email: e.target.value })); }}
                    placeholder="Email address"
                    type="email"
                    className={`w-full rounded-xl border pl-10 pr-4 py-3 text-sm focus:outline-none transition-colors ${
                      emailMatch && !dismissedDupe ? 'border-warning/30 bg-warning/5 focus:border-warning' : 'border-border focus:border-primary'
                    }`}
                  />
                </div>
              </div>

              {/* ── How did you hear about us? ── */}
              <select
                aria-label="How did you hear about us?"
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
                className="w-full rounded-xl border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:border-primary transition-colors min-h-11"
              >
                <option value="">How did you hear about us? (optional)</option>
                {CUSTOMER_SOURCE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {/* ── Duplicate match card ── */}
              {duplicate && (
                <div
                  className="flex flex-col gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4"
                  style={{ animation: 'fadeUp 0.2s ease' }}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-full bg-warning/20 shrink-0">
                      <AlertTriangle size={13} className="text-warning" />
                    </div>
                    <div>
                      <p className="text-sm text-warning">
                        {isFuzzyMatch ? 'Possible duplicate' : 'Already in your system'}
                      </p>
                      <p className="text-xs text-warning mt-0.5">{matchReason} matches an existing customer</p>
                    </div>
                  </div>

                  {/* Matched customer card */}
                  <div className="flex items-center gap-3 bg-card rounded-xl border border-warning/30 px-3.5 py-3">
                    <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs shrink-0">
                      {customerDisplayName(duplicate).split(' ').map(n => n[0]).join('')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{customerDisplayName(duplicate)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{duplicate.primaryPhone}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => { navigate(`/customers/${duplicate.id}`); onClose(); }}
                      className="flex-1 rounded-xl border border-warning/30 bg-card text-warning py-2.5 text-sm hover:bg-warning/10 transition-colors"
                    >
                      View {customerDisplayName(duplicate).split(' ')[0]}
                    </button>
                    <button
                      onClick={() => setDismissedDupe(true)}
                      className="flex-1 rounded-xl bg-warning text-primary-foreground py-2.5 text-sm hover:bg-warning transition-colors"
                    >
                      Continue creating
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setStep('location')}
                disabled={!canGoToLocation}
                className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors mt-1"
              >
                Next: Add location →
              </button>
            </div>
          )}

          {/* ── Step 2: Location ── */}
          {step === 'location' && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted-foreground">Where do you service <span className="text-foreground">{form.name}</span>?</p>

              <div className="flex flex-col gap-2.5">
                <input
                  value={form.locNickname}
                  onChange={e => setForm(f => ({ ...f, locNickname: e.target.value }))}
                  placeholder="Location name (e.g. Home, Office)"
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
                />
                <input
                  value={form.locAddress}
                  onChange={e => setForm(f => ({ ...f, locAddress: e.target.value }))}
                  placeholder="Street address *"
                  className={`w-full rounded-xl border px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors ${
                    !form.locAddress && form.locNickname ? 'border-border' : 'border-border'
                  }`}
                />

                <div>
                  <p className="text-xs text-muted-foreground mb-2">Service type *</p>
                  <div className="flex gap-2">
                    {SERVICE_OPTIONS.map(s => (
                      <button key={s} onClick={() => toggleSvc(s)}
                        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition-all flex-1 justify-center ${
                          form.locServiceTypes.includes(s)
                            ? `${SVC_CHIP[s]} border-current shadow-sm`
                            : 'border-border text-muted-foreground hover:border-border bg-card'
                        }`}>
                        {SVC_ICON[s]} {s}
                      </button>
                    ))}
                  </div>
                </div>

                <input
                  value={form.locNotes}
                  onChange={e => setForm(f => ({ ...f, locNotes: e.target.value }))}
                  placeholder="Access notes (optional)"
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
                />
                <input
                  value={form.locAccessCode}
                  onChange={e => setForm(f => ({ ...f, locAccessCode: e.target.value }))}
                  placeholder="Gate / lockbox code (optional)"
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              <button
                onClick={async () => {
                  const nameParts = form.name.trim().split(' ');
                  const createdCustomer = await createCustomer({
                    firstName: nameParts[0] || 'New',
                    lastName: nameParts.slice(1).join(' ') || 'Customer',
                    primaryPhone: form.phone || undefined,
                    email: form.email || undefined,
                    source: form.source || undefined,
                  });
                  const address = splitAddress(form.locAddress);
                  await createLocation({
                    customerId: createdCustomer.id,
                    label: form.locNickname || 'Primary',
                    ...address,
                    accessNotes: form.locNotes || undefined,
                    isPrimary: true,
                  });
                  onCreate();
                  setStep('done');
                }}
                disabled={!canSave}
                className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors mt-1"
              >
                Add customer
              </button>
            </div>
          )}

          {/* ── Step 3: Done + next action ── */}
          {step === 'done' && (
            <div className="flex flex-col items-center gap-5 pt-2 pb-4" style={{ animation: 'fadeUp 0.25s ease' }}>
              {/* Success */}
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="relative flex size-16 items-center justify-center">
                  <div className="absolute inset-0 rounded-full bg-success/15 animate-pulse" style={{ animationDuration: '1.2s', animationIterationCount: 1 }} />
                  <div className="relative flex size-16 items-center justify-center rounded-full bg-success/15">
                    <Check size={28} className="text-success" />
                  </div>
                </div>
                <div>
                  <p className="text-foreground" style={{ fontSize: '1.05rem' }}>{form.name} added</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {form.locNickname} · {form.locAddress.split(',')[0]}
                  </p>
                  {form.locServiceTypes.length > 0 && (
                    <div className="flex items-center justify-center gap-1.5 mt-2">
                      {form.locServiceTypes.map(s => (
                        <span key={s} className={`text-xs rounded-full border px-2.5 py-0.5 ${SVC_CHIP[s]}`}>
                          {SVC_ICON[s]} {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* What's next */}
              <div className="w-full">
                <p className="text-xs text-muted-foreground text-center mb-3">What would you like to do next?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={onNewEstimate}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-border bg-card py-5 px-3 hover:border-primary/40 hover:bg-primary/10 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 group-hover:bg-primary/20 transition-colors">
                      <FileText size={20} className="text-primary" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-foreground">New estimate</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Build a quote</p>
                    </div>
                  </button>

                  <button
                    onClick={onNewJob}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-border bg-card py-5 px-3 hover:border-primary/40 hover:bg-primary/10 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 group-hover:bg-primary/20 transition-colors">
                      <Briefcase size={20} className="text-primary" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-foreground">New job</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Schedule work</p>
                    </div>
                  </button>
                </div>
              </div>

              <button
                onClick={onClose}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Done for now
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────
type Filter = 'All' | ServiceType;

export function CustomersPage() {
  const navigate = useNavigate();
  const [filter,       setFilter]       = useState<Filter>('All');
  const [tagFilter,    setTagFilter]    = useState<string>('');
  const [showAdd,      setShowAdd]      = useState(false);
  const [showEstimate, setShowEstimate] = useState(false);
  const [showJob,      setShowJob]      = useState(false);

  const { data, total, isLoading, error, setSearch, refetch } = useListQuery<CustomerListItem>('/api/customers');

  // 4.8 — tags filterable in the list. Distinct tags across the loaded set
  // drive the chips; selection narrows the list (client-side, mirroring the
  // service-type filter above).
  const availableTags = [...new Set(data.flatMap(c => c.tags ?? []))].sort();

  // Client-side service type filter (API doesn't support this filter)
  let filtered = filter === 'All'
    ? data
    : data.filter(c => customerServiceTypes(c).includes(filter));
  if (tagFilter) {
    filtered = filtered.filter(c => (c.tags ?? []).includes(tagFilter));
  }

  const totalLocations = data.reduce((n, c) => n + (c.locations?.length ?? 0), 0);

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-6">
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5">

        {/* header */}
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-foreground">Customers</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {total} customers · {totalLocations} locations
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3.5 py-2.5 text-sm hover:bg-primary/90 transition-colors">
            <Plus size={14} /> Add customer
          </button>
        </div>

        {/* search */}
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 mt-4">
          <Search size={15} className="text-muted-foreground shrink-0" />
          <input
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, address, phone…"
            className="flex-1 text-sm text-foreground placeholder:text-muted-foreground outline-none bg-transparent"
          />
        </div>

        {/* filter chips */}
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {(['All', 'HVAC', 'Plumbing', 'Painting'] as Filter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs whitespace-nowrap transition-all shrink-0 ${
                filter === f
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:border-border'
              }`}>
              {f !== 'All' && <span>{SVC_ICON[f as ServiceType]}</span>}
              {f}
            </button>
          ))}
        </div>

        {/* 4.8 — tag filter chips (only shown when the loaded set has tags) */}
        {availableTags.length > 0 && (
          <div
            className="flex gap-2 mt-2 overflow-x-auto pb-1"
            style={{ scrollbarWidth: 'none' }}
            data-testid="tag-filters"
          >
            <button
              onClick={() => setTagFilter('')}
              className={`rounded-full border px-3.5 py-1.5 text-xs whitespace-nowrap transition-all shrink-0 ${
                tagFilter === ''
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:border-border'
              }`}
            >
              All tags
            </button>
            {availableTags.map(tag => (
              <button
                key={tag}
                onClick={() => setTagFilter(t => (t === tag ? '' : tag))}
                className={`rounded-full border px-3.5 py-1.5 text-xs whitespace-nowrap transition-all shrink-0 ${
                  tagFilter === tag
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:border-border'
                }`}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}

        {/* list */}
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="md" className="text-foreground" label="Loading customers" />
          </div>
        )}
        {error && (
          <ErrorState message="Failed to load customers" onRetry={refetch} />
        )}
        {!isLoading && !error && (
          <div className="flex flex-col gap-2.5 mt-4">
            {filtered.map(c => {
              const svcTypes = customerServiceTypes(c);
              const locCount = c.locations?.length ?? 0;
              const name = customerDisplayName(c);

              return (
                <button
                  key={c.id}
                  onClick={() => navigate(`/customers/${c.id}`)}
                  className="flex items-center gap-3.5 rounded-2xl bg-card border border-border px-4 py-3.5 text-left hover:border-border hover:shadow-sm transition-all active:scale-[0.99]"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
                    {name.split(' ').map(n => n[0]).join('')}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-foreground">{name}</p>
                      {c.tags?.includes('VIP') && (
                        <span className="text-xs bg-warning/15 text-warning rounded-full px-2 py-0.5">VIP</span>
                      )}
                      {(c.openJobs ?? 0) > 0 && (
                        <span className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5">
                          {c.openJobs} open
                        </span>
                      )}
                    </div>
                    {c.primaryPhone && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Phone size={10} className="text-muted-foreground shrink-0" />
                        <p className="text-xs text-muted-foreground truncate">{c.primaryPhone}</p>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <MapPin size={10} className="text-muted-foreground shrink-0" />
                      <p className="text-xs text-muted-foreground truncate">
                        {locCount > 1 ? `${locCount} locations` : (c.locations?.[0]?.street1 ?? '')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      {svcTypes.map(s => (
                        <span key={s} className={`text-xs border rounded-full px-2 py-0.5 ${SVC_CHIP[s]}`}>
                          {SVC_ICON[s]} {s}
                        </span>
                      ))}
                      {c.lastService && (
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">{c.lastService}</span>
                      )}
                    </div>
                  </div>

                  <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
                </button>
              );
            })}

            {filtered.length === 0 && (
              <EmptyState title="No customers found" />
            )}
          </div>
        )}

      </div>

      {showAdd && (
        <AddCustomerSheet
          onClose={() => setShowAdd(false)}
          onNewEstimate={() => { setShowAdd(false); setShowEstimate(true); }}
          onNewJob={() => { setShowAdd(false); setShowJob(true); }}
          existingCustomers={data}
          onCreate={refetch}
        />
      )}

      {showEstimate && (
        <NewEstimateFlow
          onClose={() => setShowEstimate(false)}
          onCreated={() => setShowEstimate(false)}
        />
      )}

      {showJob && (
        <NewJobFlow
          onClose={() => setShowJob(false)}
          onCreated={() => setShowJob(false)}
          onOpenEstimate={() => { setShowJob(false); setShowEstimate(true); }}
        />
      )}
    </div>
  );
}
