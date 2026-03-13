import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';

interface Job {
  id: string;
  jobNumber: string;
  summary: string;
  problemDescription?: string;
  status: string;
  priority: string;
}

interface JobDetailProps {
  jobId: string;
  onBack?: () => void;
}

export function JobDetail({ jobId, onBack }: JobDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Job>('/api/jobs', jobId);

  if (!data) {
    return <DetailPage title="Job" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  return (
    <DetailPage
      title={`${data.jobNumber} — ${data.summary}`}
      subtitle={`Status: ${data.status} | Priority: ${data.priority}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      sections={[
        {
          title: 'Details',
          content: (
            <div>
              <p>Problem: {data.problemDescription || 'N/A'}</p>
            </div>
          ),
        },
      ]}
    />
  );
}
