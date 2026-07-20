import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  createAppointment,
  fetchAvailability,
  type AvailabilitySlot,
} from '../../src/api/appointments';
import { PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { JobPicker } from '../../src/components/JobPicker';
import { SavePhaseButton } from '../../src/components/SavePhaseButton';
import { ScreenShell } from '../../src/components/ScreenShell';
import { SlotPicker } from '../../src/components/SlotPicker';
import { useListQuery } from '../../src/hooks/useListQuery';
import { useMe } from '../../src/hooks/useMe';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { copyForError } from '../../src/lib/errorCopy';
import { addDaysYmd, formatSlotDayLabel, formatSlotTimeRange } from '../../src/lib/slotPicker';
import { tenantLocalDate } from '../../src/lib/technicianDay';
import { useApiClient } from '../../src/lib/useApiClient';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

/** Visit-length options (minutes) the booker can pick before searching slots. */
const DURATION_OPTIONS = [60, 90, 120] as const;
/** How far ahead manual booking searches for open slots. */
const BOOKING_HORIZON_DAYS = 14;

/**
 * B1 — manual booking. Mirrors the invoices/new.tsx step flow: customer → job →
 * slot → review. The slot step pulls open windows from GET
 * /api/dispatch/availability (tenant-tz), and Book calls the direct
 * POST /api/appointments route. No proposal — booking is a direct audited
 * mutation, like invoice issue.
 */
export default function NewAppointment() {
  const router = useRouter();
  const api = useApiClient();
  const { me } = useMe();
  const timezone = me?.timezone;
  const { data: customers } = useListQuery<Customer>('/api/customers');
  const { phase, error, run } = useSavePhase();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [customerId, setCustomerId] = useState('');
  const [jobId, setJobId] = useState('');
  const [durationMin, setDurationMin] = useState<number>(60);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AvailabilitySlot | null>(null);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );

  const loadSlots = useCallback(async () => {
    setSlotsLoading(true);
    setSlotsError(null);
    setSelected(null);
    try {
      const from = tenantLocalDate(new Date(), timezone);
      const res = await fetchAvailability(api, {
        from,
        to: addDaysYmd(from, BOOKING_HORIZON_DAYS),
        durationMin,
      });
      setSlots(res.slots);
    } catch (e) {
      setSlotsError(copyForError(e).body);
      setSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, [api, durationMin, timezone]);

  // Refetch whenever the slot step is active and the duration changes.
  useEffect(() => {
    if (step === 3) void loadSlots();
  }, [step, loadSlots]);

  const onBook = () => {
    if (!jobId || !selected || !timezone) return;
    void run(async () => {
      await createAppointment(api, {
        jobId,
        scheduledStart: selected.start,
        scheduledEnd: selected.end,
        timezone,
      });
      router.replace('/schedule');
    });
  };

  return (
    <ScreenShell title="Book appointment" backLabel="‹ Schedule">
      <Text className="mb-4 text-sm text-mutedForeground">Step {step} of 4</Text>

      {step === 1 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Pick a customer</Text>
          {customers.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              onPress={() => {
                if (c.id !== customerId) setJobId('');
                setCustomerId(c.id);
              }}
              className={`mb-2 min-h-11 rounded-md border px-4 py-3 ${
                customerId === c.id ? 'border-primary bg-primary/10' : 'border-border bg-card'
              }`}
            >
              <Text className="text-base text-foreground">{customerName(c)}</Text>
            </Pressable>
          ))}
          <PrimaryButton label="Next: job" onPress={() => setStep(2)} disabled={!customerId} className="mt-4" />
        </View>
      ) : null}

      {step === 2 ? (
        <View>
          <JobPicker customerId={customerId || null} selectedJobId={jobId} onSelect={setJobId} />
          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(1)} className="flex-1" />
            <PrimaryButton label="Next: time" onPress={() => setStep(3)} disabled={!jobId} className="flex-1" />
          </View>
        </View>
      ) : null}

      {step === 3 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Visit length</Text>
          <View className="mb-4 flex-row gap-2">
            {DURATION_OPTIONS.map((d) => (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityState={{ selected: durationMin === d }}
                onPress={() => setDurationMin(d)}
                className={`min-h-11 flex-1 items-center justify-center rounded-md border px-4 py-3 ${
                  durationMin === d ? 'border-primary bg-primary/10' : 'border-border bg-card'
                }`}
              >
                <Text className={`text-base ${durationMin === d ? 'font-semibold text-primary' : 'text-foreground'}`}>
                  {d} min
                </Text>
              </Pressable>
            ))}
          </View>

          <Text className="mb-2 text-base font-medium text-foreground">Pick a time</Text>
          <SlotPicker
            slots={slots}
            timezone={timezone}
            selectedStart={selected?.start ?? null}
            onSelect={setSelected}
            isLoading={slotsLoading}
            error={slotsError}
            onRetry={() => void loadSlots()}
          />

          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(2)} className="flex-1" />
            <PrimaryButton label="Review" onPress={() => setStep(4)} disabled={!selected} className="flex-1" />
          </View>
        </View>
      ) : null}

      {step === 4 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Review</Text>
          <Text className="text-base text-mutedForeground">
            Customer: {selectedCustomer ? customerName(selectedCustomer) : '—'}
          </Text>
          {selected ? (
            <Text className="mt-2 text-base text-foreground">
              {formatSlotDayLabel(selected.start, timezone)} · {formatSlotTimeRange(selected, timezone)}
            </Text>
          ) : null}
          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(3)} className="flex-1" />
            <View className="flex-1">
              <SavePhaseButton
                phase={phase}
                error={error}
                idleLabel="Book it"
                savingLabel="Booking…"
                savedLabel="Booked"
                onPress={onBook}
                disabled={!jobId || !selected || !timezone}
              />
            </View>
          </View>
        </View>
      ) : null}
    </ScreenShell>
  );
}
