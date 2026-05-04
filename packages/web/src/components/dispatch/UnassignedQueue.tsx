import React from 'react';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';

export interface UnassignedQueueProps {
  appointments: AppointmentCardData[];
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
}

export function UnassignedQueue({ appointments, onDragStart }: UnassignedQueueProps) {
  return (
    <div className="unassigned-queue" data-testid="unassigned-queue">
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
            />
          ))
        )}
      </div>
    </div>
  );
}
