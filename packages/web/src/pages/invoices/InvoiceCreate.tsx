import React from 'react';
import { useNavigate } from 'react-router';
import { InvoiceForm } from '../../components/invoices/InvoiceForm';

export function InvoiceCreate() {
  const navigate = useNavigate();
  return (
    <InvoiceForm
      onCreated={(id) => navigate(`/invoices/${id}`)}
      onCancel={() => navigate('/invoices')}
    />
  );
}

export default InvoiceCreate;
