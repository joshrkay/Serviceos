import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { EstimateForm } from '../../components/estimates/EstimateForm';

export function EstimateCreate() {
  const navigate = useNavigate();
  // #876: quick actions deep-link here with ?customerId= (customer detail) or
  // ?jobId= (job sheets). Seed the form from the URL so the context survives
  // the navigation instead of landing on a blank form.
  const [searchParams] = useSearchParams();
  const initialCustomerId = searchParams.get('customerId') ?? undefined;
  const initialJobId = searchParams.get('jobId') ?? undefined;
  return (
    <EstimateForm
      initialCustomerId={initialCustomerId}
      initialJobId={initialJobId}
      onCreated={(_id) => navigate('/estimates')}
      onCancel={() => navigate('/estimates')}
    />
  );
}

export default EstimateCreate;
