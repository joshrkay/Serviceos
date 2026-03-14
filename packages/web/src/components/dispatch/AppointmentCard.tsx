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
  paymentIndicator?: string;
}

export interface AppointmentCardProps {
  appointment: AppointmentCardData;
  isDragging?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
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
}: AppointmentCardProps) {
  const arrivalWindow = formatArrivalWindow(
    appointment.arrivalWindowStart,
    appointment.arrivalWindowEnd
  );

  return (
    <div
      className={`appointment-card ${isDragging ? 'appointment-card--dragging' : ''}`}
      data-testid="appointment-card"
      data-appointment-id={appointment.id}
      draggable={draggable}
      onDragStart={(e) => onDragStart?.(e, appointment.id)}
    >
      <div className="appointment-card__header">
        <span className="appointment-card__time" data-testid="appointment-time">
          {formatTime(appointment.scheduledStart)} - {formatTime(appointment.scheduledEnd)}
        </span>
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
