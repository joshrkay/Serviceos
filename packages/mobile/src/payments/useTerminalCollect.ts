import { useCallback } from 'react';
import type { AuthedFetch } from '../api/me';
import {
  TERMINAL_UNAVAILABLE_REASON,
  type TerminalCollectResult,
} from './terminalTypes';

/**
 * Web / non-native fallback — never imports the Stripe Terminal package.
 */
export function useTerminalCollect(): (input: {
  client: AuthedFetch;
  invoiceId: string;
}) => Promise<TerminalCollectResult> {
  return useCallback(async () => {
    return {
      status: 'unavailable',
      reason: TERMINAL_UNAVAILABLE_REASON,
    };
  }, []);
}
