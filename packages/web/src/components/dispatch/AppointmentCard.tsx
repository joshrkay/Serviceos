import React from 'react';

export interface AppointmentCardData {
  id: string;
  jobId: string;
  customerName: string;
  locationAddress: string;
  jobSummary: string;
  technicianName?: string;
  scheduledStart: string;
  scheduledEnd: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  status: string;
  holdPendingApproval?: boolean;
  holdExpiryAt?: string;
  paymentIndicator?: string;
  /** Optimistic-concurrency token — server's appointment.updatedAt ISO string. */
  updatedAt?: string;
}

export interface AppointmentCardProps {
  appointment: AppointmentCardData;
  isDragging?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
  /**
   * P6-026 — when true, the card renders a "Conflict" badge to signal
   * the appointment overlaps another booking on the same technician's
   * lane. Computed in the parent (DispatchBoard) so the card stays
   * presentational. Optional: omitting it preserves the pre-P6-026
   * quiet card.
   *
   * Codex P2 (PR #316): the conflict scope is technician-only by
   * design today — the card payload doesn't carry `customerId` and
   * cross-lane same-customer detection needs that field plumbed
   * through. Tracked as a follow-up.
   */
  hasConflict?: boolean;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatArrivalWindow(start?: string, end?: string): string | null {
  if (!start || !end) return null;
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'scheduled': return 'appointment-card__status--scheduled';
    case 'confirmed': return 'appointment-card__status--confirmed';
    case 'in_progress': return 'appointment-card__status--in-progress';
    case 'completed': return 'appointment-card__status--completed';
    case 'canceled': return 'appointment-card__status--canceled';
    case 'no_show': return 'appointment-card__status--no-show';
    default: return '';
  }
}

export function AppointmentCard({
  appointment,
  isDragging = false,
  draggable = false,
  onDragStart,
  hasConflict = false,
}: AppointmentCardProps) {
  const arrivalWindow = formatArrivalWindow(
    appointment.arrivalWindowStart,
    appointment.arrivalWindowEnd
  );

  const isHold = appointment.holdPendingApproval === true;
  let holdExpiryLabel: string | null = null;
  if (isHold && appointment.holdExpiryAt) {
    const ms = new Date(appointment.holdExpiryAt).getTime() - Date.now();
    if (ms > 0) {
      const hours = Math.floor(ms / (60 * 60 * 1000));
      holdExpiryLabel =
        hours < 2 ? 'Hold expires soon' : `Hold · ${hours}h left`;
    } else {
      holdExpiryLabel = 'Hold expired';
    }
  }

  return (
    <div
      className={`appointment-card ${isDragging ? 'appointment-card--dragging' : ''} ${
        hasConflict ? 'appointment-card--conflict' : ''
      } ${isHold ? 'border-dashed border-amber-400 bg-amber-50/80' : ''}`}
      data-testid="appointment-card"
      data-appointment-id={appointment.id}
      data-has-conflict={hasConflict ? 'true' : 'false'}
      draggable={draggable}
      onDragStart={(e) => onDragStart?.(e, appointment.id)}
    >
      <div className="appointment-card__header">
        <span className="appointment-card__time" data-testid="appointment-time">
          {formatTime(appointment.scheduledStart)} - {formatTime(appointment.scheduledEnd)}
        </span>
        {isHold && (
          <span
            className="appointment-card__badge text-xs font-medium text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded"
            data-testid="appointment-hold-badge"
          >
            {holdExpiryLabel ?? 'Tentative hold'}
          </span>
        )}
        {hasConflict && (
          <span
            className="appointment-card__badge appointment-card__badge--conflict"
            data-testid="appointment-conflict-badge"
            role="status"
            aria-label="Scheduling conflict"
            title="This appointment overlaps another booking"
          >
            Conflict
          </span>
        )}
        <span
          className={`appointment-card__status ${getStatusClass(appointment.status)}`}
          data-testid="appointment-status"
        >
          {appointment.status.replace('_', ' ')}
        </span>
      </div>

      <div className="appointment-card__customer" data-testid="appointment-customer">
        {appointment.customerName}
      </div>

      <div className="appointment-card__location" data-testid="appointment-location">
        {appointment.locationAddress}
      </div>

      <div className="appointment-card__summary" data-testid="appointment-summary">
        {appointment.jobSummary}
      </div>

      {appointment.technicianName && (
        <div className="appointment-card__technician" data-testid="appointment-technician">
          {appointment.technicianName}
        </div>
      )}

      {arrivalWindow && (
        <div className="appointment-card__arrival" data-testid="appointment-arrival">
          Arrival: {arrivalWindow}
        </div>
      )}

      {appointment.paymentIndicator && (
        <div className="appointment-card__payment" data-testid="appointment-payment">
          {appointment.paymentIndicator}
        </div>
      )}
    </div>
  );
}
