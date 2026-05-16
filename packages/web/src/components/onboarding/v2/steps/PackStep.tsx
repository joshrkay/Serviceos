import { useState } from 'react';
import { useApiClient } from '../../../../lib/apiClient';
import type { PackId } from '../../../../types/onboarding';

interface PackStepProps {
  onSaved: () => void;
}

interface PackOption {
  id: PackId;
  name: string;
  blurb: string;
  stats: string;
}

const PACKS: PackOption[] = [
  {
    id: 'hvac',
    name: 'HVAC',
    blurb: 'Heating, cooling, and ventilation.',
    stats: '12 job types · 40 line items · 18 message templates',
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    blurb: 'Repairs, installs, leaks, and drains.',
    stats: '14 job types · 36 line items · 16 message templates',
  },
];

export function PackStep({ onSaved }: PackStepProps) {
  const apiFetch = useApiClient();
  const [pending, setPending] = useState<PackId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(packId: PackId) {
    setPending(packId);
    setError(null);
    try {
      const res = await apiFetch('/api/onboarding/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Pick your trade</h1>
        <p className="text-sm text-slate-500 mt-1">
          We'll set up job types, pricing, and message templates for you. You can add another trade later in Settings.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PACKS.map((pack) => {
          const isPending = pending === pack.id;
          const disabled = pending !== null;
          return (
            <button
              key={pack.id}
              type="button"
              disabled={disabled}
              onClick={() => void pick(pack.id)}
              className={`text-left border rounded-lg p-5 transition ${
                disabled
                  ? 'opacity-50 cursor-not-allowed border-slate-200'
                  : 'border-slate-200 hover:border-blue-500 hover:shadow-sm'
              }`}
            >
              <div className="text-lg font-semibold text-slate-900">{pack.name}</div>
              <div className="text-sm text-slate-600 mt-1">{pack.blurb}</div>
              <div className="text-xs text-slate-500 mt-4">{pack.stats}</div>
              {isPending && (
                <div className="text-xs text-blue-600 mt-3">Activating…</div>
              )}
            </button>
          );
        })}
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
    </div>
  );
}
