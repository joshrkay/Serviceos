import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Calendar, Check } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { trackFunnel } from '../../../lib/analytics';
import { Button } from '../../ui';

interface CalendarChoicePanelProps {
  tenantId: string | null;
  /** Called after a provider is chosen (so the parent can refetch status). */
  onChosen?: () => void;
}

/**
 * Feature 5 — calendar connection. Offers Google Calendar (OAuth) or the
 * built-in ServiceOS scheduler (skip path). Records the choice via
 * POST /api/onboarding/calendar/choose and fires wizard_step_calendar.
 *
 * For Google, the choice is recorded and the existing connect flow is kicked
 * off (GET /api/calendar-integrations/google/connect → redirect). Built-in
 * just records the provider and moves on.
 */
export function CalendarChoicePanel({ tenantId, onChosen }: CalendarChoicePanelProps) {
  const apiFetch = useApiClient();
  const { userId } = useAuth();
  const [pending, setPending] = useState<null | 'google' | 'builtin'>(null);
  const [chosen, setChosen] = useState<null | 'google' | 'builtin'>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(provider: 'google' | 'builtin') {
    setPending(provider);
    setError(null);
    try {
      const res = await apiFetch('/api/onboarding/calendar/choose', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        setError(`Couldn't save your choice (HTTP ${res.status}).`);
        return;
      }
      trackFunnel('wizard_step_calendar', { tenantId, userId }, { provider });
      setChosen(provider);
      onChosen?.();

      if (provider === 'google') {
        // Kick off the existing Google Calendar OAuth connect flow.
        try {
          const conn = await apiFetch('/api/calendar-integrations/google/connect', { method: 'POST' });
          if (conn.ok) {
            const body = (await conn.json()) as { url?: string };
            if (body.url) window.location.href = body.url;
          }
        } catch {
          // The provider is recorded; the user can connect from settings later.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4 text-left">
      <div className="flex items-center gap-2">
        <Calendar size={16} className="text-slate-700" />
        <h2 className="text-sm font-semibold text-slate-900">Connect your calendar</h2>
      </div>
      <p className="text-xs text-slate-500">
        Sync availability so the AI books real appointments — or use the built-in scheduler.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          size="sm"
          loading={pending === 'google'}
          onClick={() => void choose('google')}
        >
          {chosen === 'google' ? 'Connecting…' : 'Connect Google Calendar'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          loading={pending === 'builtin'}
          onClick={() => void choose('builtin')}
        >
          {chosen === 'builtin' ? (
            <span className="inline-flex items-center gap-1">
              <Check size={14} /> Using built-in
            </span>
          ) : (
            'Use built-in calendar'
          )}
        </Button>
      </div>
    </div>
  );
}
