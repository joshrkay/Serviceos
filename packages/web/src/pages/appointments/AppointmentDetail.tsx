import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';

interface TechnicianAssignment {
  technicianId: string;
  technicianName?: string;
  isPrimary: boolean;
}

interface Appointment {
  id: string;
  jobId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  timezone: string;
  notes?: string;
  assignments: TechnicianAssignment[];
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface AppointmentDetailProps {
  appointmentId: string;
  onBack?: () => void;
}

export function AppointmentDetail({ appointmentId, onBack }: AppointmentDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Appointment>('/api/appointments', appointmentId);

  if (!data) {
    return <DetailPage title="Appointment" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  return (
    <DetailPage
      title={`Appointment — ${data.status}`}
      subtitle={`Job: ${data.jobId}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Reschedule', onClick: () => {}, variant: 'primary' },
        { label: 'Cancel', onClick: () => {}, variant: 'danger' },
      ]}
      sections={[
        {
          title: 'Schedule',
          content: (
            <div>
              <p>Start: {formatDateTime(data.scheduledStart)}</p>
              <p>End: {formatDateTime(data.scheduledEnd)}</p>
              <p>Timezone: {data.timezone}</p>
            </div>
          ),
        },
        {
          title: 'Arrival Window',
          content: (
            <div>
              {data.arrivalWindowStart && data.arrivalWindowEnd ? (
                <>
                  <p>From: {formatDateTime(data.arrivalWindowStart)}</p>
                  <p>To: {formatDateTime(data.arrivalWindowEnd)}</p>
                </>
              ) : (
                <p>No arrival window set.</p>
              )}
            </div>
          ),
        },
        {
          title: 'Assigned Technicians',
          content: (data.assignments ?? []).length === 0 ? (
            <p>No technicians assigned.</p>
          ) : (
            <ul>
              {(data.assignments ?? []).map((a) => (
                <li key={a.technicianId}>
                  {a.technicianName || a.technicianId}
                  {a.isPrimary ? ' (Primary)' : ''}
                </li>
              ))}
            </ul>
          ),
        },
        ...(data.notes ? [{
          title: 'Notes',
          content: <p>{data.notes}</p>,
        }] : []),
      ]}
    />
  );
}
