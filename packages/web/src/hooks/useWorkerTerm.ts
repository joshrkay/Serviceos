/**
 * Returns the tenant's preferred term for a worker/technician.
 * Falls back to 'Technician' if settings haven't loaded yet or if no
 * custom term is configured.
 *
 * Loads once per mount from GET /api/settings and caches the result in
 * module scope so subsequent callers within the same session pay no
 * additional network cost.
 */
import { useState, useEffect } from 'react';
import { useApiClient } from '../lib/apiClient';

let cachedWorkerTerm: string | null = null;

export function useWorkerTerm(): string {
  const apiFetch = useApiClient();
  const [workerTerm, setWorkerTerm] = useState<string>(cachedWorkerTerm ?? 'Technician');

  useEffect(() => {
    if (cachedWorkerTerm !== null) {
      setWorkerTerm(cachedWorkerTerm);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (cancelled || !res.ok) return;
        const data = await res.json() as { terminologyPreferences?: Record<string, string> };
        const term = data.terminologyPreferences?.workerTerm?.trim() || 'Technician';
        cachedWorkerTerm = term;
        if (!cancelled) setWorkerTerm(term);
      } catch {
        /* network hiccup — default stands */
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch]);

  return workerTerm;
}
