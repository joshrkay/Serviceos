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
}

export function TechnicianLane({
  technician,
  appointments,
  onDragStart,
  isDragOver = false,
  onDragOver,
  onDragLeave,
  onDrop,
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
          sortedAppointments.map((appointment) => (
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
