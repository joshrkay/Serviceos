/**
 * P12-002 — `useMe` hook.
 *
 * Single source of truth for "who is the authenticated user, what tenant
 * are they in, what role + mode + permissions do they have." Replaces
 * ad-hoc `useUser()` + localStorage('serviceos.permissions') reads
 * scattered across pages.
 *
 * Caches the response in module scope keyed on the API client identity
 * (which is stable for the Clerk session). Refetched on `switchMode`.
 *
 * Errors fall back to a neutral default (`current_mode: 'supervisor'`,
 * `permissions: []`) so guarded UI can still render — the protected-route
 * guard handles the actual auth boundary.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../lib/apiClient';
import {
  fetchMe,
  postModeSwitch,
  type AuthedFetch,
  type Mode,
  type MeResponse,
} from '../api/me';

export type { Mode, MeResponse };

export interface UseMeResult {
  /** Latest /api/me response, or `null` while the first fetch is in flight. */
  me: MeResponse | null;
  isLoading: boolean;
  error: Error | null;
  /**
   * Switches the user's current mode and refetches `me`. Throws if the
   * server rejects the mode (e.g. 403 for a dispatcher without
   * `can_field_serve` requesting `tech`); the caller should surface a
   * toast / inline error and keep the UI on the prior mode.
   */
  switchMode: (next: Mode) => Promise<void>;
  /** Force-refresh from the server (no-op if no fetch is in-flight). */
  refetch: () => Promise<void>;
}

export function useMe(): UseMeResult {
  const client = useApiClient() as AuthedFetch;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchMe(client);
      setMe(response);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchMode = useCallback(
    async (next: Mode) => {
      await postModeSwitch(client, next);
      await load();
    },
    [client, load],
  );

  const refetch = useCallback(async () => {
    await load();
  }, [load]);

  return { me, isLoading, error, switchMode, refetch };
}
