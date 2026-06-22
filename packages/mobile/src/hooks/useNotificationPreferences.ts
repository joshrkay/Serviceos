import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

export interface NotificationPreferencesResult {
  /** Effective enabled flag per notification type (absent = on). */
  preferences: Record<string, boolean>;
  isLoading: boolean;
  error: string | null;
  setEnabled: (type: string, enabled: boolean) => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * Reads GET /api/notification-preferences and writes one category at a time via
 * PUT. Toggles are optimistic (and revert on failure) so the switch feels
 * instant; the server response is the source of truth for the merged set.
 */
export function useNotificationPreferences(): NotificationPreferencesResult {
  const api = useApiClient();
  const [preferences, setPreferences] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api('/api/notification-preferences');
      if (!res.ok) {
        setError((await decodeError(res)).message);
        return;
      }
      const body = (await res.json()) as { preferences?: Record<string, boolean> };
      setPreferences(body.preferences ?? {});
      setError(null);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setError((await decodeError(e)).message);
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setEnabled = useCallback(
    async (type: string, enabled: boolean) => {
      setPreferences((p) => ({ ...p, [type]: enabled })); // optimistic
      try {
        const res = await api('/api/notification-preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notificationType: type, enabled }),
        });
        if (!res.ok) {
          setPreferences((p) => ({ ...p, [type]: !enabled })); // revert
          setError((await decodeError(res)).message);
          return;
        }
        const body = (await res.json()) as { preferences?: Record<string, boolean> };
        if (body.preferences) setPreferences(body.preferences);
        setError(null);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        setPreferences((p) => ({ ...p, [type]: !enabled })); // revert
        setError((await decodeError(e)).message);
      }
    },
    [api],
  );

  return { preferences, isLoading, error, setEnabled, reload };
}
