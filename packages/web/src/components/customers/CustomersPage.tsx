import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, Plus, ChevronRight, MapPin, X, Check,
  AlertTriangle, FileText, Briefcase, ArrowLeft,
  User, Phone, Mail,
} from 'lucide-react';
import { customers, ServiceType } from '../../data/mock-data';
import { NewEstimateFlow } from '../estimates/NewEstimateFlow';
import { NewJobFlow } from '../jobs/NewJobFlow';

const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-blue-50 text-blue-700 border-blue-100',
  Plumbing: 'bg-green-50 text-green-700 border-green-100',
  Painting: 'bg-violet-50 text-violet-700 border-violet-100',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

// collect all unique service types across all locations of a customer
function customerServiceTypes(c: typeof customers[0]): ServiceType[] {
  const all = c.locations.flatMap(l => l.serviceTypes);
  return [...new Set(all)] as ServiceType[];
}

// ── Add Customer Sheet ───────────────────────────────────────────
const SERVICE_OPTIONS: ServiceType[] = ['HVAC', 'Plumbing', 'Painting'];

type SheetStep = 'contact' | 'location' | 'done';

function normalizePhone(p: string) { return p.replace(/\D/g, ''); }

interface AddCustomerSheetProps {
  onClose: () => void;
  onNewEstimate: () => void;
  onNewJob: () => void;
}

