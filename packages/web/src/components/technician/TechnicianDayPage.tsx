import React, { useMemo } from 'react';
import { TechnicianDayView } from '../../pages/technician/TechnicianDayView';

const DEFAULT_TECHNICIAN_ID = 'tech-1';

export function TechnicianDayPage() {
  const technicianId = useMemo(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_TECHNICIAN_ID;
    }

    const fromStorage = window.localStorage.getItem('serviceos.technicianId');
    if (fromStorage && fromStorage.trim().length > 0) {
      return fromStorage;
    }

    return DEFAULT_TECHNICIAN_ID;
  }, []);

  return <TechnicianDayView technicianId={technicianId} />;
}
