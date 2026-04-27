import { useParams } from 'react-router';

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
  const navigate = useNavigate();
  const contractId = id ?? null;
  const canLoad = Boolean(contractId);

  const {
    data: contract,
    isLoading,
    error,
    refetch: refetchContract,
  } = useDetailQuery<ApiContract>('/api/maintenance-contracts', contractId);

  const {
    data: jobs,
    isLoading: jobsLoading,
    error: jobsError,
  } = useListQuery<ApiJob>('/api/jobs', {
    filters: contractId ? { contractId } : {},
    enabled: canLoad,
  });

  const { mutate: updateStatus, isLoading: isUpdating, error: updateError } =
    useMutation<{ status: 'paused' | 'canceled' }, ApiContract>(
      'PATCH',
      contractId ? `/api/maintenance-contracts/${contractId}/status` : '/api/maintenance-contracts/unknown/status',
    );

  const statusClass = useMemo(() => {
    switch ((contract?.status ?? '').toLowerCase()) {
      case 'active': return 'bg-green-100 text-green-700';
      case 'paused': return 'bg-amber-100 text-amber-700';
      case 'canceled': return 'bg-red-100 text-red-700';
      default: return 'bg-slate-100 text-slate-600';
    }
  }, [contract?.status]);

  async function handleStatusChange(status: 'paused' | 'canceled') {
    if (!contractId) return;
    try {
      await updateStatus({ status });
      refetchContract();
    } catch {
      // handled by useMutation error state
    }
  }

  if (!contractId) return <div className="p-6 text-sm text-slate-500">Missing contract id.</div>;
  if (isLoading) return <div className="p-6 text-sm text-slate-500">Loading contract…</div>;
  if (error) return <div className="p-6 text-sm text-red-600">Failed to load contract.</div>;
  if (!contract) return <div className="p-6 text-sm text-slate-500">Contract not found.</div>;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft size={16} /> Back
      </button>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl text-slate-900">{contract.title}</h1>
            <p className="text-sm text-slate-500">Maintenance contract #{contract.id}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs ${statusClass}`}>{contract.status ?? 'Unknown'}</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div><p className="text-slate-400">Cadence</p><p className="text-slate-800">{contract.cadence ?? '—'}</p></div>
          <div><p className="text-slate-400">Service window</p><p className="text-slate-800">{contract.serviceWindow ?? '—'}</p></div>
          <div><p className="text-slate-400">Duration</p><p className="text-slate-800">{contract.duration ?? '—'}</p></div>
          <div><p className="text-slate-400">Start date</p><p className="text-slate-800">{formatDate(contract.startDate)}</p></div>
          <div><p className="text-slate-400">End date</p><p className="text-slate-800">{formatDate(contract.endDate)}</p></div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={() => handleStatusChange('paused')}
            disabled={isUpdating || (contract.status ?? '').toLowerCase() === 'paused'}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 disabled:opacity-50"
          >
            <PauseCircle size={15} /> Pause
          </button>
          <button
            onClick={() => handleStatusChange('canceled')}
            disabled={isUpdating || (contract.status ?? '').toLowerCase() === 'canceled'}
            className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 disabled:opacity-50"
          >
            <XCircle size={15} /> Cancel
          </button>
          {updateError ? <p className="text-sm text-red-600">{updateError}</p> : null}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-slate-900">Generated jobs</h2>
          <Link to="/jobs" className="text-sm text-blue-600 hover:underline">View jobs</Link>
        </div>

        {jobsLoading ? <p className="text-sm text-slate-500">Loading jobs…</p> : null}
        {jobsError ? <p className="text-sm text-red-600">Failed to load jobs.</p> : null}
        {!jobsLoading && !jobsError && jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
            No generated jobs yet.
          </div>
        ) : null}

        {!jobsLoading && !jobsError && jobs.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {jobs.map(job => (
              <li key={job.id} className="py-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-slate-900">{job.jobNumber ?? job.id}</p>
                  <p className="text-xs text-slate-500">{job.summary ?? 'Service visit'}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-600">{job.status ?? '—'}</p>
                  <p className="text-xs text-slate-400">{formatDate(job.scheduledStart)}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
