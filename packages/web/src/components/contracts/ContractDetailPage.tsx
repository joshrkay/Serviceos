import { useParams } from 'react-router';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';

interface MaintenanceContract {
  id: string;
  title: string;
  cadence?: string;
  status?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
}

interface ContractJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  scheduledStart?: string;
}

export function ContractDetailPage() {
  const { id } = useParams();

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900">Contract Detail</h1>
      <p className="text-sm text-slate-500 mt-1">Contract ID: {id}</p>
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, PauseCircle, XCircle } from 'lucide-react';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';

interface ApiContract {
  id: string;
  title: string;
  cadence?: string;
  status?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
}

interface ApiJob {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
  scheduledStart?: string;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: contract, isLoading, error } = useDetailQuery<MaintenanceContract>(
    '/api/maintenance-contracts',
    id ?? null
  );
  const { data: jobs = [] } = useListQuery<ContractJob>('/api/jobs', {
    filters: { contractId: id ?? '' },
    enabled: !!id,
  }) ?? {};

  if (isLoading) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-slate-500">Loading...</div>;
  }
  if (error) {
    return <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-red-600">{error}</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900">{contract?.title ?? 'Contract Detail'}</h1>
      <p className="text-sm text-slate-500 mt-1">Contract ID: {id ?? 'Unknown'}</p>
      {jobs.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Generated jobs</h2>
          <ul className="space-y-1">
            {jobs.map(job => (
              <li key={job.id} className="text-sm text-slate-600">
                {job.jobNumber} — {job.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
