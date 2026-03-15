import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, Plus, ChevronRight, Camera, Clock,
  AlertCircle, AlertTriangle, Zap, Mic,
} from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { normalizeJobStatus } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { NewJobFlow } from './NewJobFlow';

type JobStatus = 'New' | 'Scheduled' | 'In Progress' | 'Completed' | 'Canceled';

interface ApiJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  priority?: string;
  customerId?: string;
  assignedTechnicianId?: string;
  scheduledStart?: string;
  createdAt?: string;
  customer?: { id: string; displayName?: string; firstName?: string; lastName?: string };
  technician?: { id: string; firstName?: string; lastName?: string; color?: string };
  serviceType?: string;
}

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const STATUS_BORDER: Partial<Record<string, string>> = {
  'New':          'border-l-slate-300',
  'In Progress':  'border-l-indigo-500',
  'Scheduled':    'border-l-blue-400',
  'Completed':    'border-l-slate-200',
  'Canceled':     'border-l-red-300',
};

// UI tab label → API status value
const TAB_API_STATUS: Record<string, string> = {
  'New':        'new',
  'Scheduled':  'scheduled',
  'In Progress':'in_progress',
  'Completed':  'completed',
  'Canceled':   'canceled',
};

const TABS: { label: string; value: JobStatus | 'All' }[] = [
  { label: 'All',         value: 'All' },
  { label: 'New',         value: 'New' },
  { label: 'Scheduled',   value: 'Scheduled' },
  { label: 'In Progress', value: 'In Progress' },
  { label: 'Completed',   value: 'Completed' },
  { label: 'Canceled',    value: 'Canceled' },
];

