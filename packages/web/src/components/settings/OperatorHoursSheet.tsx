import { useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { toast } from 'sonner';
import type { BusinessHours } from '../../types/onboarding';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

const DAY_LABELS: Record<Day, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OperatorHoursSheet({ open, onOpenChange }: Props) {
  const [hours, setHours] = useState<BusinessHours>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/onboarding/operator-hours');
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { businessHours?: BusinessHours };
        if (!cancelled && data.businessHours) {
          setHours(data.businessHours);
        }
      } catch {
        /* defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleDay(day: Day, on: boolean) {
    setHours({ ...hours, [day]: on ? { open: '08:00', close: '17:00' } : null });
  }

  function setHourField(day: Day, field: 'open' | 'close', value: string) {
    const current = hours[day];
    if (!current) return;
    setHours({ ...hours, [day]: { ...current, [field]: value } });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch('/api/onboarding/operator-hours', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessHours: hours }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Operator hours saved');
      onOpenChange(false);
    } catch {
      toast.error('Could not save operator hours');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900 mb-1">Operator hours</h2>
        <p className="text-sm text-slate-500 mb-6">
          When you are closed, inbound calls follow after-hours routing (Call routing &amp; handoff).
        </p>
        <div className="space-y-3 mb-6">
          {DAYS.map((day) => {
            const slot = hours[day];
            const isOpen = slot !== null && slot !== undefined;
            return (
              <div key={day} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
                <label className="flex items-center gap-2 w-28 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={isOpen}
                    onChange={(e) => toggleDay(day, e.target.checked)}
                  />
                  {DAY_LABELS[day]}
                </label>
                {isOpen && slot && (
                  <>
                    <input
                      type="time"
                      value={slot.open}
                      onChange={(e) => setHourField(day, 'open', e.target.value)}
                      className="border border-slate-200 rounded px-2 py-1 text-sm"
                    />
                    <span className="text-slate-400 text-sm">to</span>
                    <input
                      type="time"
                      value={slot.close}
                      onChange={(e) => setHourField(day, 'close', e.target.value)}
                      className="border border-slate-200 rounded px-2 py-1 text-sm"
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="w-full rounded-lg bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save hours'}
        </button>
      </div>
    </div>
  );
}