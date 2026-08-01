import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import {
  addCrewMember,
  cancelAppointment,
  confirmAppointment,
  createRescheduleProposal,
  createReassignProposal,
  fetchAvailability,
  removeCrewMember,
  type AvailabilitySlot,
} from '../api/appointments';
import { useListQuery } from '../hooks/useListQuery';
import { useApiClient } from '../lib/useApiClient';
import { copyForError } from '../lib/errorCopy';
import { addDaysYmd } from '../lib/slotPicker';
import { tenantLocalDate } from '../lib/technicianDay';
import { SlotPicker } from './SlotPicker';

export interface ActionableAppointment {
  id: string;
  /** Optimistic-concurrency token = the appointment's `updatedAt` ISO. */
  updatedAt?: string;
  scheduledStart?: string;
  status?: string;
}

interface TeamUser {
  id: string;
  role: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

function userName(u: TeamUser): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
}

export interface AppointmentActionSheetProps {
  visible: boolean;
  appointment: ActionableAppointment | null;
  timezone?: string;
  onClose: () => void;
  /** Called after a successful action so the caller can refetch the schedule. */
  onDone: () => void;
}

type Mode = 'menu' | 'reschedule' | 'reassign' | 'addCrew' | 'removeCrew' | 'cancel';
/** Modes whose confirm mints a scheduling proposal that needs a tech pick. */
type CrewMode = 'reassign' | 'addCrew' | 'removeCrew';

const BOOKING_HORIZON_DAYS = 14;

/**
 * B3/B4/B5 — the per-appointment action surface reached from the schedule list.
 * Confirm (B4) and Cancel (B3) are DIRECT audited status changes; Reschedule
 * (B2), Reassign / Add crew / Remove crew (B5) mint scheduling proposals that
 * land in Approvals (they never auto-execute). Cancel uses the U1 irreversible
 * destructive confirm treatment because `canceled` is a terminal state.
 */
