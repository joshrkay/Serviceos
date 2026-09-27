import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { InvoiceForm } from '../../components/invoices/InvoiceForm';

export function InvoiceCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return (
    <InvoiceForm
      initialJobId={searchParams.get('jobId') ?? undefined}
      onCreated={(_id) => navigate('/invoices')}
      onCancel={() => navigate('/invoices')}
    />
  );
}

export default InvoiceCreate;
