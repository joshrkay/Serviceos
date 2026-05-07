import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, User, AlertTriangle } from 'lucide-react';
import { technicians, jobs as mockJobs } from '../../data/mock-data';
import { useListQuery } from '../../hooks/useListQuery';
import { normalizeJobStatus } from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';

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

type ScheduleViewMode = 'personal' | 'team';

function readRuntimePermissions(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const raw = window.localStorage.getItem('serviceos.permissions');
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
  }
  return new Set();
}

function toLocalDatetimeInputValue(isoDateTime?: string): string {
  if (!isoDateTime) return '';
  const d = new Date(isoDateTime);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const todayIso = useMemo(() => today.toISOString().split('T')[0], [today]);
  const [selectedIso, setSelectedIso] = useState(weekDays[1].isoDate); // today
  const [techFilter, setTechFilter] = useState<string>('All');
  const [viewMode, setViewMode] = useState<ScheduleViewMode>('team');
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [showNewEvent, setShowNewEvent] = useState(false);
  const [newEventJobId, setNewEventJobId] = useState('');
  const [newEventTechnicianId, setNewEventTechnicianId] = useState(technicians[0]?.id ?? '');
  const [newEventStart, setNewEventStart] = useState('');

  const { data, isLoading, error, refetch, setFilters } = useListQuery<ApiJob>('/api/jobs', {
    filters: { scheduledDate: selectedIso },
  });

  const runtimePermissions = useMemo(() => readRuntimePermissions(), []);
  const canManageSchedule = runtimePermissions.size === 0 || runtimePermissions.has('jobs:update');
  const canViewTeamSchedule = runtimePermissions.size === 0
    || runtimePermissions.has('schedule:view:team')
    || runtimePermissions.has('jobs:view');
  const myTechnicianId = useMemo(() => {
    if (typeof window !== 'undefined') {
      const fromStorage = window.localStorage.getItem('serviceos.technicianId');
      if (fromStorage) return fromStorage;
    }
    return technicians[0]?.id ?? '';
  }, []);

  async function updateSchedule(
    jobId: string,
    payload: { assignedTechnicianId?: string; scheduledStart?: string | null; status?: string },
    successMessage: string
  ) {
    setIsSaving(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActionSuccess(successMessage);
      await refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save schedule');
    } finally {
      setIsSaving(false);
    }
  }

  function selectDay(isoDate: string) {
    setSelectedIso(isoDate);
    setFilters({ scheduledDate: isoDate });
  }

  const fallbackJobs: ApiJob[] = useMemo(() => {
    if (selectedIso !== todayIso) return [];
    return mockJobs.map((job, idx) => {
      const assignedTech = technicians.find((t) => t.name === job.assignedTech);
      const hourToken = (job.scheduledTime ?? '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
      const hour = hourToken ? Number(hourToken[1]) % 12 + (hourToken[3].toUpperCase() === 'PM' ? 12 : 0) : 9 + idx;
      const minute = hourToken?.[2] ? Number(hourToken[2]) : 0;
      const start = new Date(`${selectedIso}T00:00:00`);
      start.setHours(hour, minute, 0, 0);
      return {
        id: `fallback-${job.id}`,
        jobNumber: job.jobNumber,
        summary: job.description,
        status: job.status.toLowerCase().replace(/\s+/g, '_'),
        serviceType: job.serviceType,
        scheduledStart: start.toISOString(),
        customer: { id: job.customerId, displayName: job.customer },
        technician: assignedTech
          ? { id: assignedTech.id, firstName: assignedTech.name.split(' ')[0], lastName: assignedTech.name.split(' ').slice(1).join(' '), color: assignedTech.color }
          : undefined,
      };
    });
  }, [selectedIso, todayIso]);

  const activeData = error ? fallbackJobs : data;
  const isFallbackMode = Boolean(error);

  // Apply personal-view scope, then client-side tech filter
  const scopedData = viewMode === 'personal'
    ? activeData.filter(j => j.technician?.id === myTechnicianId || j.assignedTechnicianId === myTechnicianId)
    : activeData;

  const dayJobs = techFilter === 'All'
    ? scopedData
    : scopedData.filter(j => {
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
        <button
          onClick={() => setShowNewEvent((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
        >
          <Plus size={14} /> New event
        </button>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setViewMode('personal')}
          className={`rounded-full px-3 py-1.5 text-xs border ${viewMode === 'personal' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}
        >
          My schedule
        </button>
        <button
          onClick={() => canViewTeamSchedule && setViewMode('team')}
          disabled={!canViewTeamSchedule}
          className={`rounded-full px-3 py-1.5 text-xs border ${viewMode === 'team' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'} disabled:opacity-50`}
        >
          Team schedule
        </button>
      </div>

      {showNewEvent && canManageSchedule && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
          <h4 className="text-sm text-slate-800 mb-3">Schedule event</h4>
          <div className="grid md:grid-cols-3 gap-2">
            <input
              value={newEventJobId}
              onChange={(e) => setNewEventJobId(e.target.value)}
              placeholder="Job ID"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <select
              value={newEventTechnicianId}
              onChange={(e) => setNewEventTechnicianId(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Unassigned</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input
              type="datetime-local"
              value={newEventStart}
              onChange={(e) => setNewEventStart(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </div>
          <div className="mt-3">
            <button
              disabled={!newEventJobId || !newEventStart || isSaving}
              onClick={() => updateSchedule(
                newEventJobId,
                { status: 'scheduled', assignedTechnicianId: newEventTechnicianId || undefined, scheduledStart: new Date(newEventStart).toISOString() },
                'Scheduled event updated'
              )}
              className="rounded-lg bg-slate-900 px-3 py-2 text-xs text-white disabled:opacity-50"
            >
              Save event
            </button>
          </div>
        </div>
      )}

      {actionError && <p className="text-xs text-red-600 mb-2">{actionError}</p>}
      {actionSuccess && <p className="text-xs text-green-600 mb-2">{actionSuccess}</p>}

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
        <div className="flex flex-col items-center py-4 gap-2 text-center mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4">
          <p className="text-sm text-red-500">Failed to load live schedule</p>
          <p className="text-xs text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={12} /> Showing fallback schedule view while we reconnect.
          </p>
          <button onClick={refetch} className="text-xs text-blue-500 hover:underline">Retry live data</button>
        </div>
      )}

      {/* Jobs */}
      {!isLoading && (dayJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">📅</span>
          <p className="text-sm text-slate-500 mb-1">
            {isFallbackMode ? 'No fallback schedule for this day' : 'Nothing scheduled'}
          </p>
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
                    {canManageSchedule && (
                      <div className="mt-3 grid md:grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
                        <select
                          defaultValue={job.technician?.id ?? job.assignedTechnicianId ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const nextTechId = e.target.value || undefined;
                            updateSchedule(job.id, { assignedTechnicianId: nextTechId }, 'Technician assignment updated');
                          }}
                          className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                        >
                          <option value="">Unassigned</option>
                          {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <input
                          type="datetime-local"
                          defaultValue={toLocalDatetimeInputValue(job.scheduledStart)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const iso = e.target.value ? new Date(e.target.value).toISOString() : null;
                            updateSchedule(job.id, { scheduledStart: iso, status: iso ? 'scheduled' : 'new' }, iso ? 'Event rescheduled' : 'Event unscheduled');
                          }}
                          className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            updateSchedule(job.id, { scheduledStart: null, status: 'new' }, 'Event removed from calendar');
                          }}
                          className="rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700"
                        >
                          Remove
                        </button>
                      </div>
                    )}
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
              const techJobs = activeData.filter(j => {
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
