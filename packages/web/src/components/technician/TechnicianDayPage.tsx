import React, { useMemo } from 'react';
import { TechnicianDayView } from '../../pages/technician/TechnicianDayView';
import { useMe } from '../../hooks/useMe';

export function TechnicianDayPage() {
  const { me, isLoading } = useMe();

  // Technicians are `users` rows, so the authenticated user's id IS the
  // technician id. The old hardcoded 'tech-1' fallback sent a fake id to
  // the API on every fresh session (400/500s — QA 2026-07-02). The
  // localStorage override remains for QA/dispatcher impersonation.
  const technicianId = useMemo(() => {
    if (typeof window !== 'undefined') {
      const fromStorage = window.localStorage.getItem('serviceos.technicianId');
      if (fromStorage && fromStorage.trim().length > 0) {
        return fromStorage;
      }
    }
    return me?.user_id ?? null;
  }, [me?.user_id]);

  if (!technicianId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {isLoading ? 'Loading your day…' : 'No technician profile found for this account.'}
      </div>
    );
  }

  return <TechnicianDayView technicianId={technicianId} />;
}
