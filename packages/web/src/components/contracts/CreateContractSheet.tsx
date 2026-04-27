import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useMutation } from '../../hooks/useMutation';

interface ApiContract {
  id: string;
}

interface CreateContractRequest {
  customer: string;
  location: string;
  title: string;
  cadence: string;
  serviceWindow: string;
  duration: string;
  defaultSummary: string;
  startDate: string;
}

export function CreateContractSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (contract: ApiContract) => void;
}) {
  const { mutate: createContract, isLoading, error } = useMutation<CreateContractRequest, ApiContract>(
    'POST',
    '/api/maintenance-contracts'
  );

  const [form, setForm] = useState<CreateContractRequest>({
    customer: '',
    location: '',
    title: '',
    cadence: 'Monthly',
    serviceWindow: '',
    duration: '12 months',
    defaultSummary: '',
    startDate: '',
  });

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const contract = await createContract(form);
      onCreated?.(contract);
      onClose();
      setForm({
        customer: '',
        location: '',
        title: '',
        cadence: 'Monthly',
        serviceWindow: '',
        duration: '12 months',
        defaultSummary: '',
        startDate: '',
      });
    } catch {
      // Hook-managed error state is shown in the sheet; keep it open for correction/retry.
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-label="Close" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-slate-900">New Maintenance Contract</h2>
              <p className="text-xs text-slate-500 mt-0.5">Create a recurring service agreement.</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Close sheet">
              <X size={16} className="text-slate-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {[
              ['Customer', 'customer', 'Customer name'],
              ['Location', 'location', 'Service address'],
              ['Title', 'title', 'e.g., Premium HVAC Plan'],
              ['Cadence', 'cadence', 'Monthly'],
              ['Service Window', 'serviceWindow', 'Mon-Fri, 8am-12pm'],
              ['Duration', 'duration', '12 months'],
              ['Default Summary', 'defaultSummary', 'Include tune-up + filter change'],
              ['Start Date', 'startDate', ''],
            ].map(([label, key, placeholder]) => (
              <label key={key} className="block">
                <span className="block text-xs text-slate-500 mb-1.5">{label}</span>
                {key === 'defaultSummary' ? (
                  <textarea
                    value={form[key as keyof CreateContractRequest]}
                    onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                    rows={4}
                    placeholder={placeholder}
                  />
                ) : (
                  <input
                    type={key === 'startDate' ? 'date' : 'text'}
                    value={form[key as keyof CreateContractRequest]}
                    onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                    placeholder={placeholder}
                    required={key === 'customer' || key === 'location' || key === 'title' || key === 'startDate'}
                  />
                )}
              </label>
            ))}
            {error && <p className="text-sm text-red-500">Failed to create contract: {error}</p>}
          </div>

          <div className="border-t border-slate-200 px-5 py-4 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {isLoading ? 'Creating…' : 'Create Contract'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
