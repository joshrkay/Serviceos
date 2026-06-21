import { useCallback, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

export type DeleteAccountPhase = 'idle' | 'deleting' | 'error';

export interface UseDeleteAccountResult {
  phase: DeleteAccountPhase;
  error: string | null;
  /**
   * POSTs the owner-only self-serve account deletion and resolves `true` on
   * success. The server hard-deletes the caller's own tenant in the background;
   * the caller should sign out on success.
   */
  deleteAccount: () => Promise<boolean>;
}

/**
 * Drives the in-app "Delete account" action required by Apple App Store Review
 * Guideline 5.1.1(v). The API (`POST /api/account/delete`, owner-only) enqueues
 * the tenant deprovision and returns 202; we treat any 2xx as success. A
 * non-owner gets a 403, surfaced as an error string the screen renders.
 */
export function useDeleteAccount(): UseDeleteAccountResult {
  const api = useApiClient();
  const [phase, setPhase] = useState<DeleteAccountPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const deleteAccount = useCallback(async (): Promise<boolean> => {
    setPhase('deleting');
    setError(null);
    try {
      const res = await api('/api/account/delete', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error((await decodeError(res)).message);
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not delete your account. Please try again.',
      );
      setPhase('error');
      return false;
    }
  }, [api]);

  return { phase, error, deleteAccount };
}
