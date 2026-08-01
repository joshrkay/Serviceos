import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useApiClient } from '../lib/useApiClient';
import { getCallbackNumber } from './callbackStorage';

/** Map an /api/calls failure to owner-friendly copy. */
function callErrorMessage(status: number): string {
  switch (status) {
    case 403:
      return 'This customer has opted out of contact (replied STOP).';
    case 422:
      return 'No phone number on file for this customer.';
    case 503:
      return 'Calling is not set up for this account yet.';
    default:
      return 'Could not start the call. Please try again.';
  }
}

export interface UseStartCallResult {
  startCall: (customerId: string) => Promise<void>;
  isCalling: boolean;
  error: string | null;
}

/**
 * Owner→customer click-to-call. Reads the device-stored callback number; if it's
 * missing, sends the owner to Settings to add it. Otherwise POSTs /api/calls —
 * the backend rings the owner's phone, then bridges to the customer with the
 * business caller-ID.
 */
export function useStartCall(): UseStartCallResult {
  const api = useApiClient();
  const router = useRouter();
  const [isCalling, setIsCalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCall = useCallback(
    async (customerId: string) => {
      setError(null);
      const agentPhone = await getCallbackNumber();
      if (!agentPhone) {
        setError('Add your callback number in Settings to make calls.');
        router.push('/settings');
        return;
      }
      setIsCalling(true);
      try {
        const res = await api('/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId, agentPhone }),
        });
        if (!res.ok) throw new Error(callErrorMessage(res.status));
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Could not start the call.');
      } finally {
        setIsCalling(false);
      }
    },
    [api, router],
  );

  return { startCall, isCalling, error };
}
