/**
 * Customer self-service booking widget.
 *
 * Lets the customer describe what they need and pick an open slot within the
 * tenant's business hours (slot search lives in PortalSlotPicker). Bookings are
 * NOT instantly confirmed — the server creates a held appointment + a dispatcher
 * proposal, so the UI shows a "we'll confirm shortly" state on success.
 */
import { useState } from 'react';
import { portalApi, PortalSlot } from '../../api/portal';
import { PortalSlotPicker, SlotPickerOutcome } from './PortalSlotPicker';

export function PortalBookAppointment({ token }: { token: string }) {
  const [summary, setSummary] = useState('');
  const [confirmation, setConfirmation] = useState<string | null>(null);

  async function book(slot: PortalSlot): Promise<SlotPickerOutcome | void> {
    if (!summary.trim()) {
      return { message: 'Please describe what you need help with.' };
    }
    const result = await portalApi.book(token, {
      slotStart: slot.start,
      slotEnd: slot.end,
      summary: summary.trim(),
    });
    if (result.ok) {
      setConfirmation(result.message);
      return;
    }
    if (result.slotTaken) {
      return { message: result.message, replaceSlots: result.alternatives };
    }
    return { message: result.message };
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

      <PortalSlotPicker token={token} confirmLabel="Request {time}" onConfirm={book} />
    </div>
  );
}
