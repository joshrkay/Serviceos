import { useState } from 'react';
import { Flame, Droplets, Loader2 } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import type { PackId } from '../../../../types/onboarding';

interface PackStepProps {
  onSaved: () => void;
}

interface PackOption {
  id: PackId;
  name: string;
  blurb: string;
  includes: string;
  icon: React.ReactNode;
}

const PACKS: PackOption[] = [
  {
    id: 'hvac',
    name: 'HVAC',
    blurb: 'Heating, cooling, and ventilation.',
    includes: 'Job types, sample pricing, and message templates tuned for HVAC.',
    icon: <Flame size={20} />,
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    blurb: 'Repairs, installs, leaks, and drains.',
    includes: 'Job types, sample pricing, and message templates tuned for plumbing.',
    icon: <Droplets size={20} />,
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
      setError(err instanceof Error ? err.message : 'Network error. Check your connection and try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Pick your trade</h1>
        <p className="text-sm text-slate-500 mt-2">
          We&apos;ll set you up with the right job types, sample pricing, and templates
          for your trade. You can add another later in Settings.
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
              className={`group text-left rounded-2xl border bg-white p-5 transition ${
                disabled
                  ? 'cursor-not-allowed opacity-60 border-slate-200'
                  : 'border-slate-200 hover:border-slate-900 hover:shadow-sm'
              }`}
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                {pack.icon}
              </div>
              <div className="mt-5 text-lg font-medium text-slate-900">{pack.name}</div>
              <div className="mt-1 text-sm text-slate-600">{pack.blurb}</div>
              <div className="mt-4 text-xs text-slate-500">{pack.includes}</div>
              {isPending && (
                <div className="mt-4 flex items-center gap-2 text-xs text-slate-700">
                  <Loader2 size={12} className="animate-spin" />
                  Setting things up…
                </div>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
