import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeft, Phone, Mail, MessageSquare, Plus, MapPin,
  ChevronDown, ChevronUp, Eye, EyeOff, Briefcase, FileText,
  Receipt, Clock, Star, X, Check, KeyRound,
  AlertTriangle, Home, CheckCircle2, AlertCircle, ChevronRight,
} from 'lucide-react';
import {
  customers, jobs, estimates, invoices,
  ServiceLocation, ServiceType, calcEstimateTotal, calcInvoiceTotal,
} from '../../data/mock-data';
import { NewEstimateFlow } from '../estimates/NewEstimateFlow';

// ─── constants ───────────────────────────────────────────────────────────────
const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-blue-50 text-blue-700 border-blue-100',
  Plumbing: 'bg-green-50 text-green-700 border-green-100',
  Painting: 'bg-violet-50 text-violet-700 border-violet-100',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SERVICE_OPTIONS: ServiceType[] = ['HVAC', 'Plumbing', 'Painting'];

const JOB_STATUS_STYLE: Record<string, string> = {
  Active:       'bg-blue-100 text-blue-700',
  'In Progress':'bg-blue-100 text-blue-700',
  Scheduled:    'bg-green-100 text-green-700',
  Unscheduled:  'bg-slate-100 text-slate-500',
  Completed:    'bg-slate-100 text-slate-500',
  Canceled:     'bg-red-100 text-red-600',
  'No Show':    'bg-orange-100 text-orange-700',
};
const EST_STATUS_STYLE: Record<string, string> = {
  Draft:    'bg-slate-100 text-slate-500',
  Sent:     'bg-blue-100 text-blue-700',
  Viewed:   'bg-indigo-100 text-indigo-700',
  Approved: 'bg-green-100 text-green-700',
  Declined: 'bg-red-100 text-red-600',
};
const INV_STATUS_STYLE: Record<string, string> = {
  Draft:   'bg-slate-100 text-slate-500',
  Sent:    'bg-slate-100 text-slate-500',
  Unpaid:  'bg-amber-100 text-amber-700',
  Paid:    'bg-green-100 text-green-700',
  Overdue: 'bg-red-100 text-red-600',
};

