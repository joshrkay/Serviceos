import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useMutation } from '../../hooks/useMutation';
import { CustomerPicker, type CustomerOption } from '../forms/CustomerPicker';

interface ApiAgreement {
  id: string;
}

interface CreateAgreementRequest {
  customerId: string;
  name: string;
  description?: string;
  recurrenceRule: string;
  priceCents: number;
  startsOn: string;
  autoGenerateJob?: boolean;
  autoGenerateInvoice?: boolean;
}

const RECURRENCE_OPTIONS = [
  { label: 'Monthly', value: 'FREQ=MONTHLY' },
  { label: 'Quarterly', value: 'FREQ=QUARTERLY' },
  { label: 'Yearly', value: 'FREQ=YEARLY' },
];

const EMPTY_FORM = {
  name: '',
  description: '',
  recurrenceRule: 'FREQ=MONTHLY',
  priceDisplay: '',
  startsOn: '',
  autoGenerateJob: true,
  autoGenerateInvoice: false,
};

export function CreateContractSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (contract: ApiAgreement) => void;
}) {
  const { mutate: createAgreement, isLoading, error } = useMutation<CreateAgreementRequest, ApiAgreement>(
    'POST',
    '/api/agreements'
  );

  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!open) return null;

  function setField(key: keyof typeof EMPTY_FORM, value: string | boolean) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!customer) {
      setValidationError('Please select a customer.');
      return;
    }
    if (!form.startsOn) {
      setValidationError('Start date is required.');
      return;
    }

    const priceCents = Math.round(parseFloat(form.priceDisplay || '0') * 100);
    if (isNaN(priceCents) || priceCents < 0) {
      setValidationError('Price must be a valid non-negative number.');
      return;
    }

    try {
      const agreement = await createAgreement({
        customerId: customer.id,
        name: form.name,
        description: form.description || undefined,
        recurrenceRule: form.recurrenceRule,
        priceCents,
        startsOn: form.startsOn,
        autoGenerateJob: form.autoGenerateJob,
        autoGenerateInvoice: form.autoGenerateInvoice,
      });
      onCreated?.(agreement);
      onClose();
      setCustomer(null);
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
            {/* Customer selector */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Customer *</span>
              <CustomerPicker value={customer} onChange={setCustomer} required />
            </label>

            {/* Contract name */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Contract name *</span>
              <input
                type="text"
                required
                value={form.name}
                onChange={e => setField('name', e.target.value)}
                placeholder="e.g., Premium HVAC Plan"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {/* Description */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Description</span>
              <textarea
                value={form.description}
                onChange={e => setField('description', e.target.value)}
                placeholder="Include tune-up + filter change"
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {/* Recurrence */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Cadence *</span>
              <select
                value={form.recurrenceRule}
                onChange={e => setField('recurrenceRule', e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 bg-white"
              >
                {RECURRENCE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>

            {/* Price */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Price per period ($)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.priceDisplay}
                onChange={e => setField('priceDisplay', e.target.value)}
                placeholder="0.00"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {/* Start date */}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1.5">Start date *</span>
              <input
                type="date"
                required
                value={form.startsOn}
                onChange={e => setField('startsOn', e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </label>

            {/* Automation toggles */}
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
              {[
                { key: 'autoGenerateJob' as const, label: 'Auto-generate jobs', description: 'Create a job on each recurrence' },
                { key: 'autoGenerateInvoice' as const, label: 'Auto-generate invoices', description: 'Create an invoice on each recurrence' },
              ].map(({ key, label, description }) => (
                <div key={key} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setField(key, !form[key])}
                    className={`relative shrink-0 mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors ${form[key] ? 'bg-blue-600' : 'bg-slate-200'}`}
                  >
                    <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${form[key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              ))}
            </div>

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
