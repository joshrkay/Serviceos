import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, ChevronRight } from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { CreateContractSheet } from './CreateContractSheet';

export interface ApiContract {
  id: string;
  title: string;
  status?: string;
  customer?: { displayName?: string; firstName?: string; lastName?: string };
  location?: { street1?: string };
  cadence?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
}

function normalizeStatus(status?: string): 'Active' | 'Paused' | 'Cancelled' {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'paused') return 'Paused';
  if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
  return 'Active';
}

export function MaintenanceContractsPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const { data, total, isLoading, error, refetch } = useListQuery<ApiContract>('/api/maintenance-contracts');

  const normalized = useMemo(() => data.map(c => ({ ...c, uiStatus: normalizeStatus(c.status) })), [data]);
  const active = normalized.filter(c => c.uiStatus === 'Active').length;
  const paused = normalized.filter(c => c.uiStatus === 'Paused').length;
  const cancelled = normalized.filter(c => c.uiStatus === 'Cancelled').length;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="p-4 md:p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-slate-900">Maintenance Contracts</h1>
            <p className="text-xs text-slate-400 mt-0.5">{total} contract{total === 1 ? '' : 's'}</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3.5 py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            <Plus size={14} /> + New Contract
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            { label: 'Active', value: active, color: 'text-green-600', bg: 'bg-green-50 border-green-100' },
            { label: 'Paused', value: paused, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-100' },
            { label: 'Cancelled', value: cancelled, color: 'text-slate-600', bg: 'bg-slate-50 border-slate-100' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border px-2.5 py-2.5 ${bg}`}>
              <p className={`text-lg leading-none ${color}`}>{value}</p>
              <p className="text-xs text-slate-400 mt-1">{label}</p>
            </div>
          ))}
        </div>

        {isLoading && <div className="py-16 text-center text-sm text-slate-500">Loading contracts…</div>}
        {error && (
          <div className="py-16 text-center">
            <p className="text-sm text-red-500">Failed to load contracts</p>
            <button onClick={refetch} className="text-xs text-blue-500 hover:underline mt-2">Retry</button>
          </div>
        )}

        {!isLoading && !error && (
          <div className="flex flex-col gap-2">
            {normalized.map(contract => {
              const customerName = contract.customer
                ? contract.customer.displayName || [contract.customer.firstName, contract.customer.lastName].filter(Boolean).join(' ') || 'Customer'
                : 'Customer';
              return (
                <button
                  key={contract.id}
                  onClick={() => navigate(`/contracts/${contract.id}`)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-left hover:border-slate-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 truncate">{contract.title || 'Untitled contract'}</p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">{customerName} • {contract.location?.street1 || 'No location'}</p>
                    </div>
                    <span className="text-xs rounded-full px-2 py-0.5 bg-slate-100 text-slate-600">{contract.uiStatus}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{contract.cadence || 'No cadence'} • {contract.serviceWindow || 'No service window'}</span>
                    <span className="inline-flex items-center gap-1 text-slate-400">View <ChevronRight size={14} /></span>
                  </div>
                </button>
              );
            })}
            {normalized.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center">
                <p className="text-sm text-slate-500">No contracts yet</p>
              </div>
            )}
          </div>
        )}
      </div>

      <CreateContractSheet open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => refetch()} />
    </div>
  );
}
