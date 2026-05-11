import { useParams } from 'react-router';
import { useDetailQuery } from '../../hooks/useDetailQuery';

interface Agreement {
  id: string;
  name: string;
  customerId?: string;
  locationId?: string;
  description?: string;
  recurrenceRule?: string;
  priceCents?: number;
  status?: string;
  startsOn?: string;
  endsOn?: string;
  autoGenerateJob?: boolean;
  autoGenerateInvoice?: boolean;
  recentRuns?: Array<{ id: string; status: string; ranAt: string }>;
}

function recurrenceLabel(rule?: string): string {
  if (!rule) return 'No cadence';
  if (rule.includes('FREQ=MONTHLY')) return 'Monthly';
  if (rule.includes('FREQ=QUARTERLY')) return 'Quarterly';
  if (rule.includes('FREQ=YEARLY')) return 'Yearly';
  return rule;
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agreement, isLoading, error } = useDetailQuery<Agreement>(
    '/api/agreements',
    id ?? null
  );

  if (isLoading) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-red-600">{error}</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900 mb-1">{agreement?.name ?? 'Contract Detail'}</h1>
      <p className="text-sm text-slate-500 mb-5">Contract ID: {id ?? 'Unknown'}</p>

      {agreement && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100">
            {[
              { label: 'Status', value: agreement.status ?? 'active' },
              { label: 'Plan', value: recurrenceLabel(agreement.recurrenceRule) },
              { label: 'Price', value: agreement.priceCents !== undefined ? `$${(agreement.priceCents / 100).toFixed(2)}/period` : '—' },
              { label: 'Starts', value: agreement.startsOn ?? '—' },
              { label: 'Ends', value: agreement.endsOn ?? 'Open-ended' },
              { label: 'Auto-generate jobs', value: agreement.autoGenerateJob ? 'Yes' : 'No' },
              { label: 'Auto-generate invoices', value: agreement.autoGenerateInvoice ? 'Yes' : 'No' },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between px-4 py-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-sm text-slate-800 capitalize">{value}</p>
              </div>
            ))}
            {agreement.description && (
              <div className="px-4 py-3">
                <p className="text-xs text-slate-500 mb-1">Description</p>
                <p className="text-sm text-slate-700 leading-relaxed">{agreement.description}</p>
              </div>
            )}
          </div>

          {agreement.recentRuns && agreement.recentRuns.length > 0 && (
            <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-sm text-slate-700">Recent runs</p>
              </div>
              <div className="divide-y divide-slate-100">
                {agreement.recentRuns.map(run => (
                  <div key={run.id} className="flex items-center justify-between px-4 py-3">
                    <p className="text-sm text-slate-600">{run.status}</p>
                    <p className="text-xs text-slate-400">{run.ranAt ? new Date(run.ranAt).toLocaleDateString() : '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
