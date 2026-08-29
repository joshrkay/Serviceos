import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { JobForm } from '../../components/jobs/JobForm';

export function JobCreate() {
  const navigate = useNavigate();
  // #878: the customer-detail "Schedule" quick action deep-links here as
  // /jobs/new?customerId=…. Seed the form from the URL so the picker arrives
  // pre-filled instead of empty.
  const [searchParams] = useSearchParams();
  const initialCustomerId = searchParams.get('customerId') ?? undefined;
  return (
    <JobForm
      initialCustomerId={initialCustomerId}
      onCreated={(id) => navigate(`/jobs/${id}`)}
      onCancel={() => navigate('/jobs')}
    />
  );
}

export default JobCreate;
