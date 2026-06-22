import { useCallback, useEffect, useRef, useState } from 'react';
import { NOTIFICATION_TYPES, type NotificationType } from '@ai-service-os/shared';
import { useApiClient } from '../lib/useApiClient';
import { decodeError, type AppError } from '../lib/appError';

export type PreferenceMap = Record<NotificationType, boolean>;

/** Owner-facing labels for each push category (U10 settings toggles). */
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  proposal_needs_approval: 'Approvals needed',
  proposal_executed: 'Actions completed',
  incoming_call: 'Incoming calls',
  inbound_sms: 'New texts',
  appointment_reminder: 'Appointment reminders',
  appointment_cancellation: 'Cancellations',
  payment_received: 'Payments received',
  invoice_overdue: 'Overdue invoices',
  lead_captured: 'New leads',
  escalation: 'Escalations',
  emergency: 'Emergencies',
};

function allEnabled(): PreferenceMap {
  const map = {} as PreferenceMap;
  for (const t of NOTIFICATION_TYPES) map[t] = true;
  return map;
}

/** Decode once; swallow the sign-out abort (the api client owns that redirect). */
async function decode(err: unknown): Promise<AppError | null> {
  try {
    return await decodeError(err);
  } catch {
    return null; // sign-out abort re-thrown by decodeError
  }
}

export interface NotificationPreferencesResult {
  preferences: PreferenceMap;
  isLoading: boolean;
  error: string | null;
  /** Toggle one category; optimistic, reverts on failure. */
  setPreference: (type: NotificationType, enabled: boolean) => Promise<void>;
  reload: () => void;
}

/**
 * GET/PUT /api/notification-preferences — the owner's per-category push mutes
 * (U10). Default-on: until the server says otherwise every category is enabled,
 * so the UI renders immediately without a flash of "off". Toggles are
 * optimistic and revert on failure (surfacing the backend's decoded message).
 */
export function useNotificationPreferences(): NotificationPreferencesResult {
  const api = useApiClient();
  const [preferences, setPreferences] = useState<PreferenceMap>(allEnabled);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const load = useCallback(async () => {
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api('/api/notification-preferences');
      if (myVersion !== versionRef.current) return;
      if (!res.ok) {
        const decoded = await decode(res);
        if (decoded && decoded.kind !== 'unauthorized') setError(decoded.message);
        return;
      }
      const body = (await res.json()) as { preferences?: Partial<PreferenceMap> };
      if (myVersion !== versionRef.current) return;
      setPreferences({ ...allEnabled(), ...(body.preferences ?? {}) });
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      const decoded = await decode(err);
      if (decoded && decoded.kind !== 'unauthorized') setError(decoded.message);
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const setPreference = useCallback(
    async (type: NotificationType, enabled: boolean) => {
      const prev = preferences[type];
      setPreferences((p) => ({ ...p, [type]: enabled })); // optimistic
      setError(null);
      try {
        const res = await api('/api/notification-preferences', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notificationType: type, enabled }),
        });
        if (!res.ok) {
          const decoded = await decode(res);
          setPreferences((p) => ({ ...p, [type]: prev })); // revert
          if (decoded) setError(decoded.message);
        }
      } catch (err) {
        setPreferences((p) => ({ ...p, [type]: prev })); // revert
        const decoded = await decode(err);
        if (decoded) setError(decoded.message);
      }
    },
    [api, preferences],
  );

  return { preferences, isLoading, error, setPreference, reload: load };
}
