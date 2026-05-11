import { useParams } from 'react-router';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';

interface MaintenanceContract {
  id: string;
  title: string;
  status?: string;
  cadence?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
}

interface RelatedJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  scheduledStart?: string;
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: contract, isLoading, error } = useDetailQuery<MaintenanceContract>(
    '/api/maintenance-contracts',
    id ?? null
  );
  const { data: jobs } = useListQuery<RelatedJob>('/api/jobs', {
    filters: { contractId: id ?? '' },
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-red-600">{error}</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900 mb-1">{contract?.title ?? 'Contract Detail'}</h1>
      <p className="text-sm text-slate-500 mb-5">Contract ID: {id ?? 'Unknown'}</p>

      {contract && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100">
            {[
              { label: 'Status', value: contract.status ?? 'active' },
              { label: 'Cadence', value: contract.cadence ?? '—' },
              { label: 'Service window', value: contract.serviceWindow ?? '—' },
              { label: 'Duration', value: contract.duration ?? '—' },
              { label: 'Start date', value: contract.startDate ?? '—' },
              { label: 'End date', value: contract.endDate ?? 'Open-ended' },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between px-4 py-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-sm text-slate-800 capitalize">{value}</p>
              </div>
            ))}
          </div>

          {jobs && jobs.length > 0 && (
            <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-sm text-slate-700">Related jobs</p>
              </div>
              <div className="divide-y divide-slate-100">
                {jobs.map(job => (
                  <div key={job.id} className="flex items-center justify-between px-4 py-3">
                    <p className="text-sm text-slate-600">#{job.jobNumber} — {job.summary}</p>
                    <p className="text-xs text-slate-400 capitalize">{job.status}</p>
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
