/**
 * P10-001 — Reusable availability slot picker for the customer portal.
 *
 * Owns the from/to date range, fetches open slots within the tenant's
 * business hours via `portalApi.availability`, renders the slot grid, and
 * tracks the selected slot. The parent decides what "confirm" means by
 * passing `onConfirm(slot)` + a `confirmLabel` — booking and reschedule both
 * reuse this so the availability UI lives in exactly one place.
 */
import { FormEvent, useState } from 'react';
import { portalApi, PortalSlot } from '../../api/portal';

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Cache formatters by timezone so the slot grid doesn't build a new
// Intl.DateTimeFormat for every slot it renders.
const slotFormatters = new Map<string, Intl.DateTimeFormat>();

function slotFormatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone || 'local';
  let formatter = slotFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || undefined,
    });
    slotFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatSlot(slot: PortalSlot, timezone: string): string {
  return slotFormatter(timezone).format(new Date(slot.start));
}

/**
 * What `onConfirm` can hand back so the picker can react in place — used by
 * booking to surface a "that time was just taken" notice and swap the grid
 * for the alternative slots the server returned.
 */
export interface SlotPickerOutcome {
  /** Inline message to show under the grid (e.g. a validation/conflict error). */
  message?: string;
  /** Replace the visible slots (e.g. with server-suggested alternatives). */
  replaceSlots?: PortalSlot[];
}

export interface PortalSlotPickerProps {
  token: string;
  /** Label for the confirm button. `{time}` is replaced with the picked slot. */
  confirmLabel: string;
  /**
   * Called when the customer confirms a slot. Return a {@link SlotPickerOutcome}
   * to show a message / swap slots in place, or nothing on plain success.
   * Throwing surfaces the error message inline.
   */
  onConfirm: (slot: PortalSlot) => Promise<SlotPickerOutcome | void> | SlotPickerOutcome | void;
  /** Slot length in minutes (defaults to 60). */
  durationMin?: number;
}

export function PortalSlotPicker({
  token,
  confirmLabel,
  onConfirm,
  durationMin = 60,
}: PortalSlotPickerProps) {
  const today = new Date();
  const [from, setFrom] = useState(toDateInput(today));
  const [to, setTo] = useState(toDateInput(addDays(today, 7)));
  const [slots, setSlots] = useState<PortalSlot[]>([]);
  const [timezone, setTimezone] = useState('');
  const [selected, setSelected] = useState<PortalSlot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function loadSlots(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSelected(null);
    setLoadingSlots(true);
    try {
      const res = await portalApi.availability(token, { from, to, durationMin });
      setSlots(res.slots);
      setTimezone(res.timezone);
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingSlots(false);
    }
  }

  async function confirm() {
    if (!selected) return;
    setError(null);
    setConfirming(true);
    try {
      const outcome = await onConfirm(selected);
      if (outcome?.replaceSlots) {
        setSlots(outcome.replaceSlots);
        setSelected(null);
      }
      if (outcome?.message) setError(outcome.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={loadSlots} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div>
          <label htmlFor="slot-from" className="block text-sm font-medium text-slate-700">From</label>
          <input
            id="slot-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="slot-to" className="block text-sm font-medium text-slate-700">To</label>
          <input
            id="slot-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={loadingSlots}
          className="rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm"
        >
          {loadingSlots ? 'Finding times…' : 'Find times'}
        </button>
      </form>

      {searched && slots.length === 0 && !loadingSlots ? (
        <div className="text-sm text-slate-600">
          No open times in that range. Try a wider date range, or use “Request service” and we’ll reach out.
        </div>
      ) : null}

      {slots.length > 0 ? (
        <div>
          <div className="text-sm font-medium text-slate-700 mb-2">Available times</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {slots.map((slot) => {
              const isSelected = selected?.start === slot.start;
              return (
                <button
                  key={slot.start}
                  type="button"
                  onClick={() => setSelected(slot)}
                  className={
                    'rounded-lg border px-3 py-2 text-sm ' +
                    (isSelected
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 text-slate-700 hover:border-slate-500')
                  }
                >
                  {formatSlot(slot, timezone)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? <div className="text-sm text-rose-600">{error}</div> : null}

      {selected ? (
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={confirming}
          className="w-full sm:w-auto rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm"
        >
          {confirming
            ? 'Requesting…'
            : confirmLabel.replace('{time}', formatSlot(selected, timezone))}
        </button>
      ) : null}
    </div>
  );
}
