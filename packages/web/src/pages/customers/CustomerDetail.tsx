import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { CommunicationTimeline } from '../../components/customers/CommunicationTimeline';
import { LanguageBadge } from '../../components/customers/LanguageBadge';

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
  /** P11-002: optional spoken-language preference. */
  preferredLanguage?: 'en' | 'es' | null;
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
              {/* P11-002: surface the customer's spoken-language preference
                  so dispatchers can route Spanish callers correctly. The
                  badge renders nothing when no preference is set. */}
              <p className="flex items-center gap-2">
                <span>Language:</span>
                <LanguageBadge language={data.preferredLanguage ?? null} />
                <label className="ml-2 text-xs">
                  <span className="sr-only">Edit preferred language</span>
                  <select
                    aria-label="Preferred language"
                    defaultValue={data.preferredLanguage ?? ''}
                    className="rounded border px-1 py-0.5 text-xs"
                  >
                    <option value="">—</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </select>
                </label>
              </p>
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
