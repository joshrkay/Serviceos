import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { fetchAvailability, type AvailabilitySlot } from '../api/appointments';
import { useApiClient } from '../lib/useApiClient';
import { copyForError } from '../lib/errorCopy';
import { addDaysYmd, formatSlotDayLabel, formatSlotTimeRange } from '../lib/slotPicker';
import { tenantLocalDate } from '../lib/technicianDay';
import { SlotPicker } from './SlotPicker';

const BOOKING_HORIZON_DAYS = 14;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export interface RescheduleReviewPickerProps {
  payload: Record<string, unknown> | undefined;
  timezone?: string;
  /** Persist a picked slot onto the proposal (edit-before-approve). */
  onPick: (slot: AvailabilitySlot) => void | Promise<void>;
  saving?: boolean;
}

/**
 * B2 — on the review screen, a `reschedule_appointment` proposal swaps the
 * generic payload rows for this picker, preloaded with the AI's proposed slot
 * (payload.newScheduledStart/End) shown prominently. Picking a different open
 * slot edits the proposal in place (PUT /api/proposals/:id) so the operator can
 * adjust the time before approving — nothing executes until approval.
 */
export function RescheduleReviewPicker({ payload, timezone, onPick, saving }: RescheduleReviewPickerProps) {
  const api = useApiClient();
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proposedStart = asString(payload?.newScheduledStart);
  const proposedEnd = asString(payload?.newScheduledEnd);

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Search from the earlier of today and the proposed day so the proposed
      // slot's day is always inside the window.
      const today = tenantLocalDate(new Date(), timezone);
      const proposedDay = proposedStart ? tenantLocalDate(new Date(proposedStart), timezone) : today;
      const from = proposedDay < today ? proposedDay : today;
      const res = await fetchAvailability(api, { from, to: addDaysYmd(from, BOOKING_HORIZON_DAYS) });
      setSlots(res.slots);
    } catch (e) {
      setError(copyForError(e).body);
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [api, timezone, proposedStart]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  return (
    <View className="mt-5">
      {proposedStart && proposedEnd ? (
        <View className="mb-4 rounded-lg border border-primary bg-primary/10 p-4">
          <Text className="text-sm font-medium text-primary">Proposed new time</Text>
          <Text className="mt-1 text-base text-foreground">
            {formatSlotDayLabel(proposedStart, timezone)} ·{' '}
            {formatSlotTimeRange({ start: proposedStart, end: proposedEnd }, timezone)}
          </Text>
        </View>
      ) : null}

      <Text className="mb-2 text-base font-medium text-foreground">Adjust the time</Text>
      <Text className="mb-3 text-sm text-mutedForeground">
        Pick a different open slot to change the time before approving.
      </Text>
      {saving ? <Text className="mb-2 text-sm text-mutedForeground">Updating…</Text> : null}
      <SlotPicker
        slots={slots}
        timezone={timezone}
        selectedStart={proposedStart ?? null}
        onSelect={(slot) => void onPick(slot)}
        isLoading={loading}
        error={error}
        onRetry={() => void loadSlots()}
      />
    </View>
  );
}
