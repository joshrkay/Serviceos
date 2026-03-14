import React, { useState, useEffect } from 'react';

export interface TechnicianAppointment {
  id: string;
  jobId: string;
  customerName: string;
  locationAddress: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  jobSummary?: string;
}

export interface TechnicianDayViewProps {
  technicianId: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function TechnicianDayView({ technicianId }: TechnicianDayViewProps) {
  const [appointments, setAppointments] = useState<TechnicianAppointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate] = useState<Date>(new Date());

  useEffect(() => {
    async function fetchAppointments() {
      setIsLoading(true);
      setError(null);
      try {
        const dateStr = selectedDate.toISOString().split('T')[0];
        const response = await fetch(
          `/api/dispatch/technician/${technicianId}/appointments?date=${dateStr}`
        );
        if (!response.ok) {
          throw new Error('Failed to load appointments');
        }
        const data = await response.json();
        setAppointments(data.appointments ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load appointments');
      } finally {
        setIsLoading(false);
      }
    }
    fetchAppointments();
  }, [technicianId, selectedDate]);

  const sortedAppointments = [...appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()
  );

  const today = selectedDate.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="technician-day-view" data-testid="technician-day-view">
      <div className="technician-day-view__header" data-testid="technician-day-header">
        <h2>My Schedule</h2>
        <span className="technician-day-view__date">{today}</span>
      </div>

      {isLoading && (
        <div className="technician-day-view__loading" data-testid="technician-day-loading">
          Loading schedule...
        </div>
      )}

      {error && (
        <div className="technician-day-view__error" data-testid="technician-day-error">
          {error}
        </div>
      )}

      {!isLoading && !error && (
        <div className="technician-day-view__list" data-testid="technician-day-list">
          {sortedAppointments.length === 0 ? (
            <div className="technician-day-view__empty" data-testid="technician-day-empty">
              No appointments scheduled for today
            </div>
          ) : (
            sortedAppointments.map((appt) => (
              <div
                key={appt.id}
                className="technician-day-view__appointment"
                data-testid="technician-day-appointment"
              >
                <div className="technician-day-view__time" data-testid="technician-day-time">
                  {formatTime(appt.scheduledStart)} - {formatTime(appt.scheduledEnd)}
                </div>
                <div className="technician-day-view__customer" data-testid="technician-day-customer">
                  {appt.customerName}
                </div>
                <div className="technician-day-view__location" data-testid="technician-day-location">
                  {appt.locationAddress}
                </div>
                {appt.jobSummary && (
                  <div className="technician-day-view__summary">
                    {appt.jobSummary}
                  </div>
                )}
                <div className="technician-day-view__status" data-testid="technician-day-status">
                  {getStatusLabel(appt.status)}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
