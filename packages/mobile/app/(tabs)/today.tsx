import type { TechnicianDayAppointment } from '@ai-service-os/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import {
  listTechnicianAppointments,
  postEnRoute,
  postRunningLate,
} from '../../src/api/technicianField';
import { ErrorState } from '../../src/components/ErrorState';
import { useToast } from '../../src/components/Toast';
import { useMe } from '../../src/hooks/useMe';
import { useForegroundLocationTracker } from '../../src/location/useForegroundLocationTracker';
import { buildMapsUrl } from '../../src/lib/deviceLinks';
import {
  formatAppointmentWindow,
  pickActiveAppointment,
  technicianStatusLabel,
  tenantLocalDate,
} from '../../src/lib/technicianDay';
import { useApiClient } from '../../src/lib/useApiClient';
import { navModelFor } from '../../src/navigation/personaNav';

type AppointmentAction = 'en-route' | 'running-late';

function trackingCopy(
  status: ReturnType<typeof useForegroundLocationTracker>['status'],
  enabled: boolean,
  active: TechnicianDayAppointment | null,
): string {
  if (!enabled) return 'Location sharing is off in supervisor mode';
  if (!active) return 'Location sharing starts when you have a visit today';
  if (status === 'requesting') return 'Requesting location access…';
  if (status === 'tracking') {
    return `Sharing location for ${active.customerName || 'your next visit'}`;
  }
  if (status === 'paused') return 'Location paused while the app is in the background';
  if (status === 'denied') return 'Location off — enable access in Settings to share';
  if (status === 'error') return 'Location sharing unavailable — appointments still work';
  return `Location sharing ready for ${active.customerName || 'your next visit'}`;
}

