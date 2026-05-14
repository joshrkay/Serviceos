import { useState } from 'react';
import {
  Plus, Phone, FileText, CheckCircle2, X, ChevronRight,
  Clock, Zap, TrendingUp, Search, Filter, ArrowRight,
  MapPin, Mail, User, MessageSquare, Star,
} from 'lucide-react';
import { leads as initialLeads } from '../../data/mock-data';
import type { Lead, LeadStatus, ServiceType } from '../../data/mock-data';

// ─── Config ──────────────────────────────────────────────────────────────────
const COLUMNS: { status: LeadStatus; label: string; color: string; dot: string }[] = [
  { status: 'New',           label: 'New',           color: 'bg-blue-50   border-blue-200',  dot: 'bg-blue-500'   },
  { status: 'Contacted',     label: 'Contacted',     color: 'bg-amber-50  border-amber-200', dot: 'bg-amber-500'  },
  { status: 'Estimate Sent', label: 'Estimate Sent', color: 'bg-violet-50 border-violet-200',dot: 'bg-violet-500' },
];

const SVC_CFG: Record<ServiceType, { emoji: string; bg: string; text: string }> = {
  HVAC:     { emoji: '❄️', bg: 'bg-blue-100',   text: 'text-blue-700'   },
  Plumbing: { emoji: '🔧', bg: 'bg-cyan-100',   text: 'text-cyan-700'   },
  Painting: { emoji: '🎨', bg: 'bg-purple-100', text: 'text-purple-700' },
};

const SOURCE_CFG: Record<string, string> = {
  'Web Form': 'bg-green-100 text-green-700',
  'Referral': 'bg-amber-100 text-amber-700',
  'Google':   'bg-blue-100  text-blue-700',
  'Yelp':     'bg-red-100   text-red-700',
  'Facebook': 'bg-blue-100  text-blue-700',
  'Nextdoor': 'bg-teal-100  text-teal-700',
  'Phone':    'bg-slate-100 text-slate-700',
};

