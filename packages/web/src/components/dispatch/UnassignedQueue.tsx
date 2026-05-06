import React from 'react';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';

export interface UnassignedQueueProps {
  appointments: AppointmentCardData[];
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
  /** P6-025 — drop target props. Drops here become `cancel_assignment` proposals. */
  isDragOver?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  /** P6-026 — conflicting appointment ids; forwarded to AppointmentCard. */
  conflictIds?: ReadonlySet<string>;
}

export function UnassignedQueue({
  appointments,
  onDragStart,
  isDragOver = false,
  onDragOver,
  onDragLeave,
  onDrop,
  conflictIds,
}: UnassignedQueueProps) {
  return (
    <div
      className={`unassigned-queue ${isDragOver ? 'unassigned-queue--drag-over' : ''}`}
      data-testid="unassigned-queue"
      data-drop-kind="unassigned"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="unassigned-queue__header" data-testid="unassigned-queue-header">
        <h3>Unassigned</h3>
        <span className="unassigned-queue__count" data-testid="unassigned-queue-count">
          {appointments.length}
        </span>
      </div>

      <div className="unassigned-queue__list" data-testid="unassigned-queue-list">
        {appointments.length === 0 ? (
          <div className="unassigned-queue__empty" data-testid="unassigned-queue-empty">
            All appointments assigned
          </div>
        ) : (
          appointments.map((appointment) => (
            <AppointmentCard
              key={appointment.id}
              appointment={appointment}
              draggable={true}
              onDragStart={onDragStart}
              hasConflict={conflictIds?.has(appointment.id) ?? false}
            />
          ))
        )}
      </div>
    </div>
  );
}
