import React from 'react';
import { useNavigate } from 'react-router';
import { EstimateForm } from '../../components/estimates/EstimateForm';

export function EstimateCreate() {
  const navigate = useNavigate();
  return (
    <EstimateForm
      onCreated={(_id) => navigate('/estimates')}
      onCancel={() => navigate('/estimates')}
    />
  );
}

export default EstimateCreate;
