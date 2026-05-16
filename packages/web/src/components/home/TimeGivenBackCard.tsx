import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

interface TimeGivenBackReceipt {
  callsAnswered: number;
  proposalsHandled: number;
  byProposalType: Record<string, number>;
}

interface TimeGivenBackSummary {
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  totalHours: number;
  dollarValueCents: number | null;
  receipt: TimeGivenBackReceipt;
  creditVersion: string;
}

function formatHours(hours: number): string {
  if (hours === 0) return '0 hours';
  if (hours === 1) return '1 hour';
  return `${hours} hours`;
}

function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

export function TimeGivenBackCard() {
  const apiFetch = useApiClient();
  const [summary, setSummary] = useState<TimeGivenBackSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/reports/time-given-back')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as TimeGivenBackSummary);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // A widget failure must never break the home screen — render nothing.
  if (failed) return null;

  if (isLoading) {
    return (
      <div className="mx-4 md:mx-6 mt-4 h-20 rounded-xl bg-slate-100 animate-pulse" />
    );
  }

  if (!summary) return null;

  const { totalHours, dollarValueCents, receipt } = summary;
  const headline =
    dollarValueCents != null
      ? `${formatHours(totalHours)} given back ≈ ${formatDollars(dollarValueCents)}`
      : `${formatHours(totalHours)} given back`;

  const receiptParts: string[] = [];
  if (receipt.callsAnswered > 0) {
    receiptParts.push(
      `${receipt.callsAnswered} call${receipt.callsAnswered === 1 ? '' : 's'} answered`,
    );
  }
  if (receipt.proposalsHandled > 0) {
    receiptParts.push(
      `${receipt.proposalsHandled} action${receipt.proposalsHandled === 1 ? '' : 's'} handled for you`,
    );
  }

  return (
    <div className="mx-4 md:mx-6 mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3.5">
      <p className="text-xs text-blue-600 uppercase tracking-wide">This week</p>
      <p className="text-xl font-semibold text-blue-900 mt-1">{headline}</p>
      {receiptParts.length > 0 ? (
        <p className="text-sm text-blue-700 mt-1">{receiptParts.join(' · ')}</p>
      ) : (
        <p className="text-sm text-blue-700/70 mt-1">
          Your time-saved tally will grow as the AI handles calls and work for you.
        </p>
      )}
      {dollarValueCents == null && totalHours > 0 && (
        <p className="text-xs text-blue-600/70 mt-1">
          Set your hourly rate in Settings to see the dollar value.
        </p>
      )}
    </div>
  );
}
