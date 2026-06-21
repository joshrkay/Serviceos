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

export function useEstimateTerm(): string {
  const apiFetch = useApiClient();
  const [estimateTerm, setEstimateTerm] = useState<string>(cachedEstimateTerm ?? DEFAULT_ESTIMATE_TERM);

  useEffect(() => {
    if (cachedEstimateTerm !== null) {
      setEstimateTerm(cachedEstimateTerm);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (cancelled || !res.ok) return;
        const data = await res.json() as { terminologyPreferences?: Record<string, string> };
        const term = data.terminologyPreferences?.estimateTerm?.trim() || DEFAULT_ESTIMATE_TERM;
        cachedEstimateTerm = term;
        if (!cancelled) setEstimateTerm(term);
      } catch {
        /* network hiccup — default stands */
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch]);

  return estimateTerm;
}
