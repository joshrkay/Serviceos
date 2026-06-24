import { useCallback } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

/** Per-id outcome of POST /api/proposals/approve-batch (mirrors the API's
 *  BatchApproveResult). The server re-validates each id, so an ineligible or
 *  blocked proposal lands in `failed` instead of failing the whole batch. */
export interface BatchApproveResult {
  approved: string[];
  failed: { id: string; reason: string }[];
}

/**
 * One-tap batch approval for the inbox. The CALLER decides which ids to send
 * (see `isBatchEligible` — capture-class + high confidence only); this hook is
 * the transport. A non-2xx (auth/validation) throws; a partial result (some
 * ids in `failed`) resolves normally so the screen can report it.
 */
export function useApproveBatch(): (proposalIds: string[]) => Promise<BatchApproveResult> {
  const api = useApiClient();
  return useCallback(
    async (proposalIds: string[]): Promise<BatchApproveResult> => {
      // Nothing eligible → skip the round-trip (and a possible min(1) 400).
      if (proposalIds.length === 0) return { approved: [], failed: [] };
      const res = await api('/api/proposals/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalIds }),
      });
      if (!res.ok) throw new Error((await decodeError(res)).message);
      return (await res.json()) as BatchApproveResult;
    },
    [api],
  );
}
