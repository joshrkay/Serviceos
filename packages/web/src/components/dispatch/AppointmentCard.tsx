import React from 'react';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatTimeInTenantTz } from '../../utils/formatInTenantTz';

export interface AppointmentEditingInfo {
  userId: string;
  displayName: string;
  mode: 'viewing' | 'dragging';
}

export interface CoAssignee {
  technicianId: string;
  technicianName: string;
}

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
  editing?: AppointmentEditingInfo | null;
  /** Non-primary (crew) technicians on this appointment. */
  coAssignees?: CoAssignee[];
  /**
   * A customer-initiated cancel/reschedule is awaiting dispatcher
   * confirmation. Drives the "change requested" badge.
   */
  pendingChange?: 'cancel' | 'reschedule';
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
  /** Current Clerk user — hides own presence chip. */
  currentUserId?: string;
  /** When provided, renders an "Add crew" affordance that opens the crew picker. */
  onAddCrew?: (appointmentId: string) => void;
  /** When provided, renders a remove control on each co-assignee badge. */
  onRemoveCoAssignee?: (appointmentId: string, technicianId: string) => void;
}

// Journey QA 2026-07-02 (bug 4) — dispatch rendered times in the BROWSER tz
// while the schedule page rendered tenant tz, so the same appointment showed
// two different times. Core pattern: stored UTC, rendered in TENANT tz.
function formatTime(iso: string, tz: string): string {
  return formatTimeInTenantTz(iso, tz);
}

function formatArrivalWindow(tz: string, start?: string, end?: string): string | null {
  if (!start || !end) return null;
  return `${formatTime(start, tz)} - ${formatTime(end, tz)}`;
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
  currentUserId,
  onAddCrew,
  onRemoveCoAssignee,
}: AppointmentCardProps) {
  const tz = useTenantTimezone();
  const coAssignees = appointment.coAssignees ?? [];
  const editing =
    appointment.editing &&
    appointment.editing.mode === 'dragging' &&
    appointment.editing.userId !== currentUserId
      ? appointment.editing
      : null;
  const arrivalWindow = formatArrivalWindow(
    tz,
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
          {formatTime(appointment.scheduledStart, tz)} - {formatTime(appointment.scheduledEnd, tz)}
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
        {appointment.pendingChange && (
          <span
            className="appointment-card__badge text-xs font-medium text-violet-800 bg-violet-100 px-1.5 py-0.5 rounded"
            data-testid="appointment-pending-change-badge"
            role="status"
            aria-label={
              appointment.pendingChange === 'cancel'
                ? 'Cancellation requested by customer'
                : 'Reschedule requested by customer'
            }
            title="Customer requested a change — awaiting your confirmation"
          >
            {appointment.pendingChange === 'cancel' ? 'Cancel requested' : 'Reschedule requested'}
          </span>
        )}
        <span
          className={`appointment-card__status ${getStatusClass(appointment.status)}`}
          data-testid="appointment-status"
        >
          {appointment.status.replace('_', ' ')}
        </span>
      </div>

      {editing && (
        <div
          className="appointment-card__editing-chip text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 mb-1"
          data-testid="appointment-editing-chip"
        >
          {editing.displayName} is moving this
        </div>
      )}

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

      {(coAssignees.length > 0 || onAddCrew) && (
        <div className="appointment-card__crew flex flex-wrap items-center gap-1" data-testid="appointment-crew">
          {coAssignees.map((c) => (
            <span
              key={c.technicianId}
              className="appointment-card__crew-badge inline-flex items-center gap-1 text-xs text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded"
              data-testid="appointment-coassignee-badge"
            >
              {c.technicianName}
              {onRemoveCoAssignee && (
                <button
                  type="button"
                  className="appointment-card__crew-remove text-slate-400 hover:text-red-600"
                  data-testid="appointment-coassignee-remove"
                  aria-label={`Remove ${c.technicianName} from crew`}
                  onClick={() => onRemoveCoAssignee(appointment.id, c.technicianId)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {onAddCrew && (
            <button
              type="button"
              className="appointment-card__crew-add text-xs text-blue-600 hover:text-blue-800"
              data-testid="appointment-add-crew"
              aria-label="Add crew member"
              onClick={() => onAddCrew(appointment.id)}
            >
              + crew
            </button>
          )}
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
