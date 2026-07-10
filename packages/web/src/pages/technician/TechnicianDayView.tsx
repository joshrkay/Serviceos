import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';
import { TechnicianProfitCard } from '../../components/technician/TechnicianProfitCard';

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
  updatedAt?: string;
}

export interface TechnicianDayViewProps {
  technicianId: string;
}

interface Coordinates {
  latitude: number;
  longitude: number;
  timestamp: number;
  accuracyMeters: number;
}

const OVERDUE_PROMPT_MINUTES = 15;
const NO_MOVEMENT_PROMPT_MINUTES = 20;
const ARRIVAL_RADIUS_METERS = 120;
const GPS_ACCURACY_THRESHOLD_METERS = 75;
const STATE_CONFIRMATION_WINDOW = 5;
const STATE_CONFIRMATION_MIN = 3;
const PROMPT_COOLDOWN_MINUTES = 12;
const MAX_PROMPTS_PER_APPOINTMENT_PER_DAY = 3;
const TECHNICIAN_RESPONSE_TIMEOUT_MINUTES = 5;
const HIGH_CONFIDENCE_AUTO_NOTIFY = 0.82;
const MIN_CONFIDENCE_FOR_CUSTOMER_NOTIFY = 0.65;

interface ReliabilityDecision {
  shouldPrompt: boolean;
  shouldAutoNotify: boolean;
  shouldEscalate: boolean;
  confidence: number;
  reason: string;
  sampleCount: number;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `tech-day-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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
    accuracyMeters: coordinates.accuracyMeters,
  }) <= ARRIVAL_RADIUS_METERS;
}

function hasMovedRecently(history: Coordinates[]): boolean {
  if (history.length < 2) return false;

  const earliest = history[0];
  const latest = history[history.length - 1];
  const movedMeters = haversineDistanceMeters(earliest, latest);
  return movedMeters > 40;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function computePromptConfidence(history: Coordinates[]): number {
  if (history.length === 0) return 0;

  const latest = history[history.length - 1];
  const ageSeconds = Math.max(0, (Date.now() - latest.timestamp) / 1000);
  const recencyScore = clamp(1 - (ageSeconds / (8 * 60)));
  const avgAccuracy = history.reduce((sum, ping) => sum + ping.accuracyMeters, 0) / history.length;
  const accuracyScore = clamp(1 - ((avgAccuracy - 5) / 80));
  const movementConsistency = hasMovedRecently(history) ? 0.35 : 0.95;

  return clamp((recencyScore * 0.4) + (accuracyScore * 0.4) + (movementConsistency * 0.2));
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
  const navigate = useNavigate();
  const [appointments, setAppointments] = useState<TechnicianAppointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  const [editedStart, setEditedStart] = useState<string>('');
  const [editedEnd, setEditedEnd] = useState<string>('');
  const [savingAppointmentId, setSavingAppointmentId] = useState<string | null>(null);
  const [staleAppointmentId, setStaleAppointmentId] = useState<string | null>(null);
  const [refetchNonce, setRefetchNonce] = useState(0);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [positionHistory, setPositionHistory] = useState<Coordinates[]>([]);
  const [activeAppointmentId, setActiveAppointmentId] = useState<string | null>(null);
  const [showDelayPrompt, setShowDelayPrompt] = useState(false);
  const [delayPromptAcknowledged, setDelayPromptAcknowledged] = useState(false);
  const [promptConfidence, setPromptConfidence] = useState(0);
  const [promptRaisedAt, setPromptRaisedAt] = useState<number | null>(null);
  const [promptStats, setPromptStats] = useState<Record<string, { count: number; lastRaisedAt: number; lastConfidence: number }>>({});
  const [aiQuestion, setAiQuestion] = useState('Where is my next appointment?');
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [onMyWaySending, setOnMyWaySending] = useState<string | null>(null);
  const [onMyWayNotified, setOnMyWayNotified] = useState<Record<string, boolean>>({});

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
  }, [technicianId, selectedDate, refetchNonce]);

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
              accuracyMeters: position.coords.accuracy ?? GPS_ACCURACY_THRESHOLD_METERS + 1,
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
    if (currentPosition.accuracyMeters > GPS_ACCURACY_THRESHOLD_METERS) {
      return;
    }

    const active = sortedAppointments.find((appt) => isNearAppointment(currentPosition, appt));

    if (!active) {
      setActiveAppointmentId(null);
      return;
    }

    setActiveAppointmentId(active.id);

    const scheduledEndTime = new Date(active.scheduledEnd).getTime();
    const confirmationSlice = positionHistory
      .slice(-STATE_CONFIRMATION_WINDOW)
      .filter((ping) => ping.accuracyMeters <= GPS_ACCURACY_THRESHOLD_METERS);
    const triggeredSignals = confirmationSlice.filter((ping) => {
      const overdue = now - scheduledEndTime >= OVERDUE_PROMPT_MINUTES * 60 * 1000;
      const stationary = !hasMovedRecently(positionHistory.filter((entry) => entry.timestamp <= ping.timestamp));
      return overdue && stationary && isNearAppointment(ping, active);
    }).length;

    if (confirmationSlice.length === 0 || triggeredSignals < STATE_CONFIRMATION_MIN) {
      return;
    }

    const confidence = computePromptConfidence(confirmationSlice);
    const todayKey = new Date().toISOString().slice(0, 10);
    const promptKey = `${active.id}:${todayKey}`;
    const promptHistory = promptStats[promptKey];
    const withinCooldown = promptHistory
      ? (now - promptHistory.lastRaisedAt) < PROMPT_COOLDOWN_MINUTES * 60 * 1000
      : false;
    const overDailyLimit = promptHistory ? promptHistory.count >= MAX_PROMPTS_PER_APPOINTMENT_PER_DAY : false;
    const hasWorsened = promptHistory ? confidence >= (promptHistory.lastConfidence + 0.08) : true;

    if (overDailyLimit || (withinCooldown && !hasWorsened)) {
      return;
    }

    const decision: ReliabilityDecision = {
      shouldPrompt: confidence < HIGH_CONFIDENCE_AUTO_NOTIFY,
      shouldAutoNotify: confidence >= HIGH_CONFIDENCE_AUTO_NOTIFY,
      shouldEscalate: false,
      confidence,
      reason: `threshold_breached: overdue+stationary with ${triggeredSignals}/${confirmationSlice.length} valid pings`,
      sampleCount: confirmationSlice.length,
    };

    setPromptConfidence(decision.confidence);
    setPromptRaisedAt(now);
    setPromptStats((prev) => ({
      ...prev,
      [promptKey]: {
        count: (promptHistory?.count ?? 0) + 1,
        lastRaisedAt: now,
        lastConfidence: decision.confidence,
      },
    }));

    void apiFetch('/api/dispatch/delay-prompt-audits', {
      method: 'POST',
      body: JSON.stringify({
        technicianId,
        appointmentId: active.id,
        eventType: decision.shouldAutoNotify ? 'auto_notify' : 'prompt_raised',
        reason: decision.reason,
        confidence: decision.confidence,
        sampleCount: decision.sampleCount,
        thresholds: {
          gpsAccuracyMeters: GPS_ACCURACY_THRESHOLD_METERS,
          stateConfirmMin: STATE_CONFIRMATION_MIN,
          stateConfirmWindow: STATE_CONFIRMATION_WINDOW,
        },
      }),
    });

    if (decision.shouldAutoNotify && decision.confidence >= MIN_CONFIDENCE_FOR_CUSTOMER_NOTIFY) {
      setDelayPromptAcknowledged(true);
      setShowDelayPrompt(false);
      // running_late is a status signal (no new time) — not expressible as a
      // reschedule_appointment proposal. Send the running-late notice, and
      // surface failures instead of dropping them with a fire-and-forget void apiFetch.
      void markRunningLate(active.id);
      return;
    }

    if (decision.shouldPrompt) {
      setShowDelayPrompt(true);
    }
  }, [delayPromptAcknowledged, positionHistory, sortedAppointments]);

  useEffect(() => {
    if (!showDelayPrompt || !activeAppointmentId || delayPromptAcknowledged || !promptRaisedAt) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (delayPromptAcknowledged) {
        return;
      }

      setShowDelayPrompt(false);
      setDelayPromptAcknowledged(true);

      void apiFetch('/api/dispatch/delay-escalations', {
        method: 'POST',
        body: JSON.stringify({
          technicianId,
          appointmentId: activeAppointmentId,
          reason: 'no_technician_response',
          timeoutMinutes: TECHNICIAN_RESPONSE_TIMEOUT_MINUTES,
          confidence: promptConfidence,
          promptedAt: new Date(promptRaisedAt).toISOString(),
        }),
      });

      void apiFetch('/api/dispatch/delay-prompt-audits', {
        method: 'POST',
        body: JSON.stringify({
          technicianId,
          appointmentId: activeAppointmentId,
          eventType: 'escalated_dispatcher_queue',
          reason: 'technician_response_timeout',
          confidence: promptConfidence,
          sampleCount: Math.min(positionHistory.length, STATE_CONFIRMATION_WINDOW),
        }),
      });
    }, TECHNICIAN_RESPONSE_TIMEOUT_MINUTES * 60 * 1000);

    return () => window.clearTimeout(timer);
  }, [
    activeAppointmentId,
    delayPromptAcknowledged,
    positionHistory.length,
    promptConfidence,
    promptRaisedAt,
    showDelayPrompt,
    technicianId,
  ]);

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

    const appointment = appointments.find((appt) => appt.id === appointmentId);
    const appointmentVersion = appointment?.updatedAt;
    const newScheduledStart = new Date(editedStart).toISOString();
    const newScheduledEnd = new Date(editedEnd).toISOString();

    try {
      setSavingAppointmentId(appointmentId);
      setError(null);
      setStaleAppointmentId(null);

      // Techs do not hold `appointments:update`; route the edit through the
      // human-approval-gated proposal path (mirrors the dispatch board) rather
      // than a direct PUT /api/appointments/:id.
      const response = await apiFetch('/api/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(appointmentVersion ? { 'If-Match': appointmentVersion } : {}),
        },
        body: JSON.stringify({
          proposalType: 'reschedule_appointment',
          payload: {
            appointmentId,
            newScheduledStart,
            newScheduledEnd,
            reason: 'Rescheduled by technician from the day view',
          },
          summary: 'Reschedule appointment requested by technician',
          idempotencyKey: generateIdempotencyKey(),
          ...(appointmentVersion ? { appointmentVersion } : {}),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          setStaleAppointmentId(appointmentId);
          setError('This appointment changed since you opened it. Refresh and try again.');
          return;
        }
        if (response.status === 422) {
          const body = (await response.json().catch(() => ({}))) as {
            blocking?: Array<{ message?: string }>;
          };
          const reason = body.blocking?.[0]?.message ?? 'feasibility check failed';
          setError(`Cannot reschedule: ${reason}`);
          return;
        }
        throw new Error('Failed to submit reschedule request');
      }

      setEditingAppointmentId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit reschedule request');
    } finally {
      setSavingAppointmentId(null);
    }
  }

  async function sendOnMyWay(appointmentId: string) {
    setOnMyWaySending(appointmentId);
    setError(null);
    try {
      const response = await apiFetch(`/api/dispatch/appointments/${appointmentId}/en-route`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error('Failed to send "on my way" notice');
      }
      // The endpoint returns 202 even when nobody could be notified (e.g. no
      // customer contact on file). Only show the success state — and disable
      // retries — when a recipient was actually reached.
      const body = await response.json().catch(() => ({}));
      if (body?.notified === true) {
        setOnMyWayNotified((current) => ({ ...current, [appointmentId]: true }));
      } else {
        setError('No contact on file for this customer — no notice was sent.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send "on my way" notice');
    } finally {
      setOnMyWaySending(null);
    }
  }

  async function markRunningLate(appointmentId: string): Promise<boolean> {
    try {
      // Technicians hold only `appointments:view`, so the old
      // PUT /api/appointments/:id virtual-status call always 403'd here.
      // Use the technician-reachable running-late endpoint instead. No
      // delay estimate is available on this path — an empty body lets the
      // server apply its default (20 minutes).
      const response = await apiFetch(`/api/appointments/${appointmentId}/running-late`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error('Failed to send running-late notice');
      }
      return true;
    } catch (err) {
      // Previously this was a fire-and-forget `void apiFetch` with no .catch,
      // so failures were silently dropped. Surface them to the technician.
      setError(err instanceof Error ? err.message : 'Failed to send running-late notice');
      return false;
    }
  }

  async function sendDelayNotification(accepted: boolean) {
    setShowDelayPrompt(false);
    setDelayPromptAcknowledged(true);

    if (!accepted || !activeAppointmentId) {
      return;
    }

    const notified = await markRunningLate(activeAppointmentId);
    if (!notified) {
      return;
    }
    await apiFetch('/api/dispatch/delay-prompt-audits', {
      method: 'POST',
      body: JSON.stringify({
        technicianId,
        appointmentId: activeAppointmentId,
        eventType: 'technician_confirmed_notify',
        reason: 'technician_confirmed_delay',
        confidence: promptConfidence,
        sampleCount: Math.min(positionHistory.length, STATE_CONFIRMATION_WINDOW),
      }),
    });
  }

  // Sweep-2 S3 — this view previously used BEM class names with no
  // stylesheet (inert in this Tailwind app), rendering as raw unstyled
  // text. Restyled with the repo's mobile conventions: card patterns
  // mirroring TechJobView and ≥44px (min-h-11) tap targets per the
  // CLAUDE.md mobile rule. All behavior and data-testids are unchanged.
  const secondaryButtonClass =
    'flex min-h-11 items-center justify-center rounded-xl border border-border bg-card px-4 text-sm text-foreground hover:bg-secondary active:bg-secondary transition-colors disabled:opacity-50';
  const primaryButtonClass =
    'flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90 active:bg-primary/80 transition-colors disabled:opacity-50';

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 px-4 py-4" data-testid="technician-day-view">
      <div className="flex items-start justify-between gap-3" data-testid="technician-day-header">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-foreground">My Schedule</h2>
          <span className="text-sm text-muted-foreground">{today}</span>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setSelectedDate((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() - 1))}
            data-testid="technician-day-prev"
          >
            Previous
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setSelectedDate((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1))}
            data-testid="technician-day-next"
          >
            Next
          </button>
        </div>
      </div>

      {/* Manager-only (invoices:view-gated; hides for technicians). */}
      <TechnicianProfitCard technicianId={technicianId} />

      {nextAppointment && (
        <div
          className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-foreground"
          data-testid="technician-day-next-appointment"
        >
          <strong>Next appointment:</strong> {nextAppointment.customerName} at {formatTime(nextAppointment.scheduledStart)}
          {' '}
          <a
            href={buildMapsHref(nextAppointment.locationAddress)}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
            data-testid="technician-day-next-map-link"
          >
            Open in maps
          </a>
        </div>
      )}

      <div
        className="space-y-2 rounded-2xl border border-border bg-card p-4"
        data-testid="technician-day-assistant"
      >
        <label htmlFor="tech-schedule-question" className="text-sm font-medium text-foreground">
          Ask AI about your schedule
        </label>
        <div className="flex gap-2">
          <input
            id="tech-schedule-question"
            className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            value={aiQuestion}
            onChange={(event) => setAiQuestion(event.target.value)}
          />
          <button
            type="button"
            className={`${primaryButtonClass} shrink-0`}
            onClick={() => setAiAnswer(answerScheduleQuestion(aiQuestion, sortedAppointments, new Date()))}
            data-testid="technician-day-ask-ai"
          >
            Ask
          </button>
        </div>
        {aiAnswer && (
          <p className="text-sm text-muted-foreground" data-testid="technician-day-ai-answer">
            {aiAnswer}
          </p>
        )}
      </div>

      {gpsError && (
        <div
          className="rounded-xl border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground"
          data-testid="technician-day-gps-error"
        >
          {gpsError}
        </div>
      )}

      {showDelayPrompt && (
        <div
          className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
          data-testid="technician-day-delay-prompt"
        >
          You appear to still be on-site and running 15-20 minutes behind. Notify upcoming customers?
          <div className="text-xs text-muted-foreground" data-testid="technician-day-delay-confidence">
            Reliability confidence: {Math.round(promptConfidence * 100)}%
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={`${primaryButtonClass} flex-1`}
              onClick={() => void sendDelayNotification(true)}
              data-testid="technician-day-delay-accept"
            >
              Accept
            </button>
            <button
              type="button"
              className={`${secondaryButtonClass} flex-1`}
              onClick={() => void sendDelayNotification(false)}
              data-testid="technician-day-delay-decline"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="py-8 text-center text-sm text-muted-foreground" data-testid="technician-day-loading">
          Loading schedule...
        </div>
      )}

      {error && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="technician-day-error"
        >
          {error}
          {staleAppointmentId && (
            <button
              type="button"
              onClick={() => {
                setStaleAppointmentId(null);
                setEditingAppointmentId(null);
                setError(null);
                setRefetchNonce((value) => value + 1);
              }}
              data-testid="technician-day-refresh"
              className="ml-2 min-h-11 underline"
            >
              Refresh
            </button>
          )}
        </div>
      )}

      {!isLoading && !error && (
        <div className="space-y-3" data-testid="technician-day-list">
          {sortedAppointments.length === 0 ? (
            <div
              className="rounded-2xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="technician-day-empty"
            >
              No appointments scheduled for today
            </div>
          ) : (
            sortedAppointments.map((appt) => {
              const isEditing = editingAppointmentId === appt.id;

              return (
                <div
                  key={appt.id}
                  className="space-y-2 rounded-2xl border border-border bg-card p-4"
                  data-testid="technician-day-appointment"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-foreground" data-testid="technician-day-time">
                      {formatTime(appt.scheduledStart)} - {formatTime(appt.scheduledEnd)}
                    </div>
                    <div
                      className="inline-flex rounded-full bg-secondary px-2.5 py-0.5 text-xs capitalize text-foreground"
                      data-testid="technician-day-status"
                    >
                      {getStatusLabel(appt.status)}
                    </div>
                  </div>
                  <div className="text-base font-medium text-foreground" data-testid="technician-day-customer">
                    {appt.customerName}
                  </div>
                  <div className="text-sm" data-testid="technician-day-location">
                    <a
                      href={buildMapsHref(appt.locationAddress)}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words text-primary underline"
                    >
                      {appt.locationAddress}
                    </a>
                  </div>
                  {appt.jobSummary && (
                    <div className="break-words text-sm text-muted-foreground">
                      {appt.jobSummary}
                    </div>
                  )}

                  <div className="flex flex-col gap-2 pt-1">
                    {appt.jobId && (
                      <button
                        type="button"
                        data-testid="technician-day-view-job"
                        onClick={() => navigate(`/jobs/${appt.jobId}?view=tech`)}
                        className={`${secondaryButtonClass} w-full`}
                      >
                        View job →
                      </button>
                    )}

                    <button
                      type="button"
                      className={`${primaryButtonClass} w-full`}
                      data-testid="technician-day-on-my-way"
                      disabled={onMyWaySending === appt.id || onMyWayNotified[appt.id]}
                      onClick={() => void sendOnMyWay(appt.id)}
                    >
                      {onMyWayNotified[appt.id]
                        ? 'Customer notified ✓'
                        : onMyWaySending === appt.id
                          ? 'Sending…'
                          : 'On my way'}
                    </button>

                    {!isEditing ? (
                      <button
                        type="button"
                        className={`${secondaryButtonClass} w-full`}
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
                      <div className="space-y-2" data-testid="technician-day-edit-form">
                        <input
                          type="datetime-local"
                          className="min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground"
                          value={editedStart}
                          onChange={(event) => setEditedStart(event.target.value)}
                          data-testid="technician-day-edit-start"
                        />
                        <input
                          type="datetime-local"
                          className="min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground"
                          value={editedEnd}
                          onChange={(event) => setEditedEnd(event.target.value)}
                          data-testid="technician-day-edit-end"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className={`${primaryButtonClass} flex-1`}
                            disabled={savingAppointmentId === appt.id}
                            onClick={() => void saveAppointmentTimes(appt.id)}
                            data-testid="technician-day-save"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className={`${secondaryButtonClass} flex-1`}
                            onClick={() => setEditingAppointmentId(null)}
                            data-testid="technician-day-cancel"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
