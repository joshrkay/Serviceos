import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { CommunicationTimeline } from '../../components/customers/CommunicationTimeline';

interface Customer {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  email?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  preferredChannel: string;
  isArchived: boolean;
}

interface CustomerDetailProps {
  customerId: string;
  onBack?: () => void;
}

export function CustomerDetail({ customerId, onBack }: CustomerDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>('/api/customers', customerId);

  if (!data) {
    return (
      <DetailPage
        title="Customer"
        sections={[]}
        isLoading={isLoading}
        error={error}
        onBack={onBack}
        onRetry={refetch}
      />
    );
  }

  return (
    <DetailPage
      title={data.displayName}
      subtitle={data.companyName}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Edit', onClick: () => {}, variant: 'primary' },
        { label: data.isArchived ? 'Restore' : 'Archive', onClick: () => {}, variant: 'danger' },
      ]}
      sections={[
        {
          title: 'Contact Information',
          content: (
            <div>
              <p>Email: {data.email || 'N/A'}</p>
              <p>Phone: {data.primaryPhone || 'N/A'}</p>
              <p>Secondary: {data.secondaryPhone || 'N/A'}</p>
              <p>Preferred: {data.preferredChannel}</p>
            </div>
          ),
        },
        // P9-002 — unified activity timeline. Read-only aggregator across
        // notes, jobs, estimates, invoices, payments, conversations, and
        // appointments. Renders an empty state when the customer has zero
        // activity, so we always include this section.
        {
          title: 'Activity',
          content: <CommunicationTimeline customerId={customerId} />,
        },
      ]}
    />
  );
}