export function AppointmentActionSheet({
  visible,
  appointment,
  timezone,
  onClose,
  onDone,
}: AppointmentActionSheetProps) {
  const api = useApiClient();
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reschedule slot state.
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);

  // Crew/reassign tech pick.
  const [selectedTechId, setSelectedTechId] = useState<string | null>(null);
  const { data: users } = useListQuery<TeamUser>('/api/users', { enabled: visible });
  const technicians = useMemo(() => users.filter((u) => u.role === 'technician'), [users]);

  const version = appointment?.updatedAt ?? '';
  const isScheduled = appointment?.status === 'scheduled';

  // Reset to the menu each time the sheet re-opens for a fresh appointment.
  useEffect(() => {
    if (visible) {
      setMode('menu');
      setActionError(null);
      setSelectedSlot(null);
      setSelectedTechId(null);
    }
  }, [visible, appointment?.id]);

  const loadSlots = useCallback(async () => {
    setSlotsLoading(true);
    setSlotsError(null);
    setSelectedSlot(null);
    try {
      const from = tenantLocalDate(new Date(), timezone);
      const res = await fetchAvailability(api, { from, to: addDaysYmd(from, BOOKING_HORIZON_DAYS) });
      setSlots(res.slots);
    } catch (e) {
      setSlotsError(copyForError(e).body);
      setSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, [api, timezone]);

  useEffect(() => {
    if (mode === 'reschedule') void loadSlots();
  }, [mode, loadSlots]);

  async function runAction(fn: () => Promise<void>) {
    if (!appointment || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      onDone();
      onClose();
    } catch (e) {
      setActionError(copyForError(e).body);
    } finally {
      setBusy(false);
    }
  }

  const crewLabel: Record<CrewMode, string> = {
    reassign: 'Reassign to',
    addCrew: 'Add to crew',
    removeCrew: 'Remove from crew',
  };

  function submitCrew(m: CrewMode) {
    if (!appointment || !selectedTechId) return;
    void runAction(async () => {
      if (m === 'reassign') {
        await createReassignProposal(api, {
          appointmentId: appointment.id,
          toTechnicianId: selectedTechId,
          appointmentVersion: version,
        });
      } else if (m === 'addCrew') {
        await addCrewMember(api, {
          appointmentId: appointment.id,
          technicianId: selectedTechId,
          appointmentVersion: version,
        });
      } else {
        await removeCrewMember(api, {
          appointmentId: appointment.id,
          technicianId: selectedTechId,
          appointmentVersion: version,
        });
      }
    });
  }

  const missingVersion = !version;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-background pt-16">
        <View className="flex-row items-center justify-between px-6">
          <Text className="font-heading text-xl font-semibold text-foreground">Appointment</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-base text-mutedForeground">Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 24 }}>
          {actionError ? <Text className="mb-3 text-base text-destructive">{actionError}</Text> : null}
          {missingVersion ? (
            <Text className="mb-3 text-sm text-mutedForeground">
              Reschedule and crew changes need the latest appointment data — pull to refresh the
              schedule and try again.
            </Text>
          ) : null}

          {mode === 'menu' ? (
            <View className="gap-3">
              {isScheduled ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm appointment"
                  disabled={busy}
                  onPress={() =>
                    appointment && void runAction(() => confirmAppointment(api, appointment.id))
                  }
                  className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                >
                  <Text className="text-base font-semibold text-primaryForeground">Confirm appointment</Text>
                </Pressable>
              ) : null}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reschedule"
                disabled={busy || missingVersion}
                onPress={() => setMode('reschedule')}
                className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base font-semibold text-foreground">Reschedule…</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reassign technician"
                disabled={busy || missingVersion}
                onPress={() => setMode('reassign')}
                className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base font-semibold text-foreground">Reassign technician…</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add crew member"
                disabled={busy || missingVersion}
                onPress={() => setMode('addCrew')}
                className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base font-semibold text-foreground">Add crew member…</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove crew member"
                disabled={busy || missingVersion}
                onPress={() => setMode('removeCrew')}
                className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base font-semibold text-foreground">Remove crew member…</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel appointment"
                disabled={busy}
                onPress={() => setMode('cancel')}
                className="min-h-11 items-center justify-center rounded-md border border-destructive px-4 py-3"
              >
                <Text className="text-base font-semibold text-destructive">Cancel appointment…</Text>
              </Pressable>
            </View>
          ) : null}

          {mode === 'reschedule' ? (
            <View>
              <Text className="mb-3 text-base text-mutedForeground">
                Pick a new time. This lands in Approvals for you to confirm.
              </Text>
              <SlotPicker
                slots={slots}
                timezone={timezone}
                selectedStart={selectedSlot?.start ?? null}
                onSelect={setSelectedSlot}
                isLoading={slotsLoading}
                error={slotsError}
                onRetry={() => void loadSlots()}
              />
              <View className="mt-4 flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={() => setMode('menu')}
                  className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">Back</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send reschedule"
                  disabled={busy || !selectedSlot || missingVersion}
                  onPress={() =>
                    appointment &&
                    selectedSlot &&
                    void runAction(() =>
                      createRescheduleProposal(api, {
                        appointmentId: appointment.id,
                        newScheduledStart: selectedSlot.start,
                        newScheduledEnd: selectedSlot.end,
                        appointmentVersion: version,
                      }).then(() => undefined),
                    )
                  }
                  className={`min-h-11 flex-1 items-center justify-center rounded-md px-4 py-3 ${
                    !selectedSlot || missingVersion ? 'bg-primary/40' : 'bg-primary'
                  }`}
                >
                  {busy ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-primaryForeground">Send reschedule</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}

          {mode === 'reassign' || mode === 'addCrew' || mode === 'removeCrew' ? (
            <View>
              <Text className="mb-3 text-base font-medium text-foreground">{crewLabel[mode]}</Text>
              <Text className="mb-3 text-sm text-mutedForeground">
                This lands in Approvals for you to confirm.
              </Text>
              {technicians.length === 0 ? (
                <Text className="text-base text-mutedForeground">No technicians on your team yet.</Text>
              ) : null}
              {technicians.map((t) => {
                const selected = selectedTechId === t.id;
                return (
                  <Pressable
                    key={t.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setSelectedTechId(t.id)}
                    className={`mb-2 min-h-11 justify-center rounded-md border px-4 py-3 ${
                      selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
                    }`}
                  >
                    <Text className={`text-base ${selected ? 'font-semibold text-primary' : 'text-foreground'}`}>
                      {userName(t)}
                    </Text>
                  </Pressable>
                );
              })}
              <View className="mt-4 flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={() => setMode('menu')}
                  className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">Back</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send change"
                  disabled={busy || !selectedTechId || missingVersion}
                  onPress={() => submitCrew(mode)}
                  className={`min-h-11 flex-1 items-center justify-center rounded-md px-4 py-3 ${
                    !selectedTechId || missingVersion ? 'bg-primary/40' : 'bg-primary'
                  }`}
                >
                  {busy ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-primaryForeground">Send change</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}

          {mode === 'cancel' ? (
            <View className="rounded-lg border border-destructive bg-card p-4">
              <Text className="text-base font-medium text-foreground">
                Cancel this appointment — this can&apos;t be undone.
              </Text>
              <Text className="mt-2 text-base text-mutedForeground">
                The visit is removed from the schedule. Re-booking means creating a new appointment.
              </Text>
              <View className="mt-3 flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Keep appointment"
                  disabled={busy}
                  onPress={() => setMode('menu')}
                  className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">Keep it</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Yes, cancel appointment"
                  disabled={busy}
                  onPress={() =>
                    appointment && void runAction(() => cancelAppointment(api, appointment.id))
                  }
                  className="min-h-11 flex-1 items-center justify-center rounded-md bg-destructive px-4 py-3"
                >
                  {busy ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-destructiveForeground">Yes, cancel it</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
