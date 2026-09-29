import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface TeamMember {
  id: string;
  name: string;
}

type ApiUser = { id: string; firstName?: string; lastName?: string; email?: string };

/**
 * #1416 / #1402 §7 — the tenant's team members by NAME (A→Z), for anything
 * that picks or shows a person (lead assignee filter, lead assign picker) —
 * never a raw user id. Best-effort: a caller who cannot list users gets [].
 */
export function useTeamMembers(): TeamMember[] {
  const [members, setMembers] = useState<TeamMember[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/users');
        if (!res?.ok) return;
        const json = (await res.json()) as { data?: ApiUser[] } | ApiUser[];
        const users = Array.isArray(json) ? json : json?.data ?? [];
        const mapped = users
          .map((u) => ({
            id: u.id,
            name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Team member',
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setMembers(mapped);
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return members;
}
