import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';

export interface TechnicianAppointment {
  id: string;
  jobId: string;
  customerName: string;
  locationAddress: string;
  locationLatitude?: number;
  locationLongitude?: number;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  jobSummary?: string;
}

export interface TechnicianDayViewProps {
  technicianId: string;
}

interface Coordinates {
  latitude: number;
  longitude: number;
  timestamp: number;
}

const OVERDUE_PROMPT_MINUTES = 15;
const NO_MOVEMENT_PROMPT_MINUTES = 20;
const ARRIVAL_RADIUS_METERS = 120;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toDateInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function buildMapsHref(address: string): string {
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function haversineDistanceMeters(a: Coordinates, b: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371e3;

  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const value =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
    + Math.cos(lat1) * Math.cos(lat2)
    * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);

  const arc = 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  return earthRadiusMeters * arc;
}

function isNearAppointment(coordinates: Coordinates, appointment: TechnicianAppointment): boolean {
  if (
    typeof appointment.locationLatitude !== 'number'
    || typeof appointment.locationLongitude !== 'number'
  ) {
    return false;
  }

  return haversineDistanceMeters(coordinates, {
    latitude: appointment.locationLatitude,
    longitude: appointment.locationLongitude,
    timestamp: coordinates.timestamp,
  }) <= ARRIVAL_RADIUS_METERS;
}

function hasMovedRecently(history: Coordinates[]): boolean {
  if (history.length < 2) return false;

  const earliest = history[0];
  const latest = history[history.length - 1];
  const movedMeters = haversineDistanceMeters(earliest, latest);
  return movedMeters > 40;
}

function answerScheduleQuestion(question: string, appointments: TechnicianAppointment[], now: Date): string {
  const normalized = question.toLowerCase();

  if (normalized.includes('next appointment') || normalized.includes('where') || normalized.includes('next stop')) {
    const next = appointments
      .filter((appt) => new Date(appt.scheduledStart).getTime() >= now.getTime())
      .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())[0];

    if (!next) {
      return 'You do not have any more appointments scheduled today.';
    }

    return `Your next appointment is with ${next.customerName} at ${formatTime(next.scheduledStart)} (${next.locationAddress}).`;
  }

  if (normalized.includes('entire schedule') || normalized.includes('today')) {
    if (appointments.length === 0) {
      return 'You have no appointments scheduled for this day.';
    }

    return appointments
      .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())
      .map((appt) => `${formatTime(appt.scheduledStart)} ${appt.customerName}`)
      .join(' • ');
  }

  return 'Try asking “Where is my next appointment?” or “Show my entire schedule today.”';
}

