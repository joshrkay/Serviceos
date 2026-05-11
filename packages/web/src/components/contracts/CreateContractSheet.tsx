import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useMutation } from '../../hooks/useMutation';

interface ApiMaintenanceContract {
  id: string;
}

interface CreateMaintenanceContractRequest {
  title: string;
  cadence: string;
  startDate?: string;
}

const CADENCE_OPTIONS = [
  { label: 'Monthly', value: 'Monthly' },
  { label: 'Quarterly', value: 'Quarterly' },
  { label: 'Yearly', value: 'Yearly' },
];

const EMPTY_FORM = {
  title: '',
  cadence: 'Monthly',
  startDate: '',
};

export function CreateContractSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (contract: ApiMaintenanceContract) => void;
}) {
  const { mutate: createContract, isLoading, error } = useMutation<CreateMaintenanceContractRequest, ApiMaintenanceContract>(
    'POST',
    '/api/maintenance-contracts'
  );

  const [form, setForm] = useState(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!open) return null;

  function setField(key: keyof typeof EMPTY_FORM, value: string | boolean) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!form.title.trim()) {
      setValidationError('Contract title is required.');
      return;
    }

    try {
      const contract = await createContract({
        title: form.title.trim(),
        cadence: form.cadence,
        startDate: form.startDate || undefined,
      });
      onCreated?.(contract);
      onClose();
      setForm(EMPTY_FORM);
    } catch {
      // Hook-managed error state shown in the sheet; keep open for correction/retry.
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
            {/* Contract title */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Contract title *</span>
              <input
                type="text"
                required
                value={form.title}
                onChange={e => setField('title', e.target.value)}
                placeholder="e.g., Premium HVAC Plan"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {/* Cadence */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Cadence *</span>
              <select
                value={form.cadence}
                onChange={e => setField('cadence', e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 bg-white"
              >
                {CADENCE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>

            {/* Start date */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Start date</span>
              <input
                type="date"
                value={form.startDate}
                onChange={e => setField('startDate', e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {validationError && <p className="text-sm text-red-500">{validationError}</p>}
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
