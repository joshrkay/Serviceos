/**
 * Returns the tenant's preferred term for an estimate document
 * (e.g. 'Quote' or 'Bid'). Falls back to 'Estimate' if settings haven't
 * loaded yet or if no custom term is configured.
 *
 * Mirrors useWorkerTerm: loads once per mount from GET /api/settings and
 * caches the result in module scope so subsequent callers within the same
 * session pay no additional network cost. The canonical estimate entity is
 * unchanged underneath — this is purely the customer-facing label.
 */
import { useState, useEffect } from 'react';
import { useApiClient } from '../lib/apiClient';

export const DEFAULT_ESTIMATE_TERM = 'Estimate';

let cachedEstimateTerm: string | null = null;
// Shared in-flight request so several estimate components mounting together
// (list + detail + sheets) make ONE /api/settings call, not one each.
let pendingSettingsPromise: Promise<string> | null = null;

export function useEstimateTerm(): string {
  const apiFetch = useApiClient();
  const [estimateTerm, setEstimateTerm] = useState<string>(cachedEstimateTerm ?? DEFAULT_ESTIMATE_TERM);

  useEffect(() => {
    if (cachedEstimateTerm !== null) {
      setEstimateTerm(cachedEstimateTerm);
      return;
    }
    let cancelled = false;
    if (!pendingSettingsPromise) {
      pendingSettingsPromise = (async () => {
        try {
          const res = await apiFetch('/api/settings');
          if (!res.ok) return DEFAULT_ESTIMATE_TERM;
          const data = await res.json() as { terminologyPreferences?: Record<string, string> };
          const term = data.terminologyPreferences?.estimateTerm?.trim() || DEFAULT_ESTIMATE_TERM;
          cachedEstimateTerm = term;
          return term;
        } catch {
          return DEFAULT_ESTIMATE_TERM; // network hiccup — default stands
        } finally {
          // Clear so a later mount can retry if the term wasn't cached.
          pendingSettingsPromise = null;
        }
      })();
    }
    pendingSettingsPromise.then((term) => {
      if (!cancelled) setEstimateTerm(term);
    });
    return () => { cancelled = true; };
  }, [apiFetch]);

  return estimateTerm;
}
