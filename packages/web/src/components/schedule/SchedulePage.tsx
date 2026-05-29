import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Plus, Clock, User, AlertTriangle,
  Bell, CheckCircle, X, MapPin, Briefcase,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';
import { useTechnicianRoster } from '../../hooks/useTechnicianRoster';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz, formatTimeInTenantTz } from '../../utils/formatInTenantTz';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const TECH_COLORS: Record<string, string> = {
  'Carlos Reyes': 'bg-blue-100 text-blue-700 border-blue-200',
  'Marcus Webb':  'bg-green-100 text-green-700 border-green-200',
  'Sarah Lin':    'bg-violet-100 text-violet-700 border-violet-200',
};

interface ApiAppointment {
  id: string;
  jobId: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  notes?: string;
  timezone: string;
  holdPendingApproval?: boolean;
  holdExpiryAt?: string;
}

interface EnrichedAppointment extends ApiAppointment {
  customerName: string;
  jobSummary: string;
  serviceAddress: string;
  technicianId: string;
  technicianName: string;
  serviceType: string;
  hasConflict: boolean;
}

/** Build a 7-day window starting from yesterday, labelled in the tenant TZ. */
function buildWeekDays(today: Date, timezone: string) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i - 1);
    const label = formatInTenantTz(d, timezone, { weekday: 'short' });
    const date  = formatInTenantTz(d, timezone, { month: 'short', day: 'numeric' });
    const isoDate = d.toISOString().split('T')[0];
    return { label, date, isoDate, isToday: i === 1 };
  });
}

function toTimeLabel(iso: string, timezone: string) {
  return formatTimeInTenantTz(iso, timezone);
}

function overlap(a: ApiAppointment, b: ApiAppointment): boolean {
  const aStart = new Date(a.scheduledStart).getTime();
  const aEnd   = new Date(a.scheduledEnd).getTime();
  const bStart = new Date(b.scheduledStart).getTime();
  const bEnd   = new Date(b.scheduledEnd).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/** Delay notification form */
function DelaySheet({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const [minutes, setMinutes] = useState<10 | 15 | 20 | 60>(20);
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/appointments/${appointmentId}/delay-ack`, {
        method: 'POST',
        body: JSON.stringify({ appointmentId, isRunningBehind: true, delayMinutes: minutes }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.message ?? `HTTP ${res.status}`);
      }
      setSent(true);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send delay notice');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-slate-800">Notify next customer of delay</p>
          <button onClick={onClose}><X size={15} className="text-slate-400" /></button>
        </div>
        {sent ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <CheckCircle size={32} className="text-green-500" />
            <p className="text-sm text-slate-700">Delay notice sent</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-500 mb-3">Select delay duration:</p>
            <div className="flex gap-2 mb-4">
              {([10, 15, 20, 60] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMinutes(m)}
                  className={`flex-1 rounded-lg border py-2 text-sm transition-colors ${
                    minutes === m ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600'
                  }`}
                >
                  {m} min
                </button>
              ))}
            </div>
            {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
            <button
              onClick={send}
              disabled={sending}
              className="w-full rounded-xl bg-amber-500 text-white py-3 text-sm hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {sending ? 'Sending…' : `Send ${minutes}-min delay notice`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** New appointment form panel */
function NewAppointmentForm({ selectedDate, onCreated, onClose, technicians }: {
  selectedDate: string;
  onCreated: () => void;
  onClose: () => void;
  technicians: { id: string; name: string }[];
}) {
  const [jobId,    setJobId]    = useState('');
  const [techId,   setTechId]   = useState('');
  useEffect(() => {
    if (!techId && technicians[0]?.id) setTechId(technicians[0].id);
  }, [technicians, techId]);
  const [startTime, setStartTime] = useState('10:00');
  const [endTime,   setEndTime]   = useState('12:00');
  const [saving, setSaving]     = useState(false);
  const [error,  setError]      = useState<string | null>(null);
  const [jobInfo, setJobInfo]   = useState<{ jobNumber: string; summary: string; customer?: { displayName?: string } } | null>(null);

  useEffect(() => {
    if (!jobId || jobId.length < 10) { setJobInfo(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await apiFetch(`/api/jobs/${jobId}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        setJobInfo(await res.json());
      } else {
        // Clear stale preview when the new job id can't be resolved so
        // dispatchers don't schedule against an unrelated prior job.
        setJobInfo(null);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [jobId]);

  async function save() {
    if (!jobId.trim()) { setError('Job ID is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const start = new Date(`${selectedDate}T${startTime}:00`);
      const end   = new Date(`${selectedDate}T${endTime}:00`);
      if (end <= start) { setError('End time must be after start time'); setSaving(false); return; }

      // Create the appointment
      const apptRes = await apiFetch('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({
          jobId: jobId.trim(),
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
        }),
      });
      if (!apptRes.ok) {
        const j = await apptRes.json().catch(() => ({}));
        throw new Error(j?.message ?? `HTTP ${apptRes.status}`);
      }

      // Also update the job's assigned technician and scheduled start
      if (techId) {
        await apiFetch(`/api/jobs/${jobId.trim()}`, {
          method: 'PUT',
          body: JSON.stringify({ assignedTechnicianId: techId, scheduledStart: start.toISOString(), status: 'scheduled' }),
        }).catch(() => null);
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create appointment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-800">New appointment</p>
        <button onClick={onClose}><X size={14} className="text-slate-400" /></button>
      </div>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-500 md:col-span-2">
          Job ID *
          <input value={jobId} onChange={e => setJobId(e.target.value)} placeholder="paste job UUID"
            className="w-full mt-0.5 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          {jobInfo && (
            <p className="text-xs text-slate-500 mt-0.5">{jobInfo.jobNumber} — {jobInfo.summary}</p>
          )}
        </label>
        <label className="text-xs text-slate-500">
          Start time
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
            className="w-full mt-0.5 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500">
          End time
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
            className="w-full mt-0.5 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Assign technician
          <select value={techId} onChange={e => setTechId(e.target.value)}
            className="w-full mt-0.5 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Unassigned</option>
            {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <button
        onClick={save}
        disabled={saving || !jobId.trim()}
        className="mt-3 w-full rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : 'Create appointment'}
      </button>
    </div>
  );
}