export function TechnicianDayView({ technicianId }: TechnicianDayViewProps) {
  const [appointments, setAppointments] = useState<TechnicianAppointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  const [editedStart, setEditedStart] = useState<string>('');
  const [editedEnd, setEditedEnd] = useState<string>('');
  const [savingAppointmentId, setSavingAppointmentId] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [positionHistory, setPositionHistory] = useState<Coordinates[]>([]);
  const [activeAppointmentId, setActiveAppointmentId] = useState<string | null>(null);
  const [showDelayPrompt, setShowDelayPrompt] = useState(false);
  const [delayPromptAcknowledged, setDelayPromptAcknowledged] = useState(false);
  const [aiQuestion, setAiQuestion] = useState('Where is my next appointment?');
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAppointments() {
      setIsLoading(true);
      setError(null);
      try {
        const dateStr = toDateInputValue(selectedDate);
        const response = await apiFetch(
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

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('GPS is unavailable on this device.');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setGpsError(null);
        setPositionHistory((prev) => {
          const cutoff = Date.now() - NO_MOVEMENT_PROMPT_MINUTES * 60 * 1000;
          const next = [
            ...prev,
            {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              timestamp: position.timestamp,
            },
          ].filter((entry) => entry.timestamp >= cutoff);
          return next;
        });
      },
      () => {
        setGpsError('Unable to read your location. Enable GPS permissions to auto-detect arrival delays.');
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const sortedAppointments = useMemo(
    () => [...appointments].sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()),
    [appointments]
  );

  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return sortedAppointments.find((appt) => new Date(appt.scheduledStart).getTime() >= now) ?? null;
  }, [sortedAppointments]);

  useEffect(() => {
    if (positionHistory.length === 0 || sortedAppointments.length === 0 || delayPromptAcknowledged) {
      return;
    }

    const now = Date.now();
    const currentPosition = positionHistory[positionHistory.length - 1];
    const active = sortedAppointments.find((appt) => isNearAppointment(currentPosition, appt));

    if (!active) {
      setActiveAppointmentId(null);
      return;
    }

    setActiveAppointmentId(active.id);

    const scheduledEndTime = new Date(active.scheduledEnd).getTime();
    const overdue = now - scheduledEndTime >= OVERDUE_PROMPT_MINUTES * 60 * 1000;
    const stationary = !hasMovedRecently(positionHistory);

    if (overdue && stationary) {
      setShowDelayPrompt(true);
    }
  }, [delayPromptAcknowledged, positionHistory, sortedAppointments]);

  const today = selectedDate.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  async function saveAppointmentTimes(appointmentId: string) {
    if (!editedStart || !editedEnd) {
      setError('Please provide both a start and end time before saving.');
      return;
    }

    try {
      setSavingAppointmentId(appointmentId);
      const response = await apiFetch(`/api/appointments/${appointmentId}`, {
        method: 'PUT',
        body: JSON.stringify({
          scheduledStart: new Date(editedStart).toISOString(),
          scheduledEnd: new Date(editedEnd).toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save appointment changes');
      }

      setAppointments((current) => current.map((appt) => (
        appt.id === appointmentId
          ? {
            ...appt,
            scheduledStart: new Date(editedStart).toISOString(),
            scheduledEnd: new Date(editedEnd).toISOString(),
          }
          : appt
      )));
      setEditingAppointmentId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save appointment changes');
    } finally {
      setSavingAppointmentId(null);
    }
  }

  async function sendDelayNotification(accepted: boolean) {
    setShowDelayPrompt(false);
    setDelayPromptAcknowledged(true);

    if (!accepted || !activeAppointmentId) {
      return;
    }

    await apiFetch(`/api/appointments/${activeAppointmentId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'running_late' }),
    });
  }

  return (
    <div className="technician-day-view" data-testid="technician-day-view">
      <div className="technician-day-view__header" data-testid="technician-day-header">
        <div>
          <h2>My Schedule</h2>
          <span className="technician-day-view__date">{today}</span>
        </div>
        <div className="technician-day-view__date-nav">
          <button
            type="button"
            onClick={() => setSelectedDate((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() - 1))}
            data-testid="technician-day-prev"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setSelectedDate((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1))}
            data-testid="technician-day-next"
          >
            Next
          </button>
        </div>
      </div>

      {nextAppointment && (
        <div className="technician-day-view__next" data-testid="technician-day-next-appointment">
          <strong>Next appointment:</strong> {nextAppointment.customerName} at {formatTime(nextAppointment.scheduledStart)}
          {' '}
          <a href={buildMapsHref(nextAppointment.locationAddress)} target="_blank" rel="noreferrer" data-testid="technician-day-next-map-link">
            Open in maps
          </a>
        </div>
      )}

      <div className="technician-day-view__assistant" data-testid="technician-day-assistant">
        <label htmlFor="tech-schedule-question">Ask AI about your schedule</label>
        <div>
          <input
            id="tech-schedule-question"
            value={aiQuestion}
            onChange={(event) => setAiQuestion(event.target.value)}
          />
          <button
            type="button"
            onClick={() => setAiAnswer(answerScheduleQuestion(aiQuestion, sortedAppointments, new Date()))}
            data-testid="technician-day-ask-ai"
          >
            Ask
          </button>
        </div>
        {aiAnswer && <p data-testid="technician-day-ai-answer">{aiAnswer}</p>}
      </div>

      {gpsError && <div data-testid="technician-day-gps-error">{gpsError}</div>}

      {showDelayPrompt && (
        <div className="technician-day-view__delay-prompt" data-testid="technician-day-delay-prompt">
          You appear to still be on-site and running 15-20 minutes behind. Notify upcoming customers?
          <div>
            <button type="button" onClick={() => void sendDelayNotification(true)} data-testid="technician-day-delay-accept">Accept</button>
            <button type="button" onClick={() => void sendDelayNotification(false)} data-testid="technician-day-delay-decline">Decline</button>
          </div>
        </div>
      )}

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
            sortedAppointments.map((appt) => {
              const isEditing = editingAppointmentId === appt.id;

              return (
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
                    <a href={buildMapsHref(appt.locationAddress)} target="_blank" rel="noreferrer">
                      {appt.locationAddress}
                    </a>
                  </div>
                  {appt.jobSummary && (
                    <div className="technician-day-view__summary">
                      {appt.jobSummary}
                    </div>
                  )}
                  <div className="technician-day-view__status" data-testid="technician-day-status">
                    {getStatusLabel(appt.status)}
                  </div>

                  {!isEditing ? (
                    <button
                      type="button"
                      data-testid="technician-day-edit"
                      onClick={() => {
                        setEditingAppointmentId(appt.id);
                        setEditedStart(toDateTimeInputValue(appt.scheduledStart));
                        setEditedEnd(toDateTimeInputValue(appt.scheduledEnd));
                      }}
                    >
                      Edit time
                    </button>
                  ) : (
                    <div data-testid="technician-day-edit-form">
                      <input
                        type="datetime-local"
                        value={editedStart}
                        onChange={(event) => setEditedStart(event.target.value)}
                        data-testid="technician-day-edit-start"
                      />
                      <input
                        type="datetime-local"
                        value={editedEnd}
                        onChange={(event) => setEditedEnd(event.target.value)}
                        data-testid="technician-day-edit-end"
                      />
                      <button
                        type="button"
                        disabled={savingAppointmentId === appt.id}
                        onClick={() => void saveAppointmentTimes(appt.id)}
                        data-testid="technician-day-save"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingAppointmentId(null)}
                        data-testid="technician-day-cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
