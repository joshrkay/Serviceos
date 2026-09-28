import { useState } from 'react';
import {
  Flame,
  Droplets,
  Zap,
  House,
  Paintbrush,
  Hammer,
  TreePine,
  Layers,
  Wrench,
  Loader2,
} from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import type { PackId, PackPickInput } from '../../../../types/onboarding';

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
  {
    id: 'electrical',
    name: 'Electrical',
    blurb: 'Wiring, panels, lighting, and troubleshooting.',
    includes: 'Job types, sample pricing, and message templates tuned for electrical work.',
    icon: <Zap size={20} />,
  },
  {
    id: 'roofing',
    name: 'Roofing',
    blurb: 'Inspections, repairs, and replacements.',
    includes: 'Job types, sample pricing, and message templates tuned for roofing.',
    icon: <House size={20} />,
  },
  {
    id: 'painting',
    name: 'Painting',
    blurb: 'Interior, exterior, and prep work.',
    includes: 'Job types, sample pricing, and message templates tuned for painting.',
    icon: <Paintbrush size={20} />,
  },
  {
    id: 'gc_remodel',
    name: 'Remodeling / GC',
    blurb: 'Kitchens, baths, and general contracting.',
    includes: 'Job types, sample pricing, and message templates tuned for remodelers.',
    icon: <Hammer size={20} />,
  },
  {
    id: 'landscaping',
    name: 'Landscaping',
    blurb: 'Lawn care, plantings, and irrigation.',
    includes: 'Job types, sample pricing, and message templates tuned for landscapers.',
    icon: <TreePine size={20} />,
  },
  {
    id: 'concrete',
    name: 'Concrete',
    blurb: 'Pours, repairs, and removal.',
    includes: 'Job types, sample pricing, and message templates tuned for concrete work.',
    icon: <Layers size={20} />,
  },
  {
    id: 'other',
    name: 'Something else',
    blurb: 'Another trade entirely.',
    includes: 'Sensible starter job types and pricing you can edit — plus your trade name on everything.',
    icon: <Wrench size={20} />,
  },
];

export function PackStep({ onSaved }: PackStepProps) {
  const apiFetch = useApiClient();
  const [pending, setPending] = useState<PackId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [tradeLabel, setTradeLabel] = useState('');

  async function pick(packId: PackId, label?: string) {
    setPending(packId);
    setError(null);
    try {
      const body: PackPickInput = { packId };
      const trimmed = label?.trim();
      if (trimmed) body.tradeLabel = trimmed;
      const res = await apiFetch('/api/onboarding/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Check your connection and try again.');
    } finally {
      setPending(null);
    }
  }

  function onPick(packId: PackId) {
    if (packId === 'other') {
      setOtherOpen(true);
      return;
    }
    void pick(packId);
  }

  const tradeLabelValid = tradeLabel.trim().length > 0;
  const disabled = pending !== null;

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Pick your trade</h1>
        <p className="text-sm text-slate-500 mt-2">
          We&apos;ll set you up with the right job types, sample pricing, and templates
          for your trade. You can add another later in Settings.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PACKS.map((pack) => {
          const isPending = pending === pack.id;
          return (
            <button
              key={pack.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(pack.id)}
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

      {otherOpen && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <label
            htmlFor="pack-trade-label"
            className="block text-sm font-medium text-slate-900"
          >
            What&apos;s your trade?
          </label>
          <p className="mt-1 text-sm text-slate-500">
            We&apos;ll set up starter job types and pricing under your trade&apos;s name.
          </p>
          <div className="mt-3 flex flex-col sm:flex-row gap-3">
            <input
              id="pack-trade-label"
              type="text"
              value={tradeLabel}
              onChange={(e) => setTradeLabel(e.target.value)}
              disabled={disabled}
              maxLength={80}
              placeholder="e.g. Pool service"
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              disabled={disabled || !tradeLabelValid}
              onClick={() => void pick('other', tradeLabel)}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-slate-700"
            >
              {pending === 'other' ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Setting things up…
                </span>
              ) : (
                'Set up my trade'
              )}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
