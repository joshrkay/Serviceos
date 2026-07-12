import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';

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

interface AppointmentDetailProps {
  appointmentId: string;
  onBack?: () => void;
}

export function AppointmentDetail({ appointmentId, onBack }: AppointmentDetailProps) {
  // CLAUDE.md: "stored UTC, rendered in tenant timezone". Format every
  // instant through the tenant tz (sourced from /api/me) rather than the
  // viewer's browser-local zone, which would show a dispatcher a different
  // wall-clock (and often a different day) than the tenant sees.
  const timezone = useTenantTimezone();
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
              <p>Start: {formatDateTimeInTenantTz(data.scheduledStart, timezone)}</p>
              <p>End: {formatDateTimeInTenantTz(data.scheduledEnd, timezone)}</p>
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
                  <p>From: {formatDateTimeInTenantTz(data.arrivalWindowStart, timezone)}</p>
                  <p>To: {formatDateTimeInTenantTz(data.arrivalWindowEnd, timezone)}</p>
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
