import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Phone,
  PhoneIncoming,
  CalendarCheck,
  Moon,
  Voicemail,
  ArrowRight,
} from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { StatCard } from '../ui';

/**
 * Epic 12.5 — Voice ROI card.
 *
 * The pilot's primary ROI headline: how many calls the agent answered that
 * would otherwise have rolled to voicemail, plus the supporting breakdown
 * (inbound / answered / booked / after-hours). Reads
 * GET /api/analytics/voice-roi (rolling 30-day window).
 *
 * Like the HFCR hero, it never flashes a broken state: it renders nothing
 * while loading or on error, and shows an onboarding payoff (not a deflating
 * row of zeros) until the first inbound call lands.
 */
interface VoiceRoiSummary {
  windowStart: string;
  windowEnd: string;
  inboundCalls: number;
  answeredCalls: number;
  bookedByAgent: number;
  afterHoursCaptures: number;
  wouldHaveHitVoicemail: number;
  answerRate: number;
}

export function VoiceRoiCard() {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<VoiceRoiSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch('/api/analytics/voice-roi?days=30')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as VoiceRoiSummary);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // Never show a broken/loading ROI band — the number is the point.
  if (isLoading || error || !summary) return null;

  const {
    inboundCalls,
    answeredCalls,
    bookedByAgent,
    afterHoursCaptures,
    wouldHaveHitVoicemail,
  } = summary;

  if (inboundCalls === 0) {
    // Onboarding payoff: frame the first answered call rather than show zeros.
    return (
      <section data-testid="voice-roi" className="px-4 md:px-6 py-5 border-b border-slate-100">
        <div className="rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/60 px-5 py-5">
          <p className="text-xs font-medium uppercase tracking-wide text-indigo-700 flex items-center gap-1.5">
            <PhoneIncoming size={13} /> Voice ROI
          </p>
          <p className="mt-1.5 text-sm text-indigo-800">
            Every call your agent answers — while you're on a job or after hours —
            will show up here, starting with the first one it catches.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="voice-roi" className="px-4 md:px-6 py-5 border-b border-slate-100">
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-700 px-5 py-5 text-white">
        <p className="text-xs font-medium uppercase tracking-wide text-indigo-100 flex items-center gap-1.5">
          <Voicemail size={13} /> Calls saved from voicemail · last 30 days
        </p>
        <p
          data-testid="voice-roi-headline"
          className="mt-1.5 text-3xl font-semibold tabular-nums break-words"
        >
          {wouldHaveHitVoicemail}
        </p>
        <p className="mt-1 text-sm text-indigo-50">
          {wouldHaveHitVoicemail > 0
            ? `Answered by your agent instead of going to voicemail${
                afterHoursCaptures > 0 ? ` · ${afterHoursCaptures} after hours` : ''
              }.`
            : `${answeredCalls} of ${inboundCalls} inbound calls answered.`}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          tone="info"
          label="Inbound calls"
          value={inboundCalls}
          hint="last 30 days"
          icon={<Phone size={16} />}
        />
        <StatCard
          tone="success"
          label="Answered"
          value={answeredCalls}
          hint={`${Math.round(summary.answerRate * 100)}% answer rate`}
          icon={<PhoneIncoming size={16} />}
        />
        <StatCard
          tone="info"
          label="Booked by agent"
          value={bookedByAgent}
          hint="appointments"
          icon={<CalendarCheck size={16} />}
        />
        <StatCard
          tone="warning"
          label="After hours"
          value={afterHoursCaptures}
          hint="off-hours catches"
          icon={<Moon size={16} />}
        />
      </div>

      <button
        type="button"
        onClick={() => navigate('/interactions')}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-blue-600 transition-colors hover:border-slate-300 hover:text-blue-700"
      >
        View call log <ArrowRight size={13} />
      </button>
    </section>
  );
}