// ─── Add Location Sheet ───────────────────────────────────────────────────────
function AddLocationSheet({ onClose, onSave }: {
  onClose: () => void;
  onSave: (loc: ServiceLocation) => void;
}) {
  const [form, setForm] = useState({
    nickname: '', address: '', serviceTypes: [] as ServiceType[],
    notes: '', accessCode: '',
  });
  const [saved, setSaved] = useState(false);

  function toggleSvc(s: ServiceType) {
    setForm(f => ({
      ...f,
      serviceTypes: f.serviceTypes.includes(s)
        ? f.serviceTypes.filter(x => x !== s)
        : [...f.serviceTypes, s],
    }));
  }

  function submit() {
    if (!form.nickname.trim() || !form.address.trim() || form.serviceTypes.length === 0) return;
    const loc: ServiceLocation = {
      id: `loc-${Date.now()}`,
      nickname: form.nickname.trim(),
      address: form.address.trim(),
      serviceTypes: form.serviceTypes,
      notes: form.notes.trim() || undefined,
      accessCode: form.accessCode.trim() || undefined,
      isPrimary: false,
      jobCount: 0,
    };
    setSaved(true);
    setTimeout(() => { onSave(loc); onClose(); }, 900);
  }

  const valid = !!(form.nickname.trim() && form.address.trim() && form.serviceTypes.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl max-h-[90vh] overflow-y-auto"
        style={{ animation: 'slideUp 0.25s ease' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="px-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-900" style={{ fontSize: '1rem' }}>Add service location</p>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>

          {saved ? (
            <div className="flex flex-col items-center py-10 gap-3" style={{ animation: 'fadeUp 0.2s ease' }}>
              <div className="flex size-12 items-center justify-center rounded-full bg-green-100">
                <Check size={20} className="text-green-600" />
              </div>
              <p className="text-slate-800">Location added</p>
              <p className="text-xs text-slate-400">{form.nickname} · {form.address}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Location name *</label>
                <input value={form.nickname} onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))}
                  placeholder="e.g. Home, Office, Rental Property"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Address *</label>
                <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  placeholder="123 Main St, Austin TX"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-2">Service types *</label>
                <div className="flex gap-2">
                  {SERVICE_OPTIONS.map(s => (
                    <button key={s} onClick={() => toggleSvc(s)}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition-all flex-1 justify-center ${
                        form.serviceTypes.includes(s)
                          ? `${SVC_CHIP[s]} border-current`
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}>
                      {SVC_ICON[s]} {s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">
                  Access notes <span className="text-slate-400">(optional)</span>
                </label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. Ring doorbell twice. Dogs in backyard."
                  rows={2}
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors resize-none" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">
                  Gate / lockbox code <span className="text-slate-400">(optional)</span>
                </label>
                <input value={form.accessCode} onChange={e => setForm(f => ({ ...f, accessCode: e.target.value }))}
                  placeholder="e.g. Gate: 1234, Lockbox: #8812"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors" />
              </div>
              <button onClick={submit} disabled={!valid}
                className="w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors">
                Save location
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Location Card ────────────────────────────────────────────────────────────
function LocationCard({ loc, isExpanded, onToggle, isNew }: {
  loc: ServiceLocation; isExpanded: boolean; onToggle: () => void; isNew?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={`rounded-2xl border overflow-hidden transition-shadow ${
      isNew ? 'border-green-300' : 'border-slate-200'
    } bg-white ${isExpanded ? 'shadow-sm' : ''}`}
      style={isNew ? { animation: 'fadeUp 0.3s ease' } : undefined}
    >
      <button onClick={onToggle} className="w-full flex items-start gap-3 px-4 py-3.5 text-left">
        <div className={`flex size-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
          loc.isPrimary ? 'bg-slate-900' : 'bg-slate-100'
        }`}>
          <MapPin size={13} className={loc.isPrimary ? 'text-white' : 'text-slate-500'} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-900">{loc.nickname}</p>
            {loc.isPrimary && <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">Primary</span>}
            {isNew && <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">New</span>}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{loc.address}</p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {loc.serviceTypes.map(s => (
              <span key={s} className={`text-xs border rounded-full px-2 py-0.5 ${SVC_CHIP[s]}`}>
                {SVC_ICON[s]} {s}
              </span>
            ))}
            <span className="text-xs text-slate-400 ml-auto">
              {loc.jobCount} job{loc.jobCount !== 1 ? 's' : ''}
              {loc.lastService ? ` · ${loc.lastService}` : ''}
            </span>
          </div>
        </div>
        <div className="shrink-0 mt-1 text-slate-400">
          {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3.5 flex flex-col gap-3"
          style={{ animation: 'expandDown 0.15s ease' }}>
          {loc.notes && (
            <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-100 px-3.5 py-2.5">
              <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 leading-relaxed">{loc.notes}</p>
            </div>
          )}
          {loc.accessCode && (
            <div className="flex items-center gap-2.5 rounded-xl bg-white border border-slate-200 px-3.5 py-2.5">
              <KeyRound size={13} className="text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-400 mb-0.5">Access code</p>
                <p className="text-sm transition-all"
                  style={{
                    color: revealed ? '#0f172a' : 'transparent',
                    textShadow: revealed ? 'none' : '0 0 8px rgba(100,100,100,0.6)',
                    userSelect: revealed ? 'auto' : 'none',
                  }}>
                  {loc.accessCode}
                </p>
              </div>
              <button onClick={() => setRevealed(r => !r)}
                className="shrink-0 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
                {revealed ? <><EyeOff size={12} /> Hide</> : <><Eye size={12} /> Reveal</>}
              </button>
            </div>
          )}
          {!loc.notes && !loc.accessCode && (
            <p className="text-xs text-slate-400 italic">No access notes or codes on file.</p>
          )}
          <button className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Plus size={13} /> New job at this location
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Invoice status footer ────────────────────────────────────────────────────
function InvoiceStatusBar({ status, dueDate, paidDate, sentDate }: {
  status: string; dueDate?: string; paidDate?: string; sentDate?: string;
}) {
  if (status === 'Paid') return (
    <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border-t border-green-100">
      <CheckCircle2 size={11} className="text-green-500 shrink-0" />
      <span className="text-xs text-green-700">Paid {paidDate ?? 'in full'}</span>
    </div>
  );
  if (status === 'Overdue') return (
    <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border-t border-red-100">
      <AlertCircle size={11} className="text-red-500 shrink-0" />
      <span className="text-xs text-red-700">Overdue · was due {dueDate}</span>
    </div>
  );
  if (status === 'Unpaid' && dueDate) return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-t border-amber-100">
      <Clock size={11} className="text-amber-500 shrink-0" />
      <span className="text-xs text-amber-700">Due {dueDate}</span>
    </div>
  );
  if (status === 'Sent' && sentDate) return (
    <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 border-t border-slate-100">
      <Clock size={11} className="text-slate-400 shrink-0" />
      <span className="text-xs text-slate-500">Sent {sentDate} · awaiting payment</span>
    </div>
  );
  if (status === 'Draft') return (
    <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 border-t border-slate-100">
      <span className="text-xs text-slate-400">Draft · not yet sent</span>
    </div>
  );
  return null;
}

// ─── Main page ────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'locations' | 'history';
type HistoryFilter = 'all' | 'invoices' | 'jobs' | 'estimates';

export function CustomerDetailPage() {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();

  const found = customers.find(c => c.id === id);
  const [tab,              setTab]           = useState<Tab>('history');
  const [locations,        setLocations]     = useState<ServiceLocation[]>(found?.locations ?? []);
  const [expanded,         setExpanded]      = useState<Set<string>>(new Set());
  const [showAddLoc,       setShowAddLoc]    = useState(false);
  const [newLocIds,        setNewLocIds]     = useState<Set<string>>(new Set());
  const [histFilter,       setHistFilter]    = useState<HistoryFilter>('all');
  const [plusMenuOpen,     setPlusMenuOpen]  = useState(false);
  const [newEstimateOpen,  setNewEstimate]   = useState(false);

  if (!found) return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <p className="text-slate-400 text-sm">Customer not found</p>
      <button onClick={() => navigate('/customers')} className="text-sm text-blue-600 hover:underline">
        ← Back to customers
      </button>
    </div>
  );

  const multiLocation   = locations.length > 1;
  const initials        = found.name.split(' ').map(n => n[0]).join('');
  const allServiceTypes = [...new Set(locations.flatMap(l => l.serviceTypes))] as ServiceType[];
  const primaryLoc      = locations.find(l => l.isPrimary) ?? locations[0];

  const custJobs      = jobs.filter(j => j.customerId === id);
  const custEstimates = estimates.filter(e => e.customerId === id);
  const custInvoices  = invoices.filter(i => i.customerId === id);

  const tabs: Tab[] = multiLocation
    ? ['overview', 'locations', 'history']
    : ['overview', 'history'];

  function toggleExpand(locId: string) {
    setExpanded(s => { const n = new Set(s); n.has(locId) ? n.delete(locId) : n.add(locId); return n; });
  }
  function handleAddLocation(loc: ServiceLocation) {
    setLocations(p => [...p, loc]);
    setNewLocIds(s => new Set([...s, loc.id]));
    setExpanded(s => new Set([...s, loc.id]));
    setTab('locations');
  }

  // counts for filter pills
  const counts = { all: custJobs.length + custEstimates.length + custInvoices.length, invoices: custInvoices.length, jobs: custJobs.length, estimates: custEstimates.length };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto pb-20 md:pb-6">

        {/* ── Hero ── */}
        <div className="bg-slate-900 px-4 pt-4 pb-5">
          <button onClick={() => navigate('/customers')}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm mb-4 transition-colors">
            <ArrowLeft size={15} /> Customers
          </button>

          <div className="flex items-start gap-3.5">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-slate-700 text-white" style={{ fontSize: 18 }}>
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-white leading-snug">{found.name}</h2>
              <p className="text-slate-400 text-sm mt-0.5">{found.phone}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {found.tags?.map(tag => (
                  <span key={tag} className={`text-xs rounded-full px-2.5 py-0.5 border ${
                    tag === 'VIP'      ? 'bg-amber-400/20 text-amber-300 border-amber-400/30' :
                    tag === 'Contract' ? 'bg-blue-400/20  text-blue-300  border-blue-400/30'  :
                    'bg-slate-700 text-slate-300 border-slate-600'
                  }`}>
                    {tag === 'VIP' && '⭐ '}{tag}
                  </span>
                ))}
                {allServiceTypes.map(s => (
                  <span key={s} className={`text-xs rounded-full px-2.5 py-0.5 border ${SVC_CHIP[s]}`}>
                    {SVC_ICON[s]} {s}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* action row */}
          <div className="grid grid-cols-4 gap-2 mt-4">
            {([
              { icon: Phone,         label: 'Call',  cls: 'bg-slate-700 text-white' },
              { icon: MessageSquare, label: 'Text',  cls: 'bg-slate-700 text-white' },
              { icon: Mail,          label: 'Email', cls: 'bg-slate-700 text-white' },
            ] as const).map(({ icon: Icon, label, cls }) => (
              <button key={label} className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-xs hover:opacity-80 transition-opacity ${cls}`}>
                <Icon size={16} />
                {label}
              </button>
            ))}

            {/* + dropdown */}
            <div className="relative">
              <button
                onClick={() => setPlusMenuOpen(v => !v)}
                className="flex flex-col items-center gap-1 rounded-xl py-2.5 text-xs w-full bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                <Plus size={16} />
                New
              </button>
              {plusMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPlusMenuOpen(false)} />
                  <div className="absolute bottom-full right-0 mb-2 bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden z-20 w-44"
                    style={{ animation: 'fadeUp 0.15s ease' }}>
                    <button
                      onClick={() => { setPlusMenuOpen(false); setNewEstimate(true); }}
                      className="flex items-center gap-3 w-full px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
                      <FileText size={15} className="text-indigo-500 shrink-0" />
                      New estimate
                    </button>
                    <div className="border-t border-slate-100" />
                    <button
                      onClick={() => setPlusMenuOpen(false)}
                      className="flex items-center gap-3 w-full px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
                      <Briefcase size={15} className="text-blue-500 shrink-0" />
                      New job
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Stats ── */}
        <div className="flex divide-x divide-slate-100 bg-white border-b border-slate-100">
          {[
            { label: 'Jobs',      value: found.jobCount },
            { label: 'Locations', value: locations.length },
            { label: 'Since',     value: found.memberSince ?? '—' },
            { label: 'Revenue',   value: found.totalRevenue ? `$${found.totalRevenue.toLocaleString()}` : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="flex-1 flex flex-col items-center justify-center py-3 px-1">
              <p className="text-sm text-slate-900">{value}</p>
              <p className="text-xs text-slate-400 mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* ── Tabs ── */}
        <div className="flex bg-white border-b border-slate-100 sticky top-0 z-10">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm capitalize relative transition-colors ${
                tab === t ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
              }`}>
              {t === 'locations' && (
                <span className={`mr-1 inline-flex size-4 items-center justify-center rounded-full text-xs ${
                  tab === t ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
                }`}>{locations.length}</span>
              )}
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {tab === t && <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-blue-500 rounded-full" />}
            </button>
          ))}
        </div>

        {/* ── Content ── */}
        <div className="px-4 py-4 max-w-2xl mx-auto">

          {/* ── Overview ── */}
          {tab === 'overview' && (
            <div className="flex flex-col gap-4">

              {/* contact + location */}
              <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                  <p className="text-xs text-slate-500">Contact</p>
                </div>
                <div className="divide-y divide-slate-50">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Phone size={13} className="text-slate-400 shrink-0" />
                    <p className="flex-1 text-sm text-slate-800">{found.phone}</p>
                    <button className="text-xs text-blue-600 hover:underline shrink-0">Call</button>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Mail size={13} className="text-slate-400 shrink-0" />
                    <p className="flex-1 text-sm text-slate-800 truncate">{found.email}</p>
                    <button className="text-xs text-blue-600 hover:underline shrink-0">Email</button>
                  </div>

                  {/* location row — single OR multi */}
                  {!multiLocation ? (
                    <div className="flex items-start gap-3 px-4 py-3">
                      <MapPin size={13} className="text-slate-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">{primaryLoc?.address ?? found.address}</p>
                        {primaryLoc && (
                          <div className="flex gap-1.5 mt-1 flex-wrap">
                            {primaryLoc.serviceTypes.map(s => (
                              <span key={s} className={`text-xs border rounded-full px-2 py-0.5 ${SVC_CHIP[s]}`}>
                                {SVC_ICON[s]} {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={() => setShowAddLoc(true)}
                        className="text-xs text-slate-400 hover:text-blue-600 transition-colors shrink-0 flex items-center gap-1">
                        <Plus size={11} /> Add location
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setTab('locations')}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                      <MapPin size={13} className="text-slate-400 shrink-0" />
                      <p className="flex-1 text-sm text-slate-800">{locations.length} service locations</p>
                      <ChevronRight size={13} className="text-slate-400 shrink-0" />
                    </button>
                  )}
                </div>
              </div>

              {/* notes */}
              {found.notes && (
                <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3.5">
                  <p className="text-xs text-amber-600 mb-1">Note</p>
                  <p className="text-sm text-amber-900">{found.notes}</p>
                </div>
              )}

              {/* quick stats grid */}
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { icon: Clock,    label: 'Last service', value: found.lastService ?? 'Never' },
                  { icon: Star,     label: 'Member since', value: found.memberSince ?? '—'     },
                  { icon: Briefcase,label: 'Total jobs',   value: `${found.jobCount} jobs`      },
                  { icon: Home,     label: 'Locations',    value: `${locations.length}` },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="rounded-xl bg-white border border-slate-200 px-4 py-3">
                    <Icon size={13} className="text-slate-400 mb-1.5" />
                    <p className="text-sm text-slate-800">{value}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{label}</p>
                  </div>
                ))}
              </div>

              {/* recent history shortcut */}
              {(custJobs.length + custEstimates.length + custInvoices.length) > 0 && (
                <button onClick={() => setTab('history')}
                  className="flex items-center justify-between rounded-2xl bg-white border border-slate-200 px-4 py-3.5 hover:border-slate-300 transition-colors">
                  <div className="flex items-center gap-2.5">
                    <Receipt size={14} className="text-slate-400" />
                    <div className="text-left">
                      <p className="text-sm text-slate-800">View full history</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {custJobs.length} job{custJobs.length !== 1 ? 's' : ''}
                        {custEstimates.length > 0 ? ` · ${custEstimates.length} estimate${custEstimates.length !== 1 ? 's' : ''}` : ''}
                        {custInvoices.length > 0 ? ` · ${custInvoices.length} invoice${custInvoices.length !== 1 ? 's' : ''}` : ''}
                      </p>
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-slate-400 shrink-0" />
                </button>
              )}
            </div>
          )}

          {/* ── Locations (only for multi-location customers) ── */}
          {tab === 'locations' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm text-slate-600">{locations.length} service locations</p>
                <button onClick={() => setShowAddLoc(true)}
                  className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3 py-2 text-xs hover:bg-slate-700 transition-colors">
                  <Plus size={12} /> Add location
                </button>
              </div>
              {locations.map(loc => (
                <LocationCard key={loc.id} loc={loc}
                  isExpanded={expanded.has(loc.id)}
                  onToggle={() => toggleExpand(loc.id)}
                  isNew={newLocIds.has(loc.id)} />
              ))}
              <button onClick={() => setShowAddLoc(true)}
                className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white py-4 text-sm text-slate-400 hover:border-slate-400 hover:text-slate-600 transition-colors">
                <Plus size={14} /> Add another location
              </button>
            </div>
          )}

          {/* ── History ── */}
          {tab === 'history' && (
            <div className="flex flex-col gap-3">

              {/* filter pills */}
              <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
                {(['all', 'invoices', 'jobs', 'estimates'] as HistoryFilter[]).map(f => (
                  <button key={f} onClick={() => setHistFilter(f)}
                    className={`rounded-full border px-3.5 py-1.5 text-xs capitalize whitespace-nowrap shrink-0 transition-all ${
                      histFilter === f
                        ? 'bg-slate-900 border-slate-900 text-white'
                        : 'border-slate-200 text-slate-500 hover:border-slate-400'
                    }`}>
                    {f === 'all' ? `All (${counts.all})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f]})`}
                  </button>
                ))}
              </div>

              {counts.all === 0 && (
                <div className="text-center py-12">
                  <p className="text-sm text-slate-400">No history yet</p>
                </div>
              )}

              {/* ── Invoices section ── */}
              {(histFilter === 'all' || histFilter === 'invoices') && custInvoices.length > 0 && (
                <div className="flex flex-col gap-2">
                  {histFilter === 'all' && (
                    <p className="text-xs text-slate-400 uppercase tracking-wide px-1">Invoices</p>
                  )}
                  {custInvoices.map(inv => {
                    const total = calcInvoiceTotal(inv);
                    return (
                      <div key={inv.id} className="rounded-xl bg-white border border-slate-200 overflow-hidden hover:border-slate-300 transition-colors">
                        <div className="flex items-start gap-3 px-4 py-3.5">
                          <span className={`flex size-8 items-center justify-center rounded-xl shrink-0 ${
                            inv.status === 'Paid'    ? 'bg-green-50'  :
                            inv.status === 'Overdue' ? 'bg-red-50'    :
                            inv.status === 'Unpaid'  ? 'bg-amber-50'  : 'bg-slate-50'
                          }`}>
                            <Receipt size={14} className={
                              inv.status === 'Paid'    ? 'text-green-500' :
                              inv.status === 'Overdue' ? 'text-red-500'   :
                              inv.status === 'Unpaid'  ? 'text-amber-500' : 'text-slate-400'
                            } />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs text-slate-400">{inv.invoiceNumber}</p>
                                <p className="text-sm text-slate-800 mt-0.5 leading-snug">{inv.description}</p>
                              </div>
                              <span className={`text-xs rounded-full px-2.5 py-1 whitespace-nowrap shrink-0 ${INV_STATUS_STYLE[inv.status] ?? 'bg-slate-100 text-slate-500'}`}>
                                {inv.status}
                              </span>
                            </div>
                            <p className="text-slate-900 mt-2" style={{ fontSize: '0.95rem' }}>
                              ${total.toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <InvoiceStatusBar
                          status={inv.status}
                          dueDate={inv.dueDate}
                          paidDate={inv.paidDate}
                          sentDate={inv.sentDate}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Jobs section ── */}
              {(histFilter === 'all' || histFilter === 'jobs') && custJobs.length > 0 && (
                <div className="flex flex-col gap-2">
                  {histFilter === 'all' && (
                    <p className="text-xs text-slate-400 uppercase tracking-wide px-1 mt-1">Jobs</p>
                  )}
                  {custJobs.map(j => (
                    <div key={j.id}
                      className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-3.5 hover:border-slate-300 transition-colors cursor-pointer active:bg-slate-50">
                      <span className="flex size-8 items-center justify-center rounded-xl bg-blue-50 shrink-0">
                        <Briefcase size={13} className="text-blue-500" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-slate-400">Job #{j.jobNumber}</p>
                          <span className={`text-xs rounded-full px-2 py-0.5 ${JOB_STATUS_STYLE[j.status] ?? 'bg-slate-100 text-slate-500'}`}>
                            {j.status}
                          </span>
                        </div>
                        <p className="text-sm text-slate-800 mt-0.5 leading-snug">{j.description}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {j.scheduledDate ?? 'Unscheduled'}
                          {j.assignedTech ? ` · ${j.assignedTech}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Estimates section ── */}
              {(histFilter === 'all' || histFilter === 'estimates') && custEstimates.length > 0 && (
                <div className="flex flex-col gap-2">
                  {histFilter === 'all' && (
                    <p className="text-xs text-slate-400 uppercase tracking-wide px-1 mt-1">Estimates</p>
                  )}
                  {custEstimates.map(e => {
                    const total = calcEstimateTotal(e);
                    return (
                      <div key={e.id}
                        className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-3.5 hover:border-slate-300 transition-colors cursor-pointer active:bg-slate-50">
                        <span className="flex size-8 items-center justify-center rounded-xl bg-indigo-50 shrink-0">
                          <FileText size={13} className="text-indigo-500" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-slate-400">{e.estimateNumber}</p>
                            <span className={`text-xs rounded-full px-2 py-0.5 ${EST_STATUS_STYLE[e.status] ?? 'bg-slate-100 text-slate-500'}`}>
                              {e.status}
                            </span>
                          </div>
                          <p className="text-sm text-slate-800 mt-0.5 leading-snug">{e.description}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{e.createdDate}</p>
                        </div>
                        <p className="text-sm text-slate-900 shrink-0">${total.toLocaleString()}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* empty filtered state */}
              {histFilter !== 'all' && counts[histFilter] === 0 && (
                <div className="text-center py-10">
                  <p className="text-sm text-slate-400">No {histFilter} on record</p>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {showAddLoc && (
        <AddLocationSheet
          onClose={() => setShowAddLoc(false)}
          onSave={handleAddLocation}
        />
      )}

      {newEstimateOpen && (
        <NewEstimateFlow
          onClose={() => setNewEstimate(false)}
          onCreated={() => setNewEstimate(false)}
          preSelectedCustomerId={id}
        />
      )}

      <style>{`
        @keyframes slideUp   { from { transform:translateY(100%) } to { transform:translateY(0) } }
        @keyframes fadeUp    { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
        @keyframes expandDown{ from { opacity:0; max-height:0 } to { opacity:1; max-height:400px } }
      `}</style>
    </div>
  );
}