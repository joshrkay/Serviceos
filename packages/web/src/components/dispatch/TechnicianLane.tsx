import React from 'react';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';

export interface TechnicianInfo {
  id: string;
  name: string;
}

export interface TechnicianLaneProps {
  technician: TechnicianInfo;
  appointments: AppointmentCardData[];
  onDropAppointment?: (appointmentId: string, technicianId: string, position: number) => void;
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
  isDragOver?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  /**
   * P6-020 — within-lane reorder affordance. When supplied, each card gets
   * up/down buttons that fire a reorder request (by appointment id, from
   * current index to the target index). The caller turns that into a
   * reschedule_appointment proposal via useCreateScheduleProposal.
   */
  onReorderWithinLane?: (appointmentId: string, fromIndex: number, toIndex: number) => void;
  /**
   * P6-026 — set of appointment ids that overlap another booking on
   * the same technician's lane. Computed by the DispatchBoard
   * parent and forwarded to each AppointmentCard so the conflict
   * badge renders. Optional — omitting it leaves cards quiet.
   * Cross-lane same-customer detection is tracked as a follow-up
   * (Codex PR #316 review).
   */
  conflictIds?: ReadonlySet<string>;
}

export function TechnicianLane({
  technician,
  appointments,
  onDragStart,
  isDragOver = false,
  onDragOver,
  onDragLeave,
  onDrop,
  onReorderWithinLane,
  conflictIds,
}: TechnicianLaneProps) {
  const sortedAppointments = [...appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()
  );

  return (
    <div
      className={`technician-lane ${isDragOver ? 'technician-lane--drag-over' : ''}`}
      data-testid="technician-lane"
      data-technician-id={technician.id}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="technician-lane__header" data-testid="technician-lane-header">
        <span className="technician-lane__name">{technician.name}</span>
        <span className="technician-lane__count" data-testid="technician-lane-count">
          {appointments.length}
        </span>
      </div>

      <div className="technician-lane__appointments" data-testid="technician-lane-appointments">
        {sortedAppointments.length === 0 ? (
          <div className="technician-lane__empty" data-testid="technician-lane-empty">
            No appointments
          </div>
        ) : (
          sortedAppointments.map((appointment, index) => (
            <div
              key={appointment.id}
              className="technician-lane__appointment-row"
              data-testid="technician-lane-appointment-row"
            >
              <AppointmentCard
                appointment={appointment}
                draggable={true}
                onDragStart={onDragStart}
                hasConflict={conflictIds?.has(appointment.id) ?? false}
              />
              {onReorderWithinLane && (
                <div
                  className="technician-lane__reorder-controls"
                  data-testid="lane-reorder-controls"
                >
                  <button
                    type="button"
                    data-testid="lane-reorder-up"
                    aria-label={`Move ${appointment.jobSummary ?? 'appointment'} earlier`}
                    disabled={index === 0}
                    onClick={() =>
                      onReorderWithinLane(appointment.id, index, Math.max(0, index - 1))
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-testid="lane-reorder-down"
                    aria-label={`Move ${appointment.jobSummary ?? 'appointment'} later`}
                    disabled={index === sortedAppointments.length - 1}
                    onClick={() =>
                      onReorderWithinLane(
                        appointment.id,
                        index,
                        Math.min(sortedAppointments.length - 1, index + 1)
                      )
                    }
                  >
                    ↓
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
