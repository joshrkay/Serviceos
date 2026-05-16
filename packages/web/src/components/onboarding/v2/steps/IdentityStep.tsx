import { useState, type FormEvent } from 'react';
import { useApiClient } from '../../../../lib/apiClient';
import type { BusinessHours } from '../../../../types/onboarding';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

interface IdentityStepProps {
  onSaved: () => void;
}

interface ValidationIssue {
  message: string;
  path?: (string | number)[];
}

export function IdentityStep({ onSaved }: IdentityStepProps) {
  const apiFetch = useApiClient();
  const [businessName, setBusinessName] = useState('');
  const [serviceAreaText, setServiceAreaText] = useState('');
  const [serviceAreaRadius, setServiceAreaRadius] = useState<number>(25);
  const [jobBufferMinutes, setJobBufferMinutes] = useState<number>(30);
  const [hourlyRateDollars, setHourlyRateDollars] = useState<number>(125);
  const [hours, setHours] = useState<BusinessHours>({
    mon: { open: '08:00', close: '17:00' },
    tue: { open: '08:00', close: '17:00' },
    wed: { open: '08:00', close: '17:00' },
    thu: { open: '08:00', close: '17:00' },
    fri: { open: '08:00', close: '17:00' },
    sat: null,
    sun: null,
  });
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function toggleDay(day: Day, on: boolean) {
    setHours({ ...hours, [day]: on ? { open: '08:00', close: '17:00' } : null });
  }

  function setHourField(day: Day, field: 'open' | 'close', value: string) {
    const current = hours[day];
    if (!current) return;
    setHours({ ...hours, [day]: { ...current, [field]: value } });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setIssues([]);
    try {
      const res = await apiFetch('/api/onboarding/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          serviceAreaText: serviceAreaText || undefined,
          serviceAreaRadius,
          businessHours: hours,
          jobBufferMinutes,
          hourlyRateCents: Math.round(hourlyRateDollars * 100),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { issues?: ValidationIssue[]; message?: string };
        setIssues(body.issues ?? [{ message: body.message ?? `HTTP ${res.status}` }]);
        return;
      }
      onSaved();
    } catch (err) {
      setIssues([{ message: err instanceof Error ? err.message : 'Network error' }]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-xl">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Tell us about your business</h1>
        <p className="text-sm text-slate-500 mt-1">
          This drives scheduling, pricing, and the AI agent's intro.
        </p>
      </header>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Business name</span>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          required
          className="mt-1 w-full border border-slate-300 rounded px-3 py-2"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Service area</span>
        <div className="flex gap-2 mt-1 items-center">
          <input
            value={serviceAreaText}
            onChange={(e) => setServiceAreaText(e.target.value)}
            placeholder="Austin, TX"
            className="flex-1 border border-slate-300 rounded px-3 py-2"
          />
          <input
            type="number"
            min={1}
            max={500}
            value={serviceAreaRadius}
            onChange={(e) => setServiceAreaRadius(Number(e.target.value))}
            className="w-24 border border-slate-300 rounded px-3 py-2"
          />
          <span className="text-sm text-slate-500">mi</span>
        </div>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Business hours</legend>
        {DAYS.map((day) => {
          const dayHours = hours[day];
          return (
            <div key={day} className="flex items-center gap-3">
              <label className="w-28 flex items-center gap-2 capitalize text-sm">
                <input
                  type="checkbox"
                  checked={!!dayHours}
                  onChange={(e) => toggleDay(day, e.target.checked)}
                />
                {day}
              </label>
              {dayHours && (
                <>
                  <input
                    type="time"
                    value={dayHours.open}
                    onChange={(e) => setHourField(day, 'open', e.target.value)}
                    className="border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="time"
                    value={dayHours.close}
                    onChange={(e) => setHourField(day, 'close', e.target.value)}
                    className="border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                </>
              )}
              {!dayHours && <span className="text-sm text-slate-400">closed</span>}
            </div>
          );
        })}
      </fieldset>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Job buffer (minutes between jobs)</span>
        <input
          type="number"
          min={0}
          max={240}
          value={jobBufferMinutes}
          onChange={(e) => setJobBufferMinutes(Number(e.target.value))}
          className="mt-1 w-32 border border-slate-300 rounded px-3 py-2"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Hourly rate (USD)</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={hourlyRateDollars}
          onChange={(e) => setHourlyRateDollars(Number(e.target.value))}
          className="mt-1 w-32 border border-slate-300 rounded px-3 py-2"
        />
      </label>

      {issues.length > 0 && (
        <ul className="text-red-600 text-sm space-y-1">
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.path && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
      >
        {submitting ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}
