import React from 'react';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';
import type { FeasibilityResult } from './feasibility-types';

export interface TechnicianInfo {
  id: string;
  name: string;
}

export interface DragPreview {
  targetTechnicianId: string;
  preview: FeasibilityResult | null;
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
  onReorderWithinLane?: (appointmentId: string, fromIndex: number, toIndex: number) => void;
  conflictIds?: ReadonlySet<string>;
  /**
   * Live feasibility preview for an in-flight drag. When this lane is the
   * drop target and a preview has resolved, the drop zone takes on a
   * colored state (blocking=red, warnings-only=amber, clean=green).
   */
  dragPreview?: DragPreview | null;
}

function dropZoneStateClass(dragPreview: DragPreview | null | undefined, technicianId: string): string {
  if (!dragPreview || dragPreview.targetTechnicianId !== technicianId || !dragPreview.preview) {
    return 'drop-zone--idle';
  }
  const { preview } = dragPreview;
  if (!preview.feasible) return 'drop-zone--blocking';
  if (preview.warnings.length > 0) return 'drop-zone--warning';
  return 'drop-zone--ok';
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
  dragPreview,
}: TechnicianLaneProps) {
  const sortedAppointments = [...appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()
  );

  const dropZoneClass = dropZoneStateClass(dragPreview, technician.id);

  return (
    <div
      className={`technician-lane ${isDragOver ? 'technician-lane--drag-over' : ''} ${dropZoneClass}`}
      data-testid="technician-lane"
      data-technician-id={technician.id}
      data-drop-zone-state={dropZoneClass}
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
