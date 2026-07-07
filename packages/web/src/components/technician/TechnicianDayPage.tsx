import React, { useMemo } from 'react';
import { TechnicianDayView } from '../../pages/technician/TechnicianDayView';
import { useMe } from '../../hooks/useMe';
import { getLocalFlag } from '../../lib/uiFlags';

export function TechnicianDayPage() {
  const { me, isLoading } = useMe();

  // Sweep-2 S5 — technicians are `users` rows and appointment
  // assignments store `users.id` (UUID). `me.user_id` is the AUTH
  // identity (Clerk sub like `user_2abc…`, non-UUID in production, and
  // `user_demo_owner` under the dev bypass) — sending it to
  // /api/dispatch/technician/:id/appointments always 400'd on the UUID
  // guard. Use the additively-exposed `internal_user_id` instead; when
  // it's null the account simply has no technician profile, so show the
  // designed empty state rather than "Failed to load appointments".
  // The localStorage override remains for QA/dispatcher impersonation.
  const technicianId = useMemo(() => {
    const fromStorage = getLocalFlag('serviceos.technicianId');
    if (fromStorage && fromStorage.trim().length > 0) {
      return fromStorage;
    }
    return me?.internal_user_id ?? null;
  }, [me?.internal_user_id]);

  if (!technicianId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {isLoading ? 'Loading your day…' : 'No technician profile found for this account.'}
      </div>
    );
  }

  return <TechnicianDayView technicianId={technicianId} />;
}
