/**
 * Customer self-service booking widget.
 *
 * Fetches open slots within the tenant's business hours, lets the customer
 * pick one, and submits a booking request. Bookings are NOT instantly
 * confirmed — the server creates a held appointment + a dispatcher proposal,
 * so the UI shows a "we'll confirm shortly" state on success.
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

function formatSlot(slot: PortalSlot, timezone: string): string {
  const start = new Date(slot.start);
  return start.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  });
}

export function PortalBookAppointment({ token }: { token: string }) {
  const today = new Date();
  const [from, setFrom] = useState(toDateInput(today));
  const [to, setTo] = useState(toDateInput(addDays(today, 7)));
  const [summary, setSummary] = useState('');
  const [slots, setSlots] = useState<PortalSlot[]>([]);
  const [timezone, setTimezone] = useState('');
  const [selected, setSelected] = useState<PortalSlot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  async function loadSlots(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSelected(null);
    setLoadingSlots(true);
    try {
      const res = await portalApi.availability(token, { from, to, durationMin: 60 });
      setSlots(res.slots);
      setTimezone(res.timezone);
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingSlots(false);
    }
  }

  async function confirmBooking() {
    if (!selected) return;
    if (!summary.trim()) {
      setError('Please describe what you need help with.');
      return;
    }
    setError(null);
    setBooking(true);
    try {
      const result = await portalApi.book(token, {
        slotStart: selected.start,
        slotEnd: selected.end,
        summary: summary.trim(),
      });
      if (result.ok) {
        setConfirmation(result.message);
      } else if (result.slotTaken) {
        setError(result.message);
        setSlots(result.alternatives);
        setSelected(null);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBooking(false);
    }
  }

  if (confirmation) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
        <div className="text-lg font-semibold text-emerald-900">Request received</div>
        <div className="mt-2 text-sm text-emerald-800">{confirmation}</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-4">
      <div>
        <label htmlFor="book-summary" className="block text-sm font-medium text-slate-700">
          What do you need help with?
        </label>
        <textarea
          id="book-summary"
          rows={2}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          placeholder="e.g. Annual furnace tune-up"
        />
      </div>

      <form onSubmit={loadSlots} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div>
          <label htmlFor="book-from" className="block text-sm font-medium text-slate-700">From</label>
          <input
            id="book-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="book-to" className="block text-sm font-medium text-slate-700">To</label>
          <input
            id="book-to"
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
          onClick={() => void confirmBooking()}
          disabled={booking}
          className="w-full sm:w-auto rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm"
        >
          {booking ? 'Requesting…' : `Request ${formatSlot(selected, timezone)}`}
        </button>
      ) : null}
    </div>
  );
}