function AddCustomerSheet({ onClose, onNewEstimate, onNewJob }: AddCustomerSheetProps) {
  const navigate = useNavigate();

  const [step, setStep] = useState<SheetStep>('contact');
  const [form, setForm] = useState({
    name: '', phone: '', email: '',
    locNickname: 'Home', locAddress: '', locServiceTypes: [] as ServiceType[],
    locNotes: '', locAccessCode: '',
  });
  const [dismissedDupe, setDismissedDupe] = useState(false);

  // ── Live duplicate detection ─────────────────────────────────────
  const phoneDigits = normalizePhone(form.phone);
  const phoneMatch = !dismissedDupe && phoneDigits.length >= 10
    ? customers.find(c => normalizePhone(c.phone) === phoneDigits)
    : null;
  const emailNorm  = form.email.toLowerCase().trim();
  const emailMatch = !dismissedDupe && emailNorm.length >= 5 && emailNorm.includes('@')
    ? customers.find(c => c.email.toLowerCase() === emailNorm)
    : null;
  const duplicate = phoneMatch ?? emailMatch;
  const matchReason = phoneMatch ? 'Same phone number' : 'Same email address';

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

  const stepDots: SheetStep[] = ['contact', 'location'];
  const stepIdx = stepDots.indexOf(step);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl max-h-[94vh] overflow-hidden flex flex-col"
        style={{ animation: 'slideUp 0.25s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-9 h-1 rounded-full bg-slate-200" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100 shrink-0">
          {step === 'location' && (
            <button onClick={() => setStep('contact')} className="text-slate-400 hover:text-slate-600 transition-colors">
              <ArrowLeft size={16} />
            </button>
          )}
          {step !== 'done' && (
            <div className="flex gap-1.5">
              {stepDots.map((_, i) => (
                <div key={i} className={`rounded-full transition-all duration-200 ${
                  i < stepIdx  ? 'w-2 h-2 bg-blue-400' :
                  i === stepIdx ? 'w-5 h-2 bg-slate-900' : 'w-2 h-2 bg-slate-200'
                }`} />
              ))}
            </div>
          )}
          <p className="text-sm text-slate-600 flex-1">
            {step === 'contact'  ? 'Contact info' :
             step === 'location' ? 'Service location' : 'Customer added'}
          </p>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* ── Step 1: Contact ── */}
          {step === 'contact' && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-slate-500">Customer name and contact details.</p>

              <div className="flex flex-col gap-2.5">
                {/* Name */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                    <User size={14} />
                  </div>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Full name *"
                    autoFocus
                    className="w-full rounded-xl border border-slate-200 pl-10 pr-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                  />
                </div>

                {/* Phone */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                    <Phone size={14} />
                  </div>
                  <input
                    value={form.phone}
                    onChange={e => { setDismissedDupe(false); setForm(f => ({ ...f, phone: e.target.value })); }}
                    placeholder="Phone number"
                    type="tel"
                    className={`w-full rounded-xl border pl-10 pr-4 py-3 text-sm focus:outline-none transition-colors ${
                      phoneMatch && !dismissedDupe ? 'border-amber-300 bg-amber-50/50 focus:border-amber-400' : 'border-slate-200 focus:border-blue-400'
                    }`}
                  />
                </div>

                {/* Email */}
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                    <Mail size={14} />
                  </div>
                  <input
                    value={form.email}
                    onChange={e => { setDismissedDupe(false); setForm(f => ({ ...f, email: e.target.value })); }}
                    placeholder="Email address"
                    type="email"
                    className={`w-full rounded-xl border pl-10 pr-4 py-3 text-sm focus:outline-none transition-colors ${
                      emailMatch && !dismissedDupe ? 'border-amber-300 bg-amber-50/50 focus:border-amber-400' : 'border-slate-200 focus:border-blue-400'
                    }`}
                  />
                </div>
              </div>

              {/* ── Duplicate match card ── */}
              {duplicate && (
                <div
                  className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4"
                  style={{ animation: 'fadeUp 0.2s ease' }}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-full bg-amber-200 shrink-0">
                      <AlertTriangle size={13} className="text-amber-700" />
                    </div>
                    <div>
                      <p className="text-sm text-amber-900">Already in your system</p>
                      <p className="text-xs text-amber-600 mt-0.5">{matchReason} matches an existing customer</p>
                    </div>
                  </div>

                  {/* Matched customer card */}
                  <div className="flex items-center gap-3 bg-white rounded-xl border border-amber-200 px-3.5 py-3">
                    <span className="flex size-9 items-center justify-center rounded-full bg-slate-800 text-white text-xs shrink-0">
                      {duplicate.name.split(' ').map(n => n[0]).join('')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800">{duplicate.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{duplicate.phone} · {duplicate.address}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => { navigate(`/customers/${duplicate.id}`); onClose(); }}
                      className="flex-1 rounded-xl border border-amber-300 bg-white text-amber-800 py-2.5 text-sm hover:bg-amber-50 transition-colors"
                    >
                      View {duplicate.name.split(' ')[0]}
                    </button>
                    <button
                      onClick={() => setDismissedDupe(true)}
                      className="flex-1 rounded-xl bg-amber-500 text-white py-2.5 text-sm hover:bg-amber-600 transition-colors"
                    >
                      Continue creating
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setStep('location')}
                disabled={!canGoToLocation}
                className="w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors mt-1"
              >
                Next: Add location →
              </button>
            </div>
          )}

          {/* ── Step 2: Location ── */}
          {step === 'location' && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-slate-500">Where do you service <span className="text-slate-700">{form.name}</span>?</p>

              <div className="flex flex-col gap-2.5">
                <input
                  value={form.locNickname}
                  onChange={e => setForm(f => ({ ...f, locNickname: e.target.value }))}
                  placeholder="Location name (e.g. Home, Office)"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                />
                <input
                  value={form.locAddress}
                  onChange={e => setForm(f => ({ ...f, locAddress: e.target.value }))}
                  placeholder="Street address *"
                  className={`w-full rounded-xl border px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors ${
                    !form.locAddress && form.locNickname ? 'border-slate-300' : 'border-slate-200'
                  }`}
                />

                <div>
                  <p className="text-xs text-slate-500 mb-2">Service type *</p>
                  <div className="flex gap-2">
                    {SERVICE_OPTIONS.map(s => (
                      <button key={s} onClick={() => toggleSvc(s)}
                        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition-all flex-1 justify-center ${
                          form.locServiceTypes.includes(s)
                            ? `${SVC_CHIP[s]} border-current shadow-sm`
                            : 'border-slate-200 text-slate-500 hover:border-slate-300 bg-white'
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
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                />
                <input
                  value={form.locAccessCode}
                  onChange={e => setForm(f => ({ ...f, locAccessCode: e.target.value }))}
                  placeholder="Gate / lockbox code (optional)"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                />
              </div>

              <button
                onClick={() => setStep('done')}
                disabled={!canSave}
                className="w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors mt-1"
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
                  <div className="absolute inset-0 rounded-full bg-green-100 animate-pulse" style={{ animationDuration: '1.2s', animationIterationCount: 1 }} />
                  <div className="relative flex size-16 items-center justify-center rounded-full bg-green-100">
                    <Check size={28} className="text-green-600" />
                  </div>
                </div>
                <div>
                  <p className="text-slate-900" style={{ fontSize: '1.05rem' }}>{form.name} added</p>
                  <p className="text-sm text-slate-400 mt-0.5">
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
                <p className="text-xs text-slate-400 text-center mb-3">What would you like to do next?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={onNewEstimate}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-slate-200 bg-white py-5 px-3 hover:border-indigo-300 hover:bg-indigo-50/60 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-indigo-100 group-hover:bg-indigo-200 transition-colors">
                      <FileText size={20} className="text-indigo-600" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-slate-800">New estimate</p>
                      <p className="text-xs text-slate-400 mt-0.5">Build a quote</p>
                    </div>
                  </button>

                  <button
                    onClick={onNewJob}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-slate-200 bg-white py-5 px-3 hover:border-blue-300 hover:bg-blue-50/60 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-blue-100 group-hover:bg-blue-200 transition-colors">
                      <Briefcase size={20} className="text-blue-600" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-slate-800">New job</p>
                      <p className="text-xs text-slate-400 mt-0.5">Schedule work</p>
                    </div>
                  </button>
                </div>
              </div>

              <button
                onClick={onClose}
                className="text-sm text-slate-400 hover:text-slate-600 transition-colors"
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
  const [search,       setSearch]       = useState('');
  const [filter,       setFilter]       = useState<Filter>('All');
  const [showAdd,      setShowAdd]      = useState(false);
  const [showEstimate, setShowEstimate] = useState(false);
  const [showJob,      setShowJob]      = useState(false);

  const filtered = customers.filter(c => {
    const matchSearch = !search
      || c.name.toLowerCase().includes(search.toLowerCase())
      || c.address.toLowerCase().includes(search.toLowerCase())
      || c.phone.includes(search);
    const svcTypes = customerServiceTypes(c);
    const matchFilter = filter === 'All' || svcTypes.includes(filter);
    return matchSearch && matchFilter;
  });

  const totalLocations = customers.reduce((n, c) => n + c.locations.length, 0);

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-6">
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5">

        {/* header */}
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-slate-900">Customers</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {customers.length} customers · {totalLocations} locations
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3.5 py-2.5 text-sm hover:bg-slate-700 transition-colors">
            <Plus size={14} /> Add customer
          </button>
        </div>

        {/* search */}
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 mt-4">
          <Search size={15} className="text-slate-400 shrink-0" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, address, phone…"
            className="flex-1 text-sm text-slate-700 placeholder-slate-400 outline-none bg-transparent"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-slate-400 hover:text-slate-600">
              <X size={13} />
            </button>
          )}
        </div>

        {/* filter chips */}
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {(['All', 'HVAC', 'Plumbing', 'Painting'] as Filter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs whitespace-nowrap transition-all shrink-0 ${
                filter === f
                  ? 'bg-slate-900 border-slate-900 text-white'
                  : 'border-slate-200 text-slate-500 hover:border-slate-400'
              }`}>
              {f !== 'All' && <span>{SVC_ICON[f as ServiceType]}</span>}
              {f}
            </button>
          ))}
        </div>

        {/* list */}
        <div className="flex flex-col gap-2.5 mt-4">
          {filtered.map(c => {
            const svcTypes = customerServiceTypes(c);
            const locCount = c.locations.length;

            return (
              <button
                key={c.id}
                onClick={() => navigate(`/customers/${c.id}`)}
                className="flex items-center gap-3.5 rounded-2xl bg-white border border-slate-200 px-4 py-3.5 text-left hover:border-slate-300 hover:shadow-sm transition-all active:scale-[0.99]"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white text-xs">
                  {c.name.split(' ').map(n => n[0]).join('')}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm text-slate-900">{c.name}</p>
                    {c.tags?.includes('VIP') && (
                      <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">VIP</span>
                    )}
                    {c.openJobs > 0 && (
                      <span className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full px-2 py-0.5">
                        {c.openJobs} open
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <MapPin size={10} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-400 truncate">
                      {locCount > 1 ? `${locCount} locations · ${c.address}` : c.address}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {svcTypes.map(s => (
                      <span key={s} className={`text-xs border rounded-full px-2 py-0.5 ${SVC_CHIP[s]}`}>
                        {SVC_ICON[s]} {s}
                      </span>
                    ))}
                    {c.lastService && (
                      <span className="text-xs text-slate-400 ml-auto shrink-0">{c.lastService}</span>
                    )}
                  </div>
                </div>

                <ChevronRight size={15} className="shrink-0 text-slate-300" />
              </button>
            );
          })}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center py-16 gap-2 text-center">
              <p className="text-slate-400 text-sm">No customers found</p>
              {search && (
                <button onClick={() => { setSearch(''); setFilter('All'); }}
                  className="text-xs text-blue-500 hover:underline">
                  Clear search
                </button>
              )}
            </div>
          )}
        </div>

      </div>

      {showAdd && (
        <AddCustomerSheet
          onClose={() => setShowAdd(false)}
          onNewEstimate={() => { setShowAdd(false); setShowEstimate(true); }}
          onNewJob={() => { setShowAdd(false); setShowJob(true); }}
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