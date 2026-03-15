import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, Plus, ChevronRight, Camera, Clock, User,
  AlertCircle, AlertTriangle, Zap, Mic,
} from 'lucide-react';
import { jobs, technicians } from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';
import { NewJobFlow } from './NewJobFlow';
import type { JobStatus } from '../../data/mock-data';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const STATUS_BORDER: Record<JobStatus, string> = {
  'Active':       'border-l-green-500',
  'In Progress':  'border-l-indigo-500',
  'Scheduled':    'border-l-blue-400',
  'Unscheduled':  'border-l-slate-300',
  'Completed':    'border-l-slate-200',
  'Canceled':     'border-l-red-300',
  'No Show':      'border-l-orange-400',
};

const TABS: { label: string; value: JobStatus | 'All' }[] = [
  { label: 'All',         value: 'All' },
  { label: 'Active',      value: 'Active' },
  { label: 'Scheduled',   value: 'Scheduled' },
  { label: 'Unscheduled', value: 'Unscheduled' },
  { label: 'Completed',   value: 'Completed' },
  { label: 'Canceled',    value: 'Canceled' },
];

export function JobsList() {
  const navigate = useNavigate();
  const [tab,     setTab]     = useState<JobStatus | 'All'>('All');
  const [search,  setSearch]  = useState('');
  const [showNew, setShowNew] = useState(false);

  const filtered = jobs.filter(j => {
    const matchTab    = tab === 'All' || j.status === tab;
    const matchSearch = !search ||
      j.customer.toLowerCase().includes(search.toLowerCase()) ||
      j.description.toLowerCase().includes(search.toLowerCase()) ||
      j.jobNumber.includes(search);
    return matchTab && matchSearch;
  });

  // Stats
  const active    = jobs.filter(j => j.status === 'Active' || j.status === 'In Progress').length;
  const scheduled = jobs.filter(j => j.status === 'Scheduled').length;
  const completed = jobs.filter(j => j.status === 'Completed').length;
  const issues    = jobs.filter(j => j.status === 'Canceled' || j.status === 'No Show').length;

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
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by customer, description, or job #…"
            className="flex-1 text-sm text-slate-700 placeholder-slate-400 outline-none bg-transparent"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-slate-300 hover:text-slate-500 transition-colors">✕</button>
          )}
        </div>

        {/* Tab filter */}
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.value
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs opacity-60">
                {t.value === 'All'
                  ? jobs.length
                  : jobs.filter(j => j.status === t.value).length}
              </span>
            </button>
          ))}
        </div>

        {/* Job cards */}
        <div className="flex flex-col gap-2">
          {filtered.map(job => {
            const tech = technicians.find(t => t.name === job.assignedTech);
            const isMuted = job.status === 'Canceled' || job.status === 'Completed';
            const isIssue = job.status === 'Canceled' || job.status === 'No Show';

            return (
              <div
                key={job.id}
                onClick={() => navigate(`/jobs/${job.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && navigate(`/jobs/${job.id}`)}
                className={`flex items-start gap-3 rounded-xl bg-white border border-slate-200 border-l-4 px-4 py-3.5 text-left hover:shadow-sm hover:border-slate-300 transition-all cursor-pointer ${STATUS_BORDER[job.status] ?? 'border-l-slate-200'} ${isMuted ? 'opacity-75' : ''}`}
              >
                {/* Service icon */}
                <span className="text-xl shrink-0 mt-0.5">{SERVICE_ICON[job.serviceType]}</span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm text-slate-900 truncate">{job.customer}</p>
                        {job.priority === 'Urgent' && (
                          <AlertCircle size={12} className="text-red-500 shrink-0" />
                        )}
                        {job.duplicateWarning && (
                          <span title="Possible duplicate" className="shrink-0">
                            <AlertTriangle size={12} className="text-amber-500" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        #{job.jobNumber} · {job.serviceType}
                      </p>
                    </div>
                    <StatusBadge status={job.status} size="sm" />
                  </div>

                  <p className="text-xs text-slate-500 line-clamp-1 mb-2">{job.description}</p>

                  {/* Footer row */}
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Tech avatar */}
                    {tech && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="flex size-4 items-center justify-center rounded-full text-white shrink-0"
                          style={{ fontSize: 7, background: tech.color }}
                        >
                          {tech.initials}
                        </span>
                        <span className="text-xs text-slate-400">{tech.name.split(' ')[0]}</span>
                      </span>
                    )}

                    {/* Schedule */}
                    {job.scheduledDate && (
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Clock size={11} />
                        {job.scheduledDate}{job.scheduledTime ? ` ${job.scheduledTime}` : ''}
                      </span>
                    )}

                    {/* Photos count */}
                    {job.photos && job.photos > 0 ? (
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Camera size={11} /> {job.photos}
                      </span>
                    ) : null}

                    {/* Materials */}
                    {job.materials && job.materials.length > 0 && (
                      <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 rounded-full px-1.5 py-0.5">
                        🔩 {job.materials.length}
                      </span>
                    )}

                    {/* Cancel/noshow reason */}
                    {isIssue && (
                      <span className={`text-xs rounded-full px-2 py-0.5 ${
                        job.status === 'Canceled'
                          ? 'bg-red-50 text-red-600'
                          : 'bg-orange-50 text-orange-600'
                      }`}>
                        {job.status === 'No Show' ? 'No-show' : 'Canceled'}
                      </span>
                    )}

                    {/* Field view shortcut for active jobs */}
                    {tech && (job.status === 'Active' || job.status === 'Scheduled' || job.status === 'In Progress') && (
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
      </div>
      {showNew && (
        <NewJobFlow
          onClose={() => setShowNew(false)}
          onCreated={() => setShowNew(false)}
        />
      )}
    </div>
  );
}