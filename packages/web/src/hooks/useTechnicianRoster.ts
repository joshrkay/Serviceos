import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface TechnicianOption {
  id: string;
  name: string;
  initials?: string;
  color?: string;
  activeJobs?: number;
}

/**
 * Loads field technicians from GET /api/users?role=technician.
 */
export function useTechnicianRoster(): {
  technicians: TechnicianOption[];
  isLoading: boolean;
  error: string | null;
} {
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/users?role=technician');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        const mapped: TechnicianOption[] = list.map(
          (u: { id: string; firstName?: string; lastName?: string; email?: string }) => {
            const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
            const parts = name.split(/\s+/).filter(Boolean);
            const initials =
              parts.length >= 2
                ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
                : name.slice(0, 2).toUpperCase();
            return {
              id: u.id,
              name,
              initials,
              color: '#64748b',
              activeJobs: 0,
            };
          },
        );
        if (!cancelled) setTechnicians(mapped);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load technicians');
          setTechnicians([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { technicians, isLoading, error };
}
