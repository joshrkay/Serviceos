import React from 'react';
import { useNavigate } from 'react-router';
import { JobForm } from '../../components/jobs/JobForm';

export function JobCreate() {
  const navigate = useNavigate();
  return (
    <JobForm
      onCreated={(id) => navigate(`/jobs/${id}`)}
      onCancel={() => navigate('/jobs')}
    />
  );
}

export default JobCreate;
