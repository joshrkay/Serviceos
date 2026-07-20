import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { createAppointment, fetchAvailability } from '../../src/api/appointments';
import { PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { ErrorState } from '../../src/components/ErrorState';
import { JobPicker } from '../../src/components/JobPicker';
import { SavePhaseButton } from '../../src/components/SavePhaseButton';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useListQuery } from '../../src/hooks/useListQuery';
import { useMe } from '../../src/hooks/useMe';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';
import { addDaysToDate, groupSlotsByDay, slotDayKey, type Slot } from '../../src/scheduling/slots';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const BOOKING_WINDOW_DAYS = 14;

export default function BookAppointment() {
  const router = useRouter();
  const api = useApiClient();
  const { me } = useMe();
  const params = useLocalSearchParams<{ customerId?: string; jobId?: string }>();
  const preCustomerId = firstParam(params.customerId) ?? '';
  const preJobId = firstParam(params.jobId) ?? '';

  const { data: customers } = useListQuery<Customer>('/api/customers');
  const { phase, error: saveError, run } = useSavePhase();

  const [step, setStep] = useState<1 | 2 | 3>(preJobId ? 3 : preCustomerId ? 2 : 1);
  const [customerId, setCustomerId] = useState(preCustomerId);
  const [jobId, setJobId] = useState(preJobId);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Slot | null>(null);

  const tenantId = me?.tenant_id ?? '';

  const loadSlots = useCallback(async () => {
    if (!tenantId) return;
    setLoadingSlots(true);
    setSlotsError(null);
    setSelected(null);
    try {
      // "Today" in the tenant zone — the booking window is business-local.
      const from = slotDayKey(new Date().toISOString(), me?.timezone);
      const to = addDaysToDate(from, BOOKING_WINDOW_DAYS);
      const res = await fetchAvailability(api, tenantId, { from, to });
      setSlots(res.slots);
      setTimezone(res.timezone);
    } catch (e) {
      setSlotsError(e instanceof Error ? e.message : 'Could not load availability');
    } finally {
      setLoadingSlots(false);
    }
  }, [api, tenantId, me?.timezone]);

  useEffect(() => {
    if (step === 3 && tenantId) void loadSlots();
  }, [step, tenantId, loadSlots]);

  const days = useMemo(() => groupSlotsByDay(slots, timezone ?? me?.timezone), [slots, timezone, me?.timezone]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );

  const book = () => {
    if (!jobId || !selected || !timezone) return;
    void run(async () => {
      try {
        await createAppointment(api, {
          jobId,
          scheduledStart: selected.start,
          scheduledEnd: selected.end,
          timezone,
        });
        router.replace('/schedule');
      } catch (e) {
        // A slot can be taken between load and submit — the server's 409 is the
        // source of truth. Refresh the open slots so the operator re-picks, and
        // rethrow so the save phase surfaces the reason under the button.
        await loadSlots();
        throw e instanceof Error ? e : new Error('Booking failed');
      }
    });
  };

  return (
    <ScreenShell title="Book a visit" backLabel="‹ Schedule">
      <Text className="mb-4 text-sm text-mutedForeground">Step {step} of 3</Text>

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
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-base font-medium text-foreground">Pick a time</Text>
            {selectedCustomer ? (
              <Text className="text-sm text-mutedForeground">{customerName(selectedCustomer)}</Text>
            ) : null}
          </View>

          {loadingSlots ? <ActivityIndicator /> : null}
          {slotsError ? (
            <ErrorState error={slotsError} showRetry onRetry={() => void loadSlots()} className="mb-4" />
          ) : null}

          {!loadingSlots && !slotsError && days.length === 0 ? (
            <Text className="text-base text-mutedForeground">
              No open slots in the next {BOOKING_WINDOW_DAYS} days. Adjust your working hours in
              settings, or free up the calendar.
            </Text>
          ) : null}

          {days.map((day) => (
            <View key={day.dayKey} className="mb-4">
              <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
                {day.heading}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {day.slots.map((slot) => {
                  const active = selected?.start === slot.start;
                  return (
                    <Pressable
                      key={slot.start}
                      accessibilityRole="button"
                      accessibilityLabel={`${day.heading} at ${slot.label}`}
                      onPress={() => setSelected(slot)}
                      className={`min-h-11 items-center justify-center rounded-md border px-4 py-3 ${
                        active ? 'border-primary bg-primary/10' : 'border-border bg-card'
                      }`}
                    >
                      <Text className="text-base text-foreground">{slot.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

          <View className="mt-4 flex-row gap-2">
            {!preJobId ? (
              <SecondaryButton label="Back" onPress={() => setStep(2)} className="flex-1" />
            ) : null}
            <View className="flex-1">
              <SavePhaseButton
                phase={phase}
                error={saveError}
                idleLabel="Book visit"
                savingLabel="Booking…"
                savedLabel="Booked"
                onPress={book}
                disabled={!selected || !timezone}
              />
            </View>
          </View>
        </View>
      ) : null}
    </ScreenShell>
  );
}
