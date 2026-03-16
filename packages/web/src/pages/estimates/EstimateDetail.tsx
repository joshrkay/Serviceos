import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxable: boolean;
}

interface Estimate {
  id: string;
  estimateNumber: string;
  status: string;
  jobId: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  lineItems: LineItem[];
  sourceType?: string;
  sourceReference?: string;
  approvalStatus?: string;
  rejectionReason?: string;
  createdAt: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface EstimateDetailProps {
  estimateId: string;
  onBack?: () => void;
}

export function EstimateDetail({ estimateId, onBack }: EstimateDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Estimate>('/api/estimates', estimateId);

  if (!data) {
    return <DetailPage title="Estimate" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  return (
    <DetailPage
      title={`Estimate ${data.estimateNumber}`}
      subtitle={`Status: ${data.status}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Edit', onClick: () => {}, variant: 'primary' },
        { label: 'Send', onClick: () => {}, variant: 'secondary' },
      ]}
      sections={[
        {
          title: 'Estimate Info',
          content: (
            <div>
              <p>Job: {data.jobId}</p>
              <p>Created: {new Date(data.createdAt).toLocaleDateString()}</p>
              {data.sourceType && <p>Source: {data.sourceType}</p>}
              {data.approvalStatus && <p>Approval: {data.approvalStatus}</p>}
              {data.rejectionReason && <p>Rejection Reason: {data.rejectionReason}</p>}
            </div>
          ),
        },
        {
          title: 'Line Items',
          content: (
            <table className="list-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit Price</th>
                  <th>Total</th>
                  <th>Taxable</th>
                </tr>
              </thead>
              <tbody>
                {(data.lineItems ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td>{formatCents(item.unitPriceCents)}</td>
                    <td>{formatCents(item.totalCents)}</td>
                    <td>{item.taxable ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
        },
        {
          title: 'Totals',
          content: (
            <div>
              <p>Subtotal: {formatCents(data.subtotalCents)}</p>
              <p>Discount: {formatCents(data.discountCents)}</p>
              <p>Tax: {formatCents(data.taxCents)}</p>
              <p><strong>Total: {formatCents(data.totalCents)}</strong></p>
            </div>
          ),
        },
      ]}
    />
  );
}
