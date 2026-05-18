import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { toast } from 'sonner';

interface EscalationSettings {
  channel_sms: boolean;
  channel_in_app: boolean;
  channel_whisper: boolean;
  trigger_low_confidence: boolean;
  trigger_explicit_request: boolean;
  trigger_keyword_frustration: boolean;
  trigger_llm_sentiment: boolean;
  llm_sentiment_threshold: number;
}

const DEFAULTS: EscalationSettings = {
  channel_sms: true,
  channel_in_app: true,
  channel_whisper: true,
  trigger_low_confidence: true,
  trigger_explicit_request: true,
  trigger_keyword_frustration: true,
  trigger_llm_sentiment: false,
  llm_sentiment_threshold: 0.7,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CallRoutingSheet({ open, onOpenChange }: Props) {
  const [settings, setSettings] = useState<EscalationSettings>(DEFAULTS);
  const updateSeqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (cancelled || !res.ok) return;
        const data = await res.json() as { escalationSettings?: Partial<EscalationSettings> };
        if (!cancelled) {
          setSettings({ ...DEFAULTS, ...(data.escalationSettings ?? {}) });
        }
      } catch {
        // ignore — defaults
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function update(patch: Partial<EscalationSettings>) {
    const prevSettings = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    const seq = ++updateSeqRef.current;
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalationSettings: next }),
      });
      if (!res.ok) throw new Error(`PUT /api/settings ${res.status}`);
    } catch {
      // Only roll back if this is still the most recent update attempt.
      if (seq === updateSeqRef.current) {
        toast.error('Could not save preference');
        setSettings(prevSettings);
      }
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="absolute right-0 top-0 h-full w-96 bg-white shadow-2xl p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Call Routing &amp; Handoff</h2>

        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">Where dispatcher gets context</h3>
          {(
            [
              ['channel_whisper', "Whisper in dispatcher's ear when they answer"],
              ['channel_sms', 'SMS to dispatcher\'s phone'],
              ['channel_in_app', 'In-app overlay panel'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 py-1.5">
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(e) => void update({ [key]: e.target.checked })}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </section>

        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">When AI hands off</h3>
          {(
            [
              ['trigger_low_confidence', 'Sustained low confidence (baseline, always on)'],
              ['trigger_explicit_request', '"Talk to a human" / operator request'],
              ['trigger_keyword_frustration', 'Frustration keywords ("this is ridiculous", etc.)'],
              ['trigger_llm_sentiment', 'AI sentiment classifier (opt-in, adds per-turn cost)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 py-1.5">
              <input
                type="checkbox"
                checked={settings[key]}
                disabled={key === 'trigger_low_confidence'}
                onChange={(e) => void update({ [key]: e.target.checked })}
              />
              <span className={`text-sm ${key === 'trigger_low_confidence' ? 'text-gray-400' : ''}`}>{label}</span>
            </label>
          ))}
        </section>

        {settings.trigger_llm_sentiment && (
          <section className="mb-6">
            <label className="block text-sm font-medium mb-1">Sentiment escalation threshold</label>
            <input
              type="range"
              min="0.4"
              max="0.9"
              step="0.05"
              value={settings.llm_sentiment_threshold}
              onChange={(e) => void update({ llm_sentiment_threshold: parseFloat(e.target.value) })}
              className="w-full"
            />
            <div className="text-xs text-gray-500">
              Current: {settings.llm_sentiment_threshold.toFixed(2)} — higher = fewer escalations.
            </div>
          </section>
        )}

        <button
          onClick={() => onOpenChange(false)}
          className="w-full py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm"
        >
          Close
        </button>
      </div>
    </div>
  );
}