function AppointmentCard({
  appointment,
  timezone,
  disabled,
  isNext,
  onAction,
  onOpenJob,
  onOpenMaps,
}: {
  appointment: TechnicianDayAppointment;
  timezone?: string;
  disabled: boolean;
  isNext: boolean;
  onAction: (action: AppointmentAction) => void;
  onOpenJob: () => void;
  onOpenMaps: (() => void) | null;
}) {
  return (
    <View
      className={`mb-4 w-full max-w-full rounded-xl border bg-card p-4 ${
        isNext ? 'border-primary' : 'border-border'
      }`}
    >
      <View className="min-w-0 flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          {isNext ? (
            <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">
              Next up
            </Text>
          ) : null}
          <Text className="font-heading text-lg font-semibold text-foreground">
            {appointment.customerName || 'Customer'}
          </Text>
          <Text className="mt-1 text-base font-medium text-foreground">
            {formatAppointmentWindow(
              appointment.scheduledStart,
              appointment.scheduledEnd,
              timezone,
            )}
          </Text>
        </View>
        <View className="shrink-0 rounded-full bg-secondary px-3 py-1">
          <Text className="text-xs font-medium text-secondaryForeground">
            {technicianStatusLabel(appointment.status)}
          </Text>
        </View>
      </View>

      <Text className="mt-3 text-sm text-mutedForeground">
        {appointment.locationAddress || 'Address unavailable'}
      </Text>
      {appointment.jobSummary ? (
        <Text className="mt-2 text-sm text-foreground">{appointment.jobSummary}</Text>
      ) : null}

      <View className="mt-4 w-full max-w-full flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`En route to ${appointment.customerName || 'customer'}`}
          disabled={disabled}
          onPress={() => onAction('en-route')}
          className={`min-h-11 min-w-0 flex-1 items-center justify-center rounded-md bg-primary px-2 py-3 ${
            disabled ? 'opacity-50' : ''
          }`}
        >
          <Text className="text-sm font-semibold text-primaryForeground">En route</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Running 20 minutes late to ${appointment.customerName || 'customer'}`}
          disabled={disabled}
          onPress={() => onAction('running-late')}
          className={`min-h-11 min-w-0 flex-1 items-center justify-center rounded-md bg-secondary px-2 py-3 ${
            disabled ? 'opacity-50' : ''
          }`}
        >
          <Text className="text-center text-sm font-semibold text-secondaryForeground">
            Running 20m late
          </Text>
        </Pressable>
      </View>

      <View className="mt-2 w-full max-w-full flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open job for ${appointment.customerName || 'customer'}`}
          disabled={disabled}
          onPress={onOpenJob}
          className={`min-h-11 min-w-0 flex-1 items-center justify-center rounded-md border border-border px-2 py-3 ${
            disabled ? 'opacity-50' : ''
          }`}
        >
          <Text className="text-sm font-semibold text-foreground">Open job</Text>
        </Pressable>
        {onOpenMaps ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open maps for ${appointment.customerName || 'customer'}`}
            disabled={disabled}
            onPress={onOpenMaps}
            className={`min-h-11 min-w-0 flex-1 items-center justify-center rounded-md border border-border px-2 py-3 ${
              disabled ? 'opacity-50' : ''
            }`}
          >
            <Text className="text-sm font-semibold text-foreground">Maps</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function Today() {
  const router = useRouter();
  const client = useApiClient();
  const { me, isLoading: meLoading, error: meError, refetch: refetchMe } = useMe();
  const { showToast, showErrorToast } = useToast();
  const [appointments, setAppointments] = useState<TechnicianDayAppointment[]>([]);
  const [dayLoading, setDayLoading] = useState(true);
  const [dayError, setDayError] = useState<Error | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [enRouteFocusId, setEnRouteFocusId] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);
  const requestVersionRef = useRef(0);

  const technicianId = me?.internal_user_id ?? null;
  const requestDate = tenantLocalDate(new Date(), me?.timezone);
  const nav = me
    ? navModelFor({
        role: me.role,
        currentMode: me.current_mode,
        canFieldServe: me.can_field_serve,
      })
    : null;
  const personaAllowsTracking = nav?.persona === 'tech' || nav?.persona === 'both';
  const activeAppointment = useMemo(() => {
    if (
      enRouteFocusId &&
      appointments.some((appointment) => appointment.id === enRouteFocusId)
    ) {
      const focused = appointments.find((appointment) => appointment.id === enRouteFocusId);
      if (focused && focused.status !== 'canceled' && focused.status !== 'completed' && focused.status !== 'no_show') {
        return focused;
      }
    }
    return pickActiveAppointment(appointments, Date.now());
  }, [appointments, enRouteFocusId]);
  const trackingEnabled = personaAllowsTracking && Boolean(activeAppointment);
  const location = useForegroundLocationTracker({
    enabled: trackingEnabled,
    technicianId,
    appointmentId: activeAppointment?.id,
  });

  const loadDay = useCallback(async () => {
    const version = ++requestVersionRef.current;
    if (!technicianId) {
      setAppointments([]);
      setDayError(null);
      setDayLoading(false);
      return;
    }
    setDayLoading(true);
    setDayError(null);
    try {
      const result = await listTechnicianAppointments(client, technicianId, requestDate);
      if (version !== requestVersionRef.current) return;
      setAppointments(result.appointments);
    } catch (caught) {
      if (version !== requestVersionRef.current) return;
      const failure = caught instanceof Error ? caught : new Error('Could not load today');
      if (failure.name !== 'AbortError') setDayError(failure);
    } finally {
      if (version === requestVersionRef.current) setDayLoading(false);
    }
  }, [client, requestDate, technicianId]);

  useEffect(() => {
    void loadDay();
  }, [loadDay]);

  const runAction = async (
    appointment: TechnicianDayAppointment,
    action: AppointmentAction,
  ): Promise<void> => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    const actionKey = `${appointment.id}:${action}`;
    setPendingAction(actionKey);
    try {
      if (action === 'en-route') {
        const result = await postEnRoute(client, appointment.id);
        setEnRouteFocusId(appointment.id);
        showToast({
          title: result.notified ? 'Customer notified' : 'Marked en route',
          body: result.notified
            ? 'They know you are on the way.'
            : 'No customer contact was available.',
          tone: 'info',
        });
      } else {
        await postRunningLate(client, appointment.id, 20);
        showToast({
          title: 'Delay sent',
          body: 'The customer was told you are running 20 minutes late.',
          tone: 'info',
        });
      }
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error('Action failed');
      showErrorToast(failure);
    } finally {
      actionInFlightRef.current = false;
      setPendingAction(null);
    }
  };

  const openMaps = async (appointment: TechnicianDayAppointment): Promise<void> => {
    const fallbackCoordinates =
      appointment.locationLatitude !== undefined &&
      appointment.locationLongitude !== undefined
        ? `${appointment.locationLatitude},${appointment.locationLongitude}`
        : '';
    const url = buildMapsUrl(
      appointment.locationAddress || fallbackCoordinates,
      Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    );
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error('Could not open maps');
      showErrorToast(failure);
    }
  };

  if (meLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (meError) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <ErrorState error={meError} onRetry={() => void refetchMe()} className="w-full" />
      </View>
    );
  }

  if (!technicianId) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <View className="w-full max-w-full rounded-xl border border-border bg-card p-5">
          <Text className="font-heading text-xl font-semibold text-foreground">
            No technician profile
          </Text>
          <Text className="mt-2 text-sm text-mutedForeground">
            Your signed-in account is not linked to an internal field profile yet.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="w-full max-w-full flex-1 bg-background"
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 72, paddingBottom: 96 }}
      refreshControl={
        <RefreshControl refreshing={dayLoading} onRefresh={() => void loadDay()} />
      }
    >
      <View className="w-full max-w-full">
        <Text className="font-heading text-3xl font-semibold text-foreground">Today</Text>
        <Text className="mt-1 text-base text-mutedForeground">
          {new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            ...(me?.timezone ? { timeZone: me.timezone } : {}),
          }).format(new Date())}
        </Text>

        <View className="mb-5 mt-4 w-full max-w-full rounded-lg bg-secondary px-4 py-3">
          <Text className="text-sm text-secondaryForeground">
            {trackingCopy(location.status, personaAllowsTracking, activeAppointment)}
          </Text>
        </View>

        {dayLoading ? (
          <View className="items-center py-12">
            <ActivityIndicator />
            <Text className="mt-3 text-sm text-mutedForeground">Loading today’s visits…</Text>
          </View>
        ) : dayError ? (
          <ErrorState error={dayError} onRetry={() => void loadDay()} className="w-full" />
        ) : appointments.length === 0 ? (
          <View className="w-full max-w-full rounded-xl border border-border bg-card p-5">
            <Text className="text-base font-medium text-foreground">
              No visits scheduled today.
            </Text>
            <Text className="mt-1 text-sm text-mutedForeground">
              Pull down to check for dispatch updates.
            </Text>
          </View>
        ) : (
          appointments.map((appointment) => {
            const coordinatesAvailable =
              appointment.locationLatitude !== undefined &&
              appointment.locationLongitude !== undefined;
            const mapsAvailable =
              Boolean(appointment.locationAddress.trim()) || coordinatesAvailable;
            return (
              <AppointmentCard
                key={appointment.id}
                appointment={appointment}
                timezone={me?.timezone}
                disabled={pendingAction !== null}
                isNext={activeAppointment?.id === appointment.id}
                onAction={(action) => void runAction(appointment, action)}
                onOpenJob={() => router.push(`/jobs/${appointment.jobId}`)}
                onOpenMaps={
                  mapsAvailable ? () => void openMaps(appointment) : null
                }
              />
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