export function SchedulePage() {
  const navigate = useNavigate();
  const { technicians } = useTechnicianRoster();
  const tz = useTenantTimezone();
  const today = useMemo(() => new Date(), []);
  const weekDays = useMemo(() => buildWeekDays(today, tz), [today, tz]);
  const [selectedIso, setSelectedIso] = useState(weekDays[1].isoDate);
  const [showNew,     setShowNew]     = useState(false);
  const [techFilter,  setTechFilter]  = useState('All');
  const [appointments, setAppointments] = useState<ApiAppointment[]>([]);
  const [enriched,    setEnriched]    = useState<EnrichedAppointment[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [delayApptId, setDelayApptId] = useState<string | null>(null);
  const [detailAppt,  setDetailAppt]  = useState<EnrichedAppointment | null>(null);

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const start = new Date(selectedIso + 'T00:00:00');
      const end   = new Date(selectedIso + 'T23:59:59.999');
      const from  = start.toISOString();
      const to    = end.toISOString();
      const res  = await apiFetch(`/api/appointments?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}&sort=asc`);
      if (!res.ok) {
        // Surface a clear error instead of a misleading empty state (BUG-4).
        if (res.status === 401) {
          setError('Session expired — please reload');
        } else {
          setError("Couldn't load appointments — please try again");
        }
        setLoading(false);
        return;
      }
      const body = await res.json();
      const list: ApiAppointment[] = body.data ?? body ?? [];
      setAppointments(list);

      // Enrich each appointment with job/customer data
      const enrichedList = await Promise.all(list.map(async appt => {
        try {
          const jobRes = await apiFetch(`/api/jobs/${appt.jobId}`);
          if (!jobRes.ok) return buildFallback(appt);
          const job = await jobRes.json();
          const tech = technicians.find(t => t.id === job.assignedTechnicianId);
          const customerName = job.customer
            ? (job.customer.displayName || [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || 'Customer')
            : job.customerName || 'Customer';
          const loc = job.location;
          const addr = loc
            ? [loc.street1, loc.city, loc.state].filter(Boolean).join(', ')
            : job.address || '';
          return {
            ...appt,
            customerName,
            jobSummary: job.summary || job.description || '',
            serviceAddress: addr,
            technicianId: tech?.id ?? job.assignedTechnicianId ?? '',
            technicianName: tech?.name ?? job.technicianName ?? 'Unassigned',
            serviceType: job.serviceType ?? '',
            hasConflict: false,
          };
        } catch {
          return buildFallback(appt);
        }
      }));

      // Detect conflicts: same technician, overlapping time
      const withConflicts: EnrichedAppointment[] = enrichedList.map((a, i) => ({
        ...a,
        hasConflict: enrichedList.some((b, j) =>
          j !== i &&
          a.technicianId &&
          a.technicianId === b.technicianId &&
          overlap(a, b)
        ),
      }));

      setEnriched(withConflicts);
    } catch {
      setAppointments([]);
      setEnriched([]);
      setError("Couldn't load appointments — please try again");
    } finally {
      setLoading(false);
    }
  }, [selectedIso]);

  useEffect(() => { loadAppointments(); }, [loadAppointments]);

  // Re-apply technician names when the roster loads after appointments.
  const technicianIdsKey = technicians.map((t) => t.id).join(',');
  useEffect(() => {
    if (technicians.length === 0) return;
    setEnriched((prev) => {
      let changed = false;
      const next = prev.map((a) => {
        if (!a.technicianId) return a;
        const tech = technicians.find((t) => t.id === a.technicianId);
        if (!tech || a.technicianName === tech.name) return a;
        changed = true;
        return { ...a, technicianName: tech.name };
      });
      return changed ? next : prev;
    });
  }, [technicianIdsKey, technicians]);

  function buildFallback(appt: ApiAppointment): EnrichedAppointment {
    return { ...appt, customerName: 'Customer', jobSummary: appt.jobId, serviceAddress: '', technicianId: '', technicianName: 'Unassigned', serviceType: '', hasConflict: false };
  }

  const displayed = techFilter === 'All'
    ? enriched
    : enriched.filter(a => a.technicianName === techFilter);

  const conflictCount = enriched.filter(a => a.hasConflict).length;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-slate-900">Schedule</h1>
          {conflictCount > 0 && (
            <p className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
              <AlertTriangle size={11} /> {conflictCount} scheduling conflict{conflictCount !== 1 ? 's' : ''} today
            </p>
          )}
        </div>
        <button
          onClick={() => setShowNew(v => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
        >
          <Plus size={14} /> New appointment
        </button>
      </div>

      {/* Week nav */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => { const d = new Date(selectedIso); d.setDate(d.getDate() - 1); setSelectedIso(d.toISOString().split('T')[0]); }}
          className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="flex-1 flex gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {weekDays.map(day => {
            const isSelected = day.isoDate === selectedIso;
            return (
              <button key={day.isoDate} onClick={() => setSelectedIso(day.isoDate)}
                className={`flex-1 min-w-[64px] flex flex-col items-center rounded-xl py-2.5 transition-all border ${
                  isSelected ? 'bg-slate-900 border-slate-900 text-white' :
                  day.isToday ? 'bg-blue-50 border-blue-100 text-blue-700' :
                  'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="text-xs">{day.label}</span>
                <span className={`text-xs mt-0.5 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>{day.date}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => { const d = new Date(selectedIso); d.setDate(d.getDate() + 1); setSelectedIso(d.toISOString().split('T')[0]); }}
          className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Tech filter */}
      <div className="flex gap-2 mb-5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {['All', ...technicians.map(t => t.name)].map(name => {
          const t = technicians.find(x => x.name === name);
          return (
            <button key={name} onClick={() => setTechFilter(name)}
              className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs border transition-colors ${
                techFilter === name ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {t && <span className="flex size-4 items-center justify-center rounded-full text-white shrink-0" style={{ fontSize: 8, backgroundColor: t.color }}>{t.initials}</span>}
              {name === 'All' ? 'All techs' : name.split(' ')[0]}
            </button>
          );
        })}
      </div>

      {/* New appointment form */}
      {showNew && (
        <NewAppointmentForm
          selectedDate={selectedIso}
          onCreated={loadAppointments}
          onClose={() => setShowNew(false)}
          technicians={technicians}
        />
      )}

      {/* Appointments list */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-slate-700">
          {weekDays.find(d => d.isoDate === selectedIso)?.isToday ? "Today's appointments" :
           `${weekDays.find(d => d.isoDate === selectedIso)?.label ?? ''}'s appointments`}
        </h3>
        <span className="text-xs text-slate-400">{displayed.length} appointment{displayed.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <AlertTriangle size={28} className="text-amber-500 mb-3" />
          <p className="text-sm text-slate-700 mb-2">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            Reload page
          </button>
        </div>
      )}

      {!loading && !error && displayed.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">📅</span>
          <p className="text-sm text-slate-500 mb-1">No appointments</p>
          <p className="text-xs text-slate-400">Tap "New appointment" to schedule one</p>
        </div>
      )}

      {!loading && !error && (
        <div className="flex flex-col gap-3">
          {displayed
            .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
            .map(appt => {
              const tech = technicians.find(t => t.name === appt.technicianName);
              const techColor = tech?.color ?? '#94a3b8';
              const techStyle = appt.technicianName ? (TECH_COLORS[appt.technicianName] ?? '') : '';
              const techInitials = appt.technicianName !== 'Unassigned'
                ? appt.technicianName.split(' ').map(n => n[0]).join('')
                : null;
              return (
                <div
                  key={appt.id}
                  className={`rounded-xl bg-white border px-4 py-4 transition-all ${
                    appt.holdPendingApproval
                      ? 'border-dashed border-amber-400 bg-amber-50/80'
                      : appt.hasConflict
                        ? 'border-amber-300 bg-amber-50/30'
                        : 'border-slate-200'
                  }`}
                >
                  {appt.holdPendingApproval && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-800 bg-amber-100 border border-amber-200 rounded-lg px-2.5 py-1 mb-3 w-fit">
                      Tentative hold
                      {appt.holdExpiryAt && (
                        <span>
                          · expires {formatTimeInTenantTz(appt.holdExpiryAt, tz)}
                        </span>
                      )}
                    </div>
                  )}
                  {/* Conflict badge */}
                  {appt.hasConflict && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded-lg px-2.5 py-1 mb-3 w-fit">
                      <AlertTriangle size={11} /> Scheduling conflict
                    </div>
                  )}

                  <div className="flex gap-4">
                    {/* Time column */}
                    <div className="shrink-0 w-16 text-right">
                      <p className="text-sm text-slate-800">{toTimeLabel(appt.scheduledStart, tz)}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{toTimeLabel(appt.scheduledEnd, tz)}</p>
                    </div>

                    {/* Divider */}
                    <div className="flex flex-col items-center gap-1">
                      <span className={`size-2.5 rounded-full border-2 mt-0.5 shrink-0 ${appt.hasConflict ? 'border-amber-500 bg-white' : 'border-blue-500 bg-white'}`} />
                      <span className="w-px flex-1 bg-slate-100" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm text-slate-900">{appt.customerName}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{appt.jobSummary}</p>
                          {appt.serviceAddress && (
                            <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
                              <MapPin size={9} /> {appt.serviceAddress}
                            </p>
                          )}
                        </div>
                        <span className="text-base shrink-0">{SERVICE_ICON[appt.serviceType ?? ''] ?? '🔧'}</span>
                      </div>

                      <div className="flex items-center gap-3 mt-2">
                        {techInitials ? (
                          <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${techStyle}`}>
                            <span className="flex size-4 items-center justify-center rounded-full text-white" style={{ fontSize: 8, backgroundColor: techColor }}>
                              {techInitials}
                            </span>
                            {appt.technicianName.split(' ')[0]}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-600">
                            <User size={11} /> Unassigned
                          </span>
                        )}
                        <span className="text-xs text-slate-400">{appt.status}</span>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => navigate(`/appointments/${appt.id}/edit`)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition-colors flex items-center gap-1"
                        >
                          <Briefcase size={11} /> Edit
                        </button>
                        <button
                          onClick={() => setDelayApptId(appt.id)}
                          className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 hover:bg-amber-100 transition-colors flex items-center gap-1"
                        >
                          <Bell size={11} /> Notify delay
                        </button>
                        <button
                          onClick={() => setDetailAppt(appt)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
                        >
                          Details
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          }
        </div>
      )}
    </div>

    {/* Delay notification modal */}
    {delayApptId && (
      <DelaySheet appointmentId={delayApptId} onClose={() => setDelayApptId(null)} />
    )}

    {/* Detail modal */}
    {detailAppt && (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-4" onClick={() => setDetailAppt(null)}>
        <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl p-5" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-slate-800">Appointment details</p>
            <button onClick={() => setDetailAppt(null)}><X size={15} className="text-slate-400" /></button>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-slate-900 font-medium">{detailAppt.customerName}</p>
            <p className="text-xs text-slate-500">{detailAppt.jobSummary}</p>
            {detailAppt.serviceAddress && (
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <MapPin size={11} className="text-slate-400" /> {detailAppt.serviceAddress}
              </p>
            )}
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <Clock size={11} className="text-slate-400" />
              {toTimeLabel(detailAppt.scheduledStart, tz)} – {toTimeLabel(detailAppt.scheduledEnd, tz)}
            </p>
            <p className="text-xs text-slate-500">Technician: {detailAppt.technicianName}</p>
          </div>
          <button
            onClick={() => navigate(`/appointments/${detailAppt.id}/edit`)}
            className="mt-4 w-full rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors"
          >
            Edit appointment
          </button>
        </div>
      </div>
    )}
    </div>
  );
}
