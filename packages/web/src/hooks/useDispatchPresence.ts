import { useEffect, useRef } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { apiFetch } from '../utils/api-fetch';

function toDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useDispatchPresence(
  selectedDate: Date,
  dragAppointmentId: string | null,
): void {
  const { getToken } = useAuth();
  const { user } = useUser();
  const dateRef = useRef(toDateParam(selectedDate));
  dateRef.current = toDateParam(selectedDate);

  useEffect(() => {
    let cancelled = false;

    const send = async (mode: 'viewing' | 'dragging', appointmentId: string | null) => {
      const displayName =
        user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'Dispatcher';
      await apiFetch('/api/dispatch/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateRef.current,
          mode,
          appointmentId,
          displayName,
        }),
      });
    };

    const tick = () => {
      if (cancelled) return;
      void send(dragAppointmentId ? 'dragging' : 'viewing', dragAppointmentId);
    };

    tick();
    const interval = setInterval(tick, 5_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      void apiFetch(`/api/dispatch/presence?date=${encodeURIComponent(dateRef.current)}`, {
        method: 'DELETE',
      });
    };
  }, [selectedDate, dragAppointmentId, user, getToken]);
}
