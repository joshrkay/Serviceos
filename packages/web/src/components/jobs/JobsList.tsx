import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, Plus, ChevronRight, Camera, Clock,
  AlertCircle, Mic,
} from 'lucide-react';
import type { JobListItem } from '@ai-service-os/shared';
import { useListQuery } from '../../hooks/useListQuery';
import { normalizeJobStatus } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { Spinner, EmptyState, Input } from '../ui';
import { ErrorState } from '../ErrorState';
import { NewJobFlow } from './NewJobFlow';

// UI tab-label union (distinct from the API status values mapped in TAB_API_STATUS).
type JobStatus = 'New' | 'Scheduled' | 'In Progress' | 'Completed' | 'Canceled';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const STATUS_BORDER: Partial<Record<string, string>> = {
  'New':          'border-l-border',
  'In Progress':  'border-l-primary',
  'Scheduled':    'border-l-primary',
  'Completed':    'border-l-success',
  'Canceled':     'border-l-destructive',
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

  const { data, isLoading, error, refetch, setSearch, setFilters } = useListQuery<JobListItem>(
    '/api/jobs',
    {
      // Live refresh so a dispatcher sees status changes without a manual
      // reload. Background refetch keeps cards mounted (no spinner flash).
      refetchInterval: 60_000,
    },
  );

  const applyTabFilter = (nextTab: JobStatus | 'All') => {
    setTab(nextTab);
    if (nextTab !== 'All') {
      setFilters({ status: TAB_API_STATUS[nextTab] ?? nextTab.toLowerCase() });
    } else {
      setFilters({});
    }
  };

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
            <h1 className="text-foreground">Jobs</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3.5 py-2 text-sm hover:bg-primary/90 transition-colors">
            <Plus size={14} /> New job
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            { label: 'Active',    value: active,    color: 'text-success',  bg: 'bg-success/10  border-success/20' },
            { label: 'Scheduled', value: scheduled, color: 'text-primary',   bg: 'bg-primary/10   border-primary/20' },
            { label: 'Completed', value: completed, color: 'text-foreground',  bg: 'bg-secondary  border-border' },
            { label: 'Issues',    value: issues,    color: 'text-warning', bg: 'bg-warning/10 border-warning/20' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border px-2.5 py-2.5 ${bg}`}>
              <p className={`text-lg leading-none ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground mt-1">{label}</p>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="mb-3">
          <Input
            leftIcon={<Search size={15} />}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by customer, description, or job #…"
            className="min-h-11"
          />
        </div>

        {/* Tab filter */}
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => applyTabFilter(t.value)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-foreground hover:bg-secondary'
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

        {/* Loading / Error — keep cards mounted during background refresh. */}
        {isLoading && data.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="md" className="text-foreground" label="Loading jobs" />
          </div>
        )}
        {error && (
          <ErrorState message="Failed to load jobs" onRetry={refetch} />
        )}

        {/* Job cards */}
        {!(isLoading && data.length === 0) && !error && (
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
                  className={`flex items-start gap-3 rounded-xl bg-card border border-border border-l-4 px-4 py-3.5 text-left hover:shadow-sm hover:border-border transition-all cursor-pointer ${STATUS_BORDER[uiStatus] ?? 'border-l-border'} ${isMuted ? 'opacity-75' : ''}`}
                >
                  {/* Service icon */}
                  <span className="text-xl shrink-0 mt-0.5">{SERVICE_ICON[job.serviceType ?? ''] ?? '🔧'}</span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm text-foreground truncate">{customerName}</p>
                          {job.priority === 'urgent' && (
                            <AlertCircle size={12} className="text-destructive shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          #{job.jobNumber}
                        </p>
                      </div>
                      <StatusBadge status={uiStatus} size="sm" />
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-1 mb-2">{job.summary}</p>

                    {/* Footer row */}
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Tech avatar */}
                      {techName && techInitials && (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="flex size-4 items-center justify-center rounded-full text-primary-foreground shrink-0"
                            style={{ fontSize: 7, background: techColor }}
                          >
                            {techInitials}
                          </span>
                          <span className="text-xs text-muted-foreground">{techName.split(' ')[0]}</span>
                        </span>
                      )}

                      {/* Schedule */}
                      {job.scheduledStart && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock size={11} />
                          {new Date(job.scheduledStart).toLocaleDateString()}
                        </span>
                      )}

                      {/* Cancel reason */}
                      {isCanceled && (
                        <span className="text-xs rounded-full px-2 py-0.5 bg-destructive/10 text-destructive">
                          Canceled
                        </span>
                      )}

                      {/* Field view shortcut for active jobs */}
                      {techName && (uiStatus === 'Scheduled' || uiStatus === 'In Progress') && (
                        <button
                          onClick={e => { e.stopPropagation(); navigate(`/jobs/${job.id}?view=tech`); }}
                          className="ml-auto flex items-center gap-1 text-xs bg-primary/10 text-primary border border-primary/30 rounded-full px-2 py-0.5 hover:bg-primary/15 transition-colors shrink-0"
                        >
                          <Mic size={9} /> Field
                        </button>
                      )}
                    </div>
                  </div>

                  <ChevronRight size={14} className="shrink-0 text-muted-foreground mt-1" />
                </div>
              );
            })}

            {filtered.length === 0 && (
              <EmptyState title="No jobs match your filter" />
            )}
          </div>
        )}
      </div>
      {showNew && (
        <NewJobFlow
          onClose={() => setShowNew(false)}
          onCreated={(nextTab = 'All') => {
            applyTabFilter(nextTab);
            setShowNew(false);
          }}
        />
      )}
    </div>
  );
}
