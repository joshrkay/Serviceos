import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, User } from 'lucide-react';
import { technicians } from '../../data/mock-data';
import { useListQuery } from '../../hooks/useListQuery';
import { normalizeJobStatus } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { useNavigate } from 'react-router';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const TECH_COLORS: Record<string, string> = {
  'Carlos Reyes': 'bg-blue-100 text-blue-700 border-blue-200',
  'Marcus Webb':  'bg-green-100 text-green-700 border-green-200',
  'Sarah Lin':    'bg-violet-100 text-violet-700 border-violet-200',
};

interface ApiJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  priority?: string;
  serviceType?: string;
  scheduledStart?: string;
  assignedTechnicianId?: string;
  customer?: { id: string; displayName?: string; firstName?: string; lastName?: string };
  technician?: { id: string; firstName?: string; lastName?: string; color?: string };
}

/** Build a 7-day window starting from today */
function buildWeekDays(today: Date) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i - 1); // start 1 day before today
    const label = d.toLocaleDateString('en-US', { weekday: 'short' });
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isoDate = d.toISOString().split('T')[0];
    const isToday = i === 1;
    return { label, date, isoDate, isToday };
  });
}

export function SchedulePage() {
  const navigate = useNavigate();
  const today = useMemo(() => new Date(), []);
  const weekDays = useMemo(() => buildWeekDays(today), [today]);
  const [selectedIso, setSelectedIso] = useState(weekDays[1].isoDate); // today
  const [techFilter, setTechFilter] = useState<string>('All');

  const { data, isLoading, error, refetch, setFilters } = useListQuery<ApiJob>('/api/jobs', {
    filters: { scheduledDate: selectedIso },
  });

  function selectDay(isoDate: string) {
    setSelectedIso(isoDate);
    setFilters({ scheduledDate: isoDate });
  }

  // Client-side tech filter
  const dayJobs = techFilter === 'All'
    ? data
    : data.filter(j => {
        const techName = j.technician
          ? [j.technician.firstName, j.technician.lastName].filter(Boolean).join(' ')
          : null;
        return techName === techFilter;
      });

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-slate-900">Schedule</h1>
        <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors">
          <Plus size={14} /> New job
        </button>
      </div>

      {/* Week nav */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => {
            const prev = new Date(selectedIso);
            prev.setDate(prev.getDate() - 1);
            selectDay(prev.toISOString().split('T')[0]);
          }}
          className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="flex-1 flex gap-1 overflow-x-auto scrollbar-none">
          {weekDays.map(day => {
            const isSelected = day.isoDate === selectedIso;
            return (
              <button
                key={day.isoDate}
                onClick={() => selectDay(day.isoDate)}
                className={`flex-1 min-w-[64px] flex flex-col items-center rounded-xl py-2.5 transition-all border ${
                  isSelected
                    ? 'bg-slate-900 border-slate-900 text-white'
                    : day.isToday
                    ? 'bg-blue-50 border-blue-100 text-blue-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="text-xs">{day.label}</span>
                <span className={`text-xs mt-0.5 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>{day.date}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => {
            const next = new Date(selectedIso);
            next.setDate(next.getDate() + 1);
            selectDay(next.toISOString().split('T')[0]);
          }}
          className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Tech filter */}
      <div className="flex gap-2 mb-5 overflow-x-auto scrollbar-none">
        {['All', ...technicians.map(t => t.name)].map(name => {
          const t = technicians.find(x => x.name === name);
          const isSelected = techFilter === name;
          return (
            <button
              key={name}
              onClick={() => setTechFilter(name)}
              className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs border transition-colors ${
                isSelected
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {t && (
                <span
                  className="flex size-4 items-center justify-center rounded-full text-white shrink-0"
                  style={{ fontSize: 8, backgroundColor: t.color }}
                >
                  {t.initials}
                </span>
              )}
              {name === 'All' ? 'All techs' : name.split(' ')[0]}
            </button>
          );
        })}
      </div>

      {/* Day label */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-slate-700">
          {weekDays.find(d => d.isoDate === selectedIso)?.isToday
            ? "Today's schedule"
            : `${weekDays.find(d => d.isoDate === selectedIso)?.label ?? ''}'s schedule`}
        </h3>
        <span className="text-xs text-slate-400">{dayJobs.length} job{dayJobs.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Loading / Error */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center py-12 gap-2 text-center">
          <p className="text-sm text-red-500">Failed to load schedule</p>
          <button onClick={refetch} className="text-xs text-blue-500 hover:underline">Retry</button>
        </div>
      )}

      {/* Jobs */}
      {!isLoading && !error && (dayJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">📅</span>
          <p className="text-sm text-slate-500 mb-1">Nothing scheduled</p>
          <p className="text-xs text-slate-400">Tap "New job" to schedule something</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {dayJobs
            .sort((a, b) => {
              const t = (s?: string) => s ? new Date(s).getTime() : Infinity;
              return t(a.scheduledStart) - t(b.scheduledStart);
            })
            .map(job => {
              const techName = job.technician
                ? [job.technician.firstName, job.technician.lastName].filter(Boolean).join(' ')
                : null;
              const techColor = job.technician?.color ?? '#94a3b8';
              const techInitials = techName ? techName.split(' ').map(n => n[0]).join('') : null;
              const techStyle = techName ? (TECH_COLORS[techName] ?? '') : '';
              const customerName = job.customer
                ? (job.customer.displayName || [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || 'Customer')
                : 'Customer';
              const uiStatus = normalizeJobStatus(job.status);
              const scheduledTime = job.scheduledStart
                ? new Date(job.scheduledStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                : null;

              return (
                <button
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  className="flex gap-4 rounded-xl bg-white border border-slate-200 px-4 py-4 text-left hover:border-slate-300 hover:shadow-sm transition-all"
                >
                  {/* Time column */}
                  <div className="shrink-0 w-16 text-right">
                    {scheduledTime ? (
                      <>
                        <p className="text-sm text-slate-800">{scheduledTime}</p>
                        <p className="text-xs text-slate-400 mt-0.5">~2 hrs</p>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400">TBD</p>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="flex flex-col items-center gap-1">
                    <span className="size-2.5 rounded-full border-2 border-blue-500 bg-white mt-0.5 shrink-0" />
                    <span className="w-px flex-1 bg-slate-100" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm text-slate-900">{customerName}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{job.summary}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-base">{SERVICE_ICON[job.serviceType ?? ''] ?? '🔧'}</span>
                        <StatusBadge status={uiStatus} size="sm" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Clock size={11} /> {scheduledTime ?? 'Unscheduled'}
                      </span>
                      {techName && techInitials && (
                        <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${techStyle}`}>
                          <span
                            className="flex size-4 items-center justify-center rounded-full text-white"
                            style={{ fontSize: 8, backgroundColor: techColor }}
                          >
                            {techInitials}
                          </span>
                          {techName.split(' ')[0]}
                        </span>
                      )}
                      {!techName && (
                        <span className="flex items-center gap-1 text-xs text-amber-600">
                          <User size={11} /> Unassigned
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
        </div>
      ))}

      {/* Technician availability summary (uses mock data until /api/technicians is available) */}
      <div className="mt-6 rounded-xl bg-white border border-slate-200 px-4 py-4">
        <h4 className="text-slate-700 mb-3">Team today</h4>
        <div className="flex flex-col gap-3">
          {technicians.map(tech => {
            const techJobs = data.filter(j => {
              const name = j.technician
                ? [j.technician.firstName, j.technician.lastName].filter(Boolean).join(' ')
                : null;
              return name === tech.name;
            });
            return (
              <div key={tech.id} className="flex items-center gap-3">
                <span
                  className="flex size-7 items-center justify-center rounded-full text-white text-xs shrink-0"
                  style={{ backgroundColor: tech.color }}
                >
                  {tech.initials}
                </span>
                <div className="flex-1">
                  <p className="text-sm text-slate-800">{tech.name}</p>
                  <p className="text-xs text-slate-400">{techJobs.length} job{techJobs.length !== 1 ? 's' : ''} scheduled</p>
                </div>
                <div className="flex gap-1">
                  {techJobs.map(j => (
                    <span key={j.id} className="text-base">{SERVICE_ICON[j.serviceType ?? ''] ?? '🔧'}</span>
                  ))}
                  {techJobs.length === 0 && <span className="text-xs text-slate-400">Available</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </div>
  );
}