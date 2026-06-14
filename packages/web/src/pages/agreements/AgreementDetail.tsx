/**
 * P9-003 — AgreementDetail page.
 *
 * Displays an agreement, its recent runs, and pause/resume/cancel actions.
 * The "Run Now" button is gated to owner-role users (the API enforces the
 * actual permission; we just hide the affordance from non-owners).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useApiClient } from '../../lib/apiClient';
import {
  agreementsApi,
  AgreementWithRuns,
} from '../../api/agreements';
import { AgreementRunsList } from '../../components/agreements/AgreementRunsList';

export interface AgreementDetailProps {
  agreementId: string;
  /** Authenticated user's role; controls visibility of "Run Now". */
  role?: string;
  onBack?: () => void;
}

export function AgreementDetail({
  agreementId,
  role,
  onBack,
}: AgreementDetailProps): JSX.Element {
  const apiFetch = useApiClient();
  const [data, setData] = useState<AgreementWithRuns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await agreementsApi.get(apiFetch, agreementId);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [apiFetch, agreementId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="p-4">
        {error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <p>Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-blue-600"
            aria-label="Back"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-semibold">{data.name}</h1>
          <p className="text-sm text-gray-600">{data.recurrenceRule}</p>
        </div>
        <div className="flex gap-2">
          {data.status === 'active' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => action(() => agreementsApi.pause(apiFetch, data.id))}
              className="bg-yellow-500 text-white rounded px-3 py-1 disabled:opacity-50"
            >
              Pause
            </button>
          )}
          {data.status === 'paused' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => action(() => agreementsApi.resume(apiFetch, data.id))}
              className="bg-green-600 text-white rounded px-3 py-1 disabled:opacity-50"
            >
              Resume
            </button>
          )}
          {data.status !== 'cancelled' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => action(() => agreementsApi.cancel(apiFetch, data.id))}
              className="bg-red-600 text-white rounded px-3 py-1 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {role === 'owner' && data.status === 'active' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => action(() => agreementsApi.runNow(apiFetch, data.id))}
              className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50"
              data-testid="run-now"
            >
              Run Now
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}

      <section className="text-sm text-gray-700 space-y-1">
        <p>
          <span className="font-medium">Term:</span> {data.startsOn}
          {data.endsOn ? ` → ${data.endsOn}` : ' (no end date)'}
        </p>
        <p data-testid="auto-renew-status">
          <span className="font-medium">Auto-renew:</span>{' '}
          {data.autoRenew
            ? `every ${data.renewalTermMonths} months${
                data.renewalCount ? ` · renewed ${data.renewalCount}×` : ''
              }`
            : 'off'}
        </p>
        {data.memberDiscountBps ? (
          <p data-testid="member-discount">
            <span className="font-medium">Member discount:</span>{' '}
            {data.memberDiscountBps / 100}% off this member&apos;s estimates
          </p>
        ) : null}
        {data.priorityBooking ? (
          <p data-testid="priority-booking">
            <span className="font-medium">Priority booking:</span> can self-schedule further out
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Recent runs</h2>
        <AgreementRunsList runs={data.recentRuns} />
      </section>
    </div>
  );
}