// ─── Lead Card ────────────────────────────────────────────────────────────────
function LeadCard({ lead, onClick }: { lead: Lead; onClick: () => void }) {
  const svc = SVC_CFG[lead.serviceType];
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-2xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all p-4 group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base shrink-0">{svc.emoji}</span>
          <p className="text-sm text-slate-900 truncate">{lead.name}</p>
        </div>
        {lead.estimatedValue && (
          <span className="shrink-0 text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
            ${lead.estimatedValue.toLocaleString()}
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 mb-3">
        {lead.description}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs rounded-full px-2 py-0.5 ${SOURCE_CFG[lead.source] ?? 'bg-slate-100 text-slate-600'}`}>
          {lead.source}
        </span>
        <span className={`text-xs rounded-full px-2 py-0.5 ${svc.bg} ${svc.text}`}>
          {lead.serviceType}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-slate-400 shrink-0">
          <Clock size={10} />
          {lead.daysInStage === 0 ? 'Today' : `${lead.daysInStage}d in stage`}
        </span>
      </div>

      {lead.notes && (
        <div className="mt-2.5 rounded-lg bg-amber-50 border border-amber-100 px-2.5 py-1.5">
          <p className="text-xs text-amber-700 line-clamp-1">{lead.notes}</p>
        </div>
      )}

      <ChevronRight
        size={14}
        className="text-slate-300 group-hover:text-slate-500 transition-colors mt-2 ml-auto"
      />
    </button>
  );
}

// ─── Lead Detail Drawer ───────────────────────────────────────────────────────
function LeadDrawer({ lead, onClose, onConvert, onMove }: {
  lead: Lead;
  onClose: () => void;
  onConvert: () => void;
  onMove: (status: LeadStatus) => void;
}) {
  const svc = SVC_CFG[lead.serviceType];
  const allStatuses: LeadStatus[] = ['New', 'Contacted', 'Estimate Sent', 'Won', 'Lost'];

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40 md:block hidden" />

      {/* Panel */}
      <div
        className="w-full md:w-[420px] bg-white h-full overflow-y-auto shadow-2xl flex flex-col"
        style={{ animation: 'slideRight 0.25s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">{svc.emoji}</span>
            <div>
              <p className="text-slate-900">{lead.name}</p>
              <p className="text-xs text-slate-400 mt-0.5">{lead.serviceType} · {lead.source}</p>
            </div>
          </div>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
          {/* Value + stage */}
          <div className="flex gap-3">
            {lead.estimatedValue && (
              <div className="flex-1 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-center">
                <p className="text-xs text-slate-400 mb-1">Est. Value</p>
                <p className="text-slate-900">${lead.estimatedValue.toLocaleString()}</p>
              </div>
            )}
            <div className="flex-1 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-center">
              <p className="text-xs text-slate-400 mb-1">Stage</p>
              <p className="text-slate-900">{lead.status}</p>
            </div>
            <div className="flex-1 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-center">
              <p className="text-xs text-slate-400 mb-1">In Stage</p>
              <p className="text-slate-900">{lead.daysInStage === 0 ? 'Today' : `${lead.daysInStage}d`}</p>
            </div>
          </div>

          {/* Description */}
          <div className="rounded-xl bg-white border border-slate-200 p-4">
            <p className="text-xs text-slate-400 mb-2">Request</p>
            <p className="text-sm text-slate-700 leading-relaxed">{lead.description}</p>
          </div>

          {/* Contact info */}
          <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-50">
              <p className="text-xs text-slate-400">Contact</p>
            </div>
            <a href={`tel:${lead.phone}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50">
              <Phone size={14} className="text-slate-400 shrink-0" />
              <p className="text-sm text-slate-700">{lead.phone}</p>
            </a>
            {lead.email && (
              <a href={`mailto:${lead.email}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50">
                <Mail size={14} className="text-slate-400 shrink-0" />
                <p className="text-sm text-slate-700 truncate">{lead.email}</p>
              </a>
            )}
            {lead.address && (
              <div className="flex items-start gap-3 px-4 py-3">
                <MapPin size={14} className="text-slate-400 shrink-0 mt-0.5" />
                <p className="text-sm text-slate-700">{lead.address}</p>
              </div>
            )}
          </div>

          {/* Assigned to */}
          {lead.assignedTo && (
            <div className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-4 py-3">
              <User size={14} className="text-slate-400 shrink-0" />
              <p className="text-xs text-slate-400">Assigned to</p>
              <p className="text-sm text-slate-700">{lead.assignedTo}</p>
            </div>
          )}

          {/* Notes */}
          {lead.notes && (
            <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3">
              <p className="text-xs text-amber-600 mb-1.5">Notes</p>
              <p className="text-sm text-amber-800 leading-relaxed">{lead.notes}</p>
            </div>
          )}

          {/* Move stage */}
          <div>
            <p className="text-xs text-slate-400 mb-2.5 px-1">Move to stage</p>
            <div className="flex flex-col gap-1.5">
              {allStatuses.map(s => (
                <button
                  key={s}
                  onClick={() => { onMove(s); onClose(); }}
                  disabled={s === lead.status}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition-all ${
                    s === lead.status
                      ? 'border-slate-900 bg-slate-900 text-white cursor-default'
                      : s === 'Won'
                      ? 'border-green-200 hover:bg-green-50 text-green-700 hover:border-green-300'
                      : s === 'Lost'
                      ? 'border-red-200 hover:bg-red-50 text-red-600 hover:border-red-300'
                      : 'border-slate-200 bg-white hover:border-slate-300 text-slate-700'
                  }`}
                >
                  {s}
                  {s === lead.status && <CheckCircle2 size={14} className="text-white" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="shrink-0 border-t border-slate-100 p-5 flex flex-col gap-3">
          <button
            onClick={onConvert}
            className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white py-3.5 text-sm transition-colors"
          >
            <ArrowRight size={15} />
            Convert to Job
          </button>
          <div className="grid grid-cols-2 gap-2">
            <a
              href={`tel:${lead.phone}`}
              className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-green-50 hover:border-green-200 py-3 text-sm text-slate-600 hover:text-green-700 transition-colors"
            >
              <Phone size={14} /> Call
            </a>
            <button className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200 py-3 text-sm text-slate-600 hover:text-blue-700 transition-colors">
              <MessageSquare size={14} /> Text
            </button>
          </div>
        </div>
      </div>

      <style>{`@keyframes slideRight { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
    </div>
  );
}

// ─── Add Lead Modal ───────────────────────────────────────────────────────────
function AddLeadModal({ onClose, onAdd }: {
  onClose: () => void;
  onAdd: (lead: Lead) => void;
}) {
  const [name, setName]         = useState('');
  const [phone, setPhone]       = useState('');
  const [service, setService]   = useState<ServiceType>('HVAC');
  const [source, setSource]     = useState('Phone');
  const [desc, setDesc]         = useState('');
  const [value, setValue]       = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !phone || !desc) return;
    onAdd({
      id: `lead-new-${Date.now()}`,
      name, phone,
      serviceType: service,
      description: desc,
      status: 'New',
      source: source as Lead['source'],
      estimatedValue: value ? parseInt(value) : undefined,
      createdAt: 'Just now',
      daysInStage: 0,
    });
    onClose();
  }

  const inputCls = 'rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all w-full';
  const labelCls = 'text-xs text-slate-500 mb-1.5 block';

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 px-4 pb-0 md:pb-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        style={{ animation: 'sheetUp 0.25s ease' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100">
          <p className="text-slate-900">Add Lead</p>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-5 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Name *</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Sandra Wu" required className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Phone *</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(512) 555-…" required type="tel" className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Service</label>
              <select value={service} onChange={e => setService(e.target.value as ServiceType)} className={inputCls}>
                <option>HVAC</option>
                <option>Plumbing</option>
                <option>Painting</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Source</label>
              <select value={source} onChange={e => setSource(e.target.value)} className={inputCls}>
                {['Web Form','Referral','Google','Yelp','Facebook','Nextdoor','Phone'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Description *</label>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="What does the customer need?"
              required
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </div>

          <div>
            <label className={labelCls}>Est. value ($) <span className="text-slate-300">optional</span></label>
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="1200" type="number" min="0" className={inputCls} />
          </div>

          <button
            type="submit"
            className="flex items-center justify-center rounded-xl bg-slate-900 py-3.5 text-sm text-white hover:bg-slate-800 transition-colors mt-1"
          >
            Add to pipeline
          </button>
        </form>
      </div>
      <style>{`@keyframes sheetUp { from { transform: translateY(60px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export function LeadsPage() {
  const [allLeads, setAllLeads]     = useState<Lead[]>(initialLeads);
  const [selected, setSelected]     = useState<Lead | null>(null);
  const [addOpen, setAddOpen]       = useState(false);
  const [search, setSearch]         = useState('');
  const [filterSvc, setFilterSvc]   = useState<ServiceType | 'All'>('All');

  // Pipeline stats
  const pipeline      = allLeads.filter(l => l.status !== 'Won' && l.status !== 'Lost');
  const won           = allLeads.filter(l => l.status === 'Won');
  const pipelineValue = pipeline.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
  const wonValue      = won.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);

  // Filtered leads for display
  const filtered = allLeads.filter(l => {
    const matchSearch = !search ||
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.description.toLowerCase().includes(search.toLowerCase());
    const matchSvc = filterSvc === 'All' || l.serviceType === filterSvc;
    return matchSearch && matchSvc;
  });

  function moveLeadTo(id: string, status: LeadStatus) {
    setAllLeads(prev => prev.map(l => l.id === id ? { ...l, status, daysInStage: 0 } : l));
    if (selected?.id === id) setSelected(prev => prev ? { ...prev, status } : null);
  }

  function convertLead(lead: Lead) {
    moveLeadTo(lead.id, 'Won');
    setSelected(null);
  }

  return (
    <div className="h-full overflow-y-auto pb-24 md:pb-6" style={{ scrollbarWidth: 'thin' }}>
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-5 md:py-6">

        {/* Page header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-slate-900" style={{ fontSize: '1.2rem' }}>Lead Pipeline</h1>
            <p className="text-xs text-slate-400 mt-0.5">Customers / Leads</p>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white hover:bg-slate-800 transition-colors"
          >
            <Plus size={14} /> Add lead
          </button>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: 'In pipeline',  value: pipeline.length,                        sub: `$${pipelineValue.toLocaleString()} est.`, icon: Zap,         color: 'text-blue-600'  },
            { label: 'Won (month)',  value: won.length,                              sub: `$${wonValue.toLocaleString()} secured`,  icon: TrendingUp,   color: 'text-green-600' },
            { label: 'Need follow-up', value: pipeline.filter(l => l.daysInStage >= 2).length, sub: 'in stage 2+ days', icon: Star, color: 'text-amber-600' },
          ].map(({ label, value, sub, icon: Icon, color }) => (
            <div key={label} className="rounded-xl bg-white border border-slate-200 px-4 py-3.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon size={12} className={color} />
                <p className="text-xs text-slate-400">{label}</p>
              </div>
              <p className="text-slate-900">{value}</p>
              <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
            </div>
          ))}
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-2 mb-5">
          <div className="flex-1 flex items-center gap-2.5 rounded-xl bg-white border border-slate-200 px-3.5 py-2.5">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search leads…"
              className="flex-1 bg-transparent text-sm text-slate-700 placeholder-slate-400 outline-none"
            />
          </div>
          <div className="flex gap-1">
            {(['All', 'HVAC', 'Plumbing', 'Painting'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterSvc(f)}
                className={`rounded-lg px-3 py-2 text-xs transition-colors ${
                  filterSvc === f
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Kanban board */}
        <div className="grid md:grid-cols-3 gap-4">
          {COLUMNS.map(col => {
            const colLeads = filtered.filter(l => l.status === col.status);
            const colValue = colLeads.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
            return (
              <div key={col.status}>
                {/* Column header */}
                <div className={`flex items-center justify-between rounded-xl border px-4 py-3 mb-3 ${col.color}`}>
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full shrink-0 ${col.dot}`} />
                    <p className="text-sm text-slate-700">{col.label}</p>
                    <span className="text-xs bg-white/70 rounded-full px-2 py-0.5 text-slate-600">{colLeads.length}</span>
                  </div>
                  {colValue > 0 && (
                    <span className="text-xs text-slate-500">${colValue.toLocaleString()}</span>
                  )}
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-3">
                  {colLeads.map(lead => (
                    <LeadCard key={lead.id} lead={lead} onClick={() => setSelected(lead)} />
                  ))}
                  {colLeads.length === 0 && (
                    <div className="rounded-xl border-2 border-dashed border-slate-200 py-8 flex flex-col items-center gap-2 text-center">
                      <p className="text-xs text-slate-400">No leads here</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Won + Lost below */}
        <div className="grid md:grid-cols-2 gap-4 mt-6">
          {(['Won', 'Lost'] as LeadStatus[]).map(status => {
            const statusLeads = filtered.filter(l => l.status === status);
            const statusValue = statusLeads.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
            const isWon = status === 'Won';
            return (
              <div key={status} className={`rounded-xl border ${isWon ? 'border-green-200 bg-green-50' : 'border-red-100 bg-red-50'}`}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/60">
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${isWon ? 'bg-green-500' : 'bg-red-400'}`} />
                    <p className={`text-sm ${isWon ? 'text-green-800' : 'text-red-700'}`}>{status}</p>
                    <span className="text-xs bg-white/70 rounded-full px-2 py-0.5 text-slate-600">{statusLeads.length}</span>
                  </div>
                  {statusValue > 0 && (
                    <span className="text-xs text-slate-500">${statusValue.toLocaleString()}</span>
                  )}
                </div>
                {statusLeads.length > 0 ? (
                  <div className="px-4 py-3 flex flex-col gap-2">
                    {statusLeads.map(l => (
                      <button
                        key={l.id}
                        onClick={() => setSelected(l)}
                        className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
                      >
                        <span className="text-base shrink-0">{SVC_CFG[l.serviceType].emoji}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-slate-800 truncate">{l.name}</p>
                          <p className="text-xs text-slate-400 truncate">{l.description.slice(0, 60)}</p>
                        </div>
                        {l.estimatedValue && (
                          <span className="text-xs text-slate-500 shrink-0">${l.estimatedValue.toLocaleString()}</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 px-4 py-3">None yet</p>
                )}
              </div>
            );
          })}
        </div>

      </div>

      {/* Detail drawer */}
      {selected && (
        <LeadDrawer
          lead={selected}
          onClose={() => setSelected(null)}
          onConvert={() => convertLead(selected)}
          onMove={status => moveLeadTo(selected.id, status)}
        />
      )}

      {/* Add lead modal */}
      {addOpen && (
        <AddLeadModal
          onClose={() => setAddOpen(false)}
          onAdd={lead => setAllLeads(prev => [lead, ...prev])}
        />
      )}
    </div>
  );
}