export function JobsList() {
  const navigate = useNavigate();
  const [tab,     setTab]     = useState<JobStatus | 'All'>('All');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading, error, refetch, setSearch, setFilters } = useListQuery<ApiJob>('/api/jobs');

  const normalizedData = data.map(j => ({
    ...j,
    uiStatus: normalizeJobStatus(j.status),
  }));

  // Client-side tab filter (status already filtered server-side when tab !== All)
  const filtered = tab === 'All'
    ? normalizedData
    : normalizedData.filter(j => j.uiStatus === tab);

  // Stats from all loaded data
  const active    = normalizedData.filter(j => j.uiStatus === 'In Progress' || j.uiStatus === 'New').length;
  const scheduled = normalizedData.filter(j => j.uiStatus === 'Scheduled').length;
  const completed = normalizedData.filter(j => j.uiStatus === 'Completed').length;
  const issues    = normalizedData.filter(j => j.uiStatus === 'Canceled').length;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="p-4 md:p-6 max-w-3xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-slate-900">Jobs</h1>
            <p className="text-xs text-slate-400 mt-0.5">Mar 10, 2026</p>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3.5 py-2 text-sm hover:bg-slate-700 transition-colors">
            <Plus size={14} /> New job
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            { label: 'Active',    value: active,    color: 'text-green-600',  bg: 'bg-green-50  border-green-100' },
            { label: 'Scheduled', value: scheduled, color: 'text-blue-600',   bg: 'bg-blue-50   border-blue-100' },
            { label: 'Completed', value: completed, color: 'text-slate-600',  bg: 'bg-slate-50  border-slate-100' },
            { label: 'Issues',    value: issues,    color: 'text-orange-600', bg: 'bg-orange-50 border-orange-100' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border px-2.5 py-2.5 ${bg}`}>
              <p className={`text-lg leading-none ${color}`}>{value}</p>
              <p className="text-xs text-slate-400 mt-1">{label}</p>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 mb-3 shadow-sm">
          <Search size={15} className="text-slate-400 shrink-0" />
          <input
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by customer, description, or job #…"
            className="flex-1 text-sm text-slate-700 placeholder-slate-400 outline-none bg-transparent"
          />
        </div>

        {/* Tab filter */}
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => {
                setTab(t.value);
                if (t.value !== 'All') {
                  setFilters({ status: TAB_API_STATUS[t.value] ?? t.value.toLowerCase() });
                } else {
                  setFilters({});
                }
              }}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs opacity-60">
                {t.value === 'All'
                  ? normalizedData.length
                  : normalizedData.filter(j => j.uiStatus === t.value).length}
              </span>
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
          <div className="flex flex-col items-center gap-3 py-16">
            <p className="text-sm text-red-500">Failed to load jobs</p>
            <button onClick={refetch} className="text-xs text-blue-500 hover:underline">Retry</button>
          </div>
        )}

        {/* Job cards */}
        {!isLoading && !error && (
          <div className="flex flex-col gap-2">
            {filtered.map(job => {
              const uiStatus = job.uiStatus;
              const isMuted = uiStatus === 'Canceled' || uiStatus === 'Completed';
              const isCanceled = uiStatus === 'Canceled';
              const customerName = job.customer
                ? (job.customer.displayName || [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || 'Customer')
                : 'Customer';
              const techName = job.technician
                ? [job.technician.firstName, job.technician.lastName].filter(Boolean).join(' ')
                : null;
              const techColor = job.technician?.color ?? '#94a3b8';
              const techInitials = techName ? techName.split(' ').map(n => n[0]).join('') : null;

              return (
                <div
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && navigate(`/jobs/${job.id}`)}
                  className={`flex items-start gap-3 rounded-xl bg-white border border-slate-200 border-l-4 px-4 py-3.5 text-left hover:shadow-sm hover:border-slate-300 transition-all cursor-pointer ${STATUS_BORDER[uiStatus] ?? 'border-l-slate-200'} ${isMuted ? 'opacity-75' : ''}`}
                >
                  {/* Service icon */}
                  <span className="text-xl shrink-0 mt-0.5">{SERVICE_ICON[job.serviceType ?? ''] ?? '🔧'}</span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm text-slate-900 truncate">{customerName}</p>
                          {job.priority === 'urgent' && (
                            <AlertCircle size={12} className="text-red-500 shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          #{job.jobNumber}
                        </p>
                      </div>
                      <StatusBadge status={uiStatus} size="sm" />
                    </div>

                    <p className="text-xs text-slate-500 line-clamp-1 mb-2">{job.summary}</p>

                    {/* Footer row */}
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Tech avatar */}
                      {techName && techInitials && (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="flex size-4 items-center justify-center rounded-full text-white shrink-0"
                            style={{ fontSize: 7, background: techColor }}
                          >
                            {techInitials}
                          </span>
                          <span className="text-xs text-slate-400">{techName.split(' ')[0]}</span>
                        </span>
                      )}

                      {/* Schedule */}
                      {job.scheduledStart && (
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          <Clock size={11} />
                          {new Date(job.scheduledStart).toLocaleDateString()}
                        </span>
                      )}

                      {/* Cancel reason */}
                      {isCanceled && (
                        <span className="text-xs rounded-full px-2 py-0.5 bg-red-50 text-red-600">
                          Canceled
                        </span>
                      )}

                      {/* Field view shortcut for active jobs */}
                      {techName && (uiStatus === 'Scheduled' || uiStatus === 'In Progress') && (
                        <button
                          onClick={e => { e.stopPropagation(); navigate(`/jobs/${job.id}?view=tech`); }}
                          className="ml-auto flex items-center gap-1 text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 rounded-full px-2 py-0.5 hover:bg-indigo-100 transition-colors shrink-0"
                        >
                          <Mic size={9} /> Field
                        </button>
                      )}
                    </div>
                  </div>

                  <ChevronRight size={14} className="shrink-0 text-slate-300 mt-1" />
                </div>
              );
            })}

            {filtered.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16">
                <div className="size-12 rounded-full bg-slate-100 flex items-center justify-center">
                  <Zap size={18} className="text-slate-300" />
                </div>
                <p className="text-sm text-slate-400">No jobs match your filter</p>
              </div>
            )}
          </div>
        )}
      </div>
      {showNew && (
        <NewJobFlow
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); refetch(); }}
        />
      )}
    </div>
  );
}