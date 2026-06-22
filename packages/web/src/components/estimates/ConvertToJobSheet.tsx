import { useState } from 'react';
import { X, Check, CalendarClock, Briefcase } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { useTechnicianRoster } from '../../hooks/useTechnicianRoster';
import { Button } from '../ui';

export interface ConvertToJobInput {
  estimateId: string;
  estimateNumber: string;
  customerName: string;
  description?: string;
}

/**
 * Schedules + assigns the job an estimate belongs to (estimates are job-first,
 * so this reuses the estimate's existing job) and flips the estimate to
 * accepted — the UI affordance for POST /api/jobs/from-estimate/:estimateId.
 *
 * Auto-scheduling (the default) asks the backend to pick the first technician
 * with an open slot. When no slot is free the backend 409s with a message that
 * asks for an explicit technician + start, so the sheet exposes an optional
 * override (technician dropdown + datetime) to complete the conversion.
 */
export function ConvertToJobSheet({
  input,
  onClose,
  onConverted,
}: {
  input: ConvertToJobInput;
  onClose: () => void;
  onConverted: (jobId: string) => void;
}) {
  const { technicians } = useTechnicianRoster();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [technicianId, setTechnicianId] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');

  async function convert() {
    setLoading(true);
    setError(null);
    try {
      // Body is optional: with no override the backend auto-picks the first
      // technician + open slot. An override pins both. A datetime-local value
      // has no timezone, so send it as a UTC ISO instant the API can parse.
      const body: { technicianId?: string; scheduledStart?: string } = {};
      if (technicianId) body.technicianId = technicianId;
      if (scheduledStart) body.scheduledStart = new Date(scheduledStart).toISOString();

      const res = await apiFetch(`/api/jobs/from-estimate/${input.estimateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg =
          typeof errBody?.message === 'string'
            ? errBody.message
            : `Could not schedule job (HTTP ${res.status})`;
        throw new Error(msg);
      }
      const result = (await res.json()) as { job: { id: string } };
      setDone(true);
      setTimeout(() => {
        onConverted(result.job.id);
        onClose();
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule job');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl shadow-2xl overflow-y-auto max-h-[85vh]"
        style={{ animation: 'slideUp 0.25s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 rounded-full bg-slate-200" />
        </div>

        <div className="px-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-slate-900" style={{ fontSize: '1rem' }}>Convert to job</p>
              <p className="text-xs text-slate-400 mt-0.5">Schedule {input.estimateNumber}</p>
            </div>
            <Button
              onClick={onClose}
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Close"
              className="size-7 rounded-full p-0"
            >
              <X size={15} />
            </Button>
          </div>

          {done ? (
            <div className="flex flex-col items-center py-10 gap-3" style={{ animation: 'fadeUp 0.2s ease' }}>
              <div className="flex size-14 items-center justify-center rounded-full bg-green-100">
                <Check size={24} className="text-green-600" />
              </div>
              <p className="text-slate-800">Job scheduled</p>
              <p className="text-xs text-slate-400">
                Accepting estimate for {input.customerName.split(' ')[0]}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-4 mb-4">
                <div className="flex items-start gap-3">
                  <Briefcase size={14} className="text-slate-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">{input.customerName}</p>
                    {input.description && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{input.description}</p>
                    )}
                    <p className="text-xs text-slate-400 mt-1.5">
                      Accepting this estimate schedules its job and assigns a technician.
                    </p>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowOverride((v) => !v)}
                className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left hover:bg-slate-50 transition-colors mb-3 min-h-11"
              >
                <CalendarClock size={14} className="text-slate-400 shrink-0" />
                <span className="text-sm text-slate-700 flex-1">
                  {showOverride ? 'Auto-schedule' : 'Pick technician & time'}
                </span>
                <span className="text-xs text-slate-400">{showOverride ? 'Hide' : 'Optional'}</span>
              </button>

              {showOverride && (
                <div className="rounded-xl border border-slate-200 px-4 py-4 mb-4 flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500">Technician</span>
                    <select
                      value={technicianId}
                      onChange={(e) => setTechnicianId(e.target.value)}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm min-h-11"
                    >
                      <option value="">Auto-assign</option>
                      {technicians.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500">Start time</span>
                    <input
                      type="datetime-local"
                      value={scheduledStart}
                      onChange={(e) => setScheduledStart(e.target.value)}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm min-h-11"
                    />
                  </label>
                </div>
              )}

              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

              <Button
                onClick={() => void convert()}
                loading={loading}
                type="button"
                size="lg"
                fullWidth
                leftIcon={<Briefcase size={14} />}
              >
                {loading ? 'Scheduling…' : 'Convert to job'}
              </Button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}
