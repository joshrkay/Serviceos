import { useState, useEffect } from 'react';
import { X, Zap, Check } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { toast } from 'sonner';

interface PackActivation {
  packId: string;
  status: 'active' | 'deactivated';
}

const AVAILABLE_PACKS = [
  {
    id: 'hvac',
    label: 'HVAC',
    emoji: '❄️',
    description: 'Heating, ventilation & air conditioning service types',
    examples: ['AC repair', 'Furnace tune-up', 'Duct cleaning', 'Refrigerant recharge'],
  },
  {
    id: 'plumbing',
    label: 'Plumbing',
    emoji: '🔧',
    description: 'Plumbing installation, repair & maintenance service types',
    examples: ['Water heater replacement', 'Drain cleaning', 'Leak repair', 'Fixture installation'],
  },
];

export function VerticalPacksSheet({ onClose }: { onClose: () => void }) {
  const apiFetch = useApiClient();
  const [activePacks, setActivePacks] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings/packs');
        if (cancelled || !res.ok) return;
        const data = await res.json() as PackActivation[];
        const active = new Set(
          (Array.isArray(data) ? data : [])
            .filter(p => p.status === 'active')
            .map(p => p.packId)
        );
        if (!cancelled) setActivePacks(active);
      } catch {
        /* ignore — UI shows empty state */
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function togglePack(packId: string) {
    const isCurrentlyActive = activePacks.has(packId);
    setToggling(packId);
    try {
      if (isCurrentlyActive) {
        const res = await apiFetch(`/api/settings/packs/${packId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setActivePacks(prev => { const next = new Set(prev); next.delete(packId); return next; });
        toast.success(`${AVAILABLE_PACKS.find(p => p.id === packId)?.label ?? packId} pack deactivated`);
      } else {
        const res = await apiFetch(`/api/settings/packs/${packId}/activate`, { method: 'PUT' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setActivePacks(prev => new Set([...prev, packId]));
        toast.success(`${AVAILABLE_PACKS.find(p => p.id === packId)?.label ?? packId} pack activated`);
      }
    } catch {
      toast.error('Could not update pack. Please try again.');
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-label="Close" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 shrink-0">
          <div>
            <h2 className="text-slate-900">Vertical Packs</h2>
            <p className="text-xs text-slate-500 mt-0.5">Activate service verticals to unlock their service types.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Close">
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {isLoading ? (
            <p className="text-sm text-slate-500 py-8 text-center">Loading packs…</p>
          ) : (
            AVAILABLE_PACKS.map(pack => {
              const isActive = activePacks.has(pack.id);
              const isToggling = toggling === pack.id;
              return (
                <div
                  key={pack.id}
                  className={`rounded-2xl border p-4 transition-colors ${isActive ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">{pack.emoji}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-slate-900">{pack.label}</p>
                          {isActive && (
                            <span className="flex items-center gap-1 text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                              <Check size={10} /> Active
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{pack.description}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => void togglePack(pack.id)}
                      disabled={isToggling}
                      className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        isActive
                          ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-100'
                          : 'bg-slate-900 text-white hover:bg-slate-700'
                      }`}
                    >
                      {isToggling ? '…' : isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {pack.examples.map(ex => (
                      <span key={ex} className="text-xs rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-500">
                        {ex}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })
          )}

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-2 mb-1">
              <Zap size={13} className="text-amber-500" />
              <p className="text-xs text-slate-700">How packs work</p>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Activating a pack adds its service types to your job creation and intake forms. Deactivating removes them from new selections — existing jobs are not affected.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
