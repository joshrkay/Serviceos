import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

/**
 * P4-015 — Brand voice settings (register, sign-off, banned phrases).
 */
export function BrandVoiceSection() {
  const apiFetch = useApiClient();
  const [signOff, setSignOff] = useState('');
  const [bannedPhrases, setBannedPhrases] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch('/api/settings')
      .then((res) => res.json())
      .then((data: { brandVoice?: { signOff?: string; bannedPhrases?: string[] } }) => {
        const bv = data.brandVoice ?? {};
        setSignOff(bv.signOff ?? '');
        setBannedPhrases((bv.bannedPhrases ?? []).join('\n'));
      })
      .catch(() => setStatus('Could not load brand voice settings.'));
  }, [apiFetch]);

  async function save() {
    setStatus(null);
    const phrases = bannedPhrases
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    const res = await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brandVoice: {
          signOff,
          bannedPhrases: phrases,
        },
      }),
    });
    setStatus(res.ok ? 'Saved.' : 'Save failed.');
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Brand voice</h2>
      <label className="block text-xs text-slate-600">
        Sign-off
        <input
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          value={signOff}
          onChange={(e) => setSignOff(e.target.value)}
        />
      </label>
      <label className="block text-xs text-slate-600">
        Banned phrases (one per line)
        <textarea
          className="mt-1 w-full min-h-[88px] rounded-lg border border-slate-200 px-3 py-2 text-sm"
          value={bannedPhrases}
          onChange={(e) => setBannedPhrases(e.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => void save()}
        className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm text-white"
      >
        Save brand voice
      </button>
      {status ? <p className="text-xs text-slate-500">{status}</p> : null}
    </section>
  );
}
