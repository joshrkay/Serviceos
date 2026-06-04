import { useEffect, useState, type FormEvent } from 'react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button, Field, Input, Select } from '../../../ui';
import type { BusinessHours } from '../../../../types/onboarding';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

const DAY_LABEL: Record<Day, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

interface IdentityStepProps {
  onSaved: () => void;
}

interface ValidationIssue {
  message: string;
  path?: (string | number)[];
}

const DEFAULT_HOURS: BusinessHours = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: null,
  sun: null,
};

function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

/** +15125551234 → (512) 555-1234 for the form's initial display. */
function formatPhoneForDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

const COMMON_TIMEZONES = [
  { value: 'America/New_York',    label: 'Eastern (New York)' },
  { value: 'America/Chicago',     label: 'Central (Chicago)' },
  { value: 'America/Denver',      label: 'Mountain (Denver)' },
  { value: 'America/Phoenix',     label: 'Mountain — no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage',   label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii (Honolulu)' },
];

export function IdentityStep({ onSaved }: IdentityStepProps) {
  const apiFetch = useApiClient();
  const [businessName, setBusinessName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [serviceAreaText, setServiceAreaText] = useState('');
  const [serviceAreaRadius, setServiceAreaRadius] = useState<number>(25);
  const [jobBufferMinutes, setJobBufferMinutes] = useState<number>(30);
  const [hourlyRateDollars, setHourlyRateDollars] = useState<number>(125);
  const [timezone, setTimezone] = useState<string>(detectBrowserTimezone);
  const [hours, setHours] = useState<BusinessHours>(DEFAULT_HOURS);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Pre-load any previously saved identity so re-editing doesn't wipe values.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch('/api/settings/');
        if (!res.ok) return;
        const body = (await res.json()) as {
          businessName?: string;
          serviceAreaText?: string | null;
          serviceAreaRadius?: number | null;
          businessHours?: BusinessHours;
          jobBufferMinutes?: number;
          hourlyRateCents?: number;
          timezone?: string;
          ownerPhone?: string | null;
        };
        if (!alive) return;
        if (body.businessName) setBusinessName(body.businessName);
        if (body.serviceAreaText != null) setServiceAreaText(body.serviceAreaText);
        if (typeof body.serviceAreaRadius === 'number') setServiceAreaRadius(body.serviceAreaRadius);
        if (body.businessHours && Object.keys(body.businessHours).length > 0) setHours(body.businessHours);
        if (typeof body.jobBufferMinutes === 'number') setJobBufferMinutes(body.jobBufferMinutes);
        if (typeof body.hourlyRateCents === 'number') setHourlyRateDollars(body.hourlyRateCents / 100);
        if (body.timezone) setTimezone(body.timezone);
        if (body.ownerPhone) setOwnerPhone(formatPhoneForDisplay(body.ownerPhone));
      } catch {
        // Silent — pre-load is best-effort.
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [apiFetch]);

  function toggleDay(day: Day, on: boolean) {
    setHours({ ...hours, [day]: on ? { open: '08:00', close: '17:00' } : null });
  }

  function setHourField(day: Day, field: 'open' | 'close', value: string) {
    const current = hours[day];
    if (!current) return;
    setHours({ ...hours, [day]: { ...current, [field]: value } });
  }

  const enabledDayCount = DAYS.filter((d) => !!hours[d]).length;
  const noDaysSelected = enabledDayCount === 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setIssues([]);
    if (noDaysSelected) {
      setIssues([{ message: 'Pick at least one business day so the AI knows when to book jobs.' }]);
      return;
    }
    setSubmitting(true);
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
          timezone,
          // Always send the trimmed value — empty string explicitly clears
          // a previously-saved owner phone (the route treats omitted as
          // "leave untouched"). Sending undefined would drop the key and
          // silently leave a stale number on file.
          ownerPhone: ownerPhone.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { issues?: ValidationIssue[]; message?: string };
        setIssues(body.issues ?? [{ message: body.message ?? `Save failed (HTTP ${res.status})` }]);
        return;
      }
      onSaved();
    } catch (err) {
      setIssues([{ message: err instanceof Error ? err.message : 'Network error. Check your connection and try again.' }]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-7 max-w-xl">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Tell us about your business</h1>
        <p className="text-sm text-slate-500 mt-2">
          This is what the AI uses to greet callers, draft quotes, and schedule jobs.
        </p>
      </header>

      <Field
        label="Business name"
        hint="What the AI says when it answers — &lsquo;Hi, this is M&amp;R Mechanical&apos;s office.&rsquo;"
        required
      >
        <Input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="M&R Mechanical"
          required
        />
      </Field>

      <Field
        label={<>Your cell phone <span className="text-slate-400 font-normal">(optional)</span></>}
        hint="So Rivet knows how to reach you about high-risk calls. Automatic patch-through to your cell is coming shortly — for now urgent callers are flagged in your inbox and the end-of-day digest."
      >
        <Input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={ownerPhone}
          onChange={(e) => setOwnerPhone(e.target.value)}
          placeholder="(512) 555-1234"
        />
      </Field>

      <Field
        label={<>Service area <span className="text-slate-400 font-normal">(optional)</span></>}
        hint="Where you work. Helps the AI quote travel time and decline jobs out of range."
      >
        <div className="flex gap-2 items-center">
          <Input
            value={serviceAreaText}
            onChange={(e) => setServiceAreaText(e.target.value)}
            placeholder="Phoenix, AZ"
            className="flex-1"
          />
          <Input
            type="number"
            min={1}
            max={500}
            value={serviceAreaRadius}
            onChange={(e) => setServiceAreaRadius(Number(e.target.value))}
            className="w-24"
            aria-label="Service area radius in miles"
          />
          <span className="text-sm text-slate-500 shrink-0">mi</span>
        </div>
      </Field>

      <Field
        label="Time zone"
        hint="So the AI books at the right local time and the end-of-day digest arrives in the evening."
      >
        <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {COMMON_TIMEZONES.find((tz) => tz.value === timezone) ? null : (
            <option value={timezone}>{timezone}</option>
          )}
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>{tz.label}</option>
          ))}
        </Select>
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-700">Business hours</legend>
        <p className="text-xs text-slate-500 -mt-1">
          When the AI books jobs and answers as &ldquo;open.&rdquo; Off-hours go to voicemail or emergency triage.
        </p>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
          {DAYS.map((day) => {
            const dayHours = hours[day];
            return (
              <div key={day} className="flex items-center gap-3">
                <label className="flex w-28 items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!dayHours}
                    onChange={(e) => toggleDay(day, e.target.checked)}
                    className="size-4 rounded border-slate-300"
                  />
                  {DAY_LABEL[day]}
                </label>
                {dayHours ? (
                  <>
                    <input
                      type="time"
                      value={dayHours.open}
                      onChange={(e) => setHourField(day, 'open', e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
                    />
                    <span className="text-slate-400">–</span>
                    <input
                      type="time"
                      value={dayHours.close}
                      onChange={(e) => setHourField(day, 'close', e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
                    />
                  </>
                ) : (
                  <span className="text-sm text-slate-400">closed</span>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <Field
        label="Travel buffer between jobs"
        hint="Drive time + setup. The AI keeps this gap when booking back-to-back."
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={240}
            value={jobBufferMinutes}
            onChange={(e) => setJobBufferMinutes(Number(e.target.value))}
            className="w-32"
          />
          <span className="text-sm text-slate-500">minutes</span>
        </div>
      </Field>

      <Field
        label="Hourly rate"
        hint="Used in quotes the AI drafts. You can override per estimate."
        required
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">$</span>
          <Input
            type="number"
            min={1}
            max={1000}
            step={1}
            value={hourlyRateDollars}
            onChange={(e) => setHourlyRateDollars(Number(e.target.value))}
            className="w-32"
          />
          <span className="text-sm text-slate-500">/ hour</span>
        </div>
      </Field>

      {issues.length > 0 && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3">
          <ul className="text-sm text-red-700 space-y-1">
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.path && issue.path.length > 0 ? <span className="font-medium">{issue.path.join('.')}: </span> : null}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={submitting}
        disabled={!loaded || submitting || noDaysSelected}
      >
        {submitting ? 'Saving…' : 'Save and continue'}
      </Button>
    </form>
  );
}
