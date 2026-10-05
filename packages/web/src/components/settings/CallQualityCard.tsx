import { useCallback, useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/** Mirrors GET /api/voice/quality (#1602). */
interface QualityWindow {
  graded: number;
  passed: number;
  passRate: number | null;
}
interface GradeCriterion {
  grader: 'floor' | 'disposition_llm' | 'perceived_completion';
  criterion: number;
  name: string;
  passed: boolean;
  rationale: string;
}
interface GradedCall {
  sessionId: string;
  gradedAt: string;
  passed: boolean;
  criteria: GradeCriterion[];
  model: string;
  trigger: 'nightly' | 'manual';
  callEndedAt: string;
  outcome: string | null;
}
interface CallQuality {
  windows: { last7d: QualityWindow; last30d: QualityWindow };
  gate: { passRateMin: number };
  quota: { sampleRatePct: number; dailyCap: number; gradedToday: number };
  recent: GradedCall[];
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The line the owner reads first for one graded call: why it failed, else why it passed. */
function headlineRationale(call: GradedCall): string {
  const failing = call.criteria.find((c) => !c.passed);
  if (failing) return failing.rationale;
  const perceived = call.criteria.find((c) => c.grader === 'perceived_completion');
  return (perceived ?? call.criteria[0])?.rationale ?? '';
}

/**
 * Production call quality on Settings: how many of the AI's real answered
 * calls, sampled and graded nightly by the same judges the CI harness uses,
 * passed in the last 7 / 30 days against the 85% launch gate — and the last
 * graded calls with the judge's one-line reason. The owner can grade a sample
 * now (the API enforces owner-only and the tenant's daily cap).
 */
export function CallQualityCard({ canManage }: { canManage: boolean }) {
  const [quality, setQuality] = useState<CallQuality | null>(null);
  const [grading, setGrading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      // Some embedders/tests pass a partial API adapter that returns
      // undefined for unknown endpoints; treat that as "nothing to show".
      const res = await Promise.resolve(apiFetch('/api/voice/quality'));
      if (!res?.ok) return;
      const body = (await res.json()) as Partial<CallQuality> | null;
      if (!body?.windows?.last7d || !body.windows.last30d || !body.gate || !body.quota) return;
      setQuality({ ...(body as CallQuality), recent: Array.isArray(body.recent) ? body.recent : [] });
    } catch {
      // Card stays hidden.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function gradeNow() {
    setGrading(true);
    try {
      const res = await apiFetch('/api/voice/quality/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(String(res.status));
      const run = (await res.json()) as { graded: number; skipped: number };
      toast.success(
        run.graded === 0
          ? 'No new calls to grade right now'
          : `Graded ${run.graded} call${run.graded === 1 ? '' : 's'}`,
      );
      await load();
    } catch {
      toast.error('Could not start grading');
    } finally {
      setGrading(false);
    }
  }

  if (!quality) return null;

  const { last7d, last30d } = quality.windows;
  const gatePct = pct(quality.gate.passRateMin);
  const nothingYet = last7d.graded === 0 && last30d.graded === 0;
  const belowGate = last7d.passRate !== null && last7d.passRate < quality.gate.passRateMin;

  const headline = nothingYet
    ? 'No calls graded yet'
    : last7d.graded === 0
      ? 'No calls graded in the last 7 days'
      : `${last7d.passed} of ${last7d.graded} graded calls passed in the last 7 days (${pct(last7d.passRate ?? 0)})`;
  const detail =
    last30d.graded === 0
      ? `Nothing graded in the last 30 days · gate ${gatePct}`
      : `${last30d.passed} of ${last30d.graded} passed in the last 30 days (${pct(last30d.passRate ?? 0)}) · gate ${gatePct}`;

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
          <Gauge size={14} className="text-slate-500" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-800">{headline}</p>
          <p className="text-xs text-slate-400 mt-0.5">{detail}</p>
        </div>
        {last7d.passRate !== null && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
              belowGate ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
            }`}
          >
            {belowGate ? `Below the ${gatePct} gate` : 'Meeting the gate'}
          </span>
        )}
      </div>

      {quality.recent.length > 0 && (
        <ul className="mt-3 border-t border-slate-100 divide-y divide-slate-100">
          {quality.recent.map((call) => (
            <li
              key={call.sessionId}
              data-testid="call-quality-row"
              className="flex flex-wrap items-start gap-x-2 gap-y-1 min-w-0 py-2"
            >
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  call.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}
              >
                {call.passed ? 'Passed' : 'Failed'}
              </span>
              <span className="text-xs text-slate-400 shrink-0">
                {new Date(call.callEndedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              <p className="basis-full text-xs text-slate-600 min-w-0 break-words">
                {headlineRationale(call)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-3 border-t border-slate-100 pt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={grading}
            onClick={() => void gradeNow()}
            className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
          >
            {grading ? 'Grading…' : 'Grade a sample now'}
          </button>
          <span className="text-xs text-slate-400 min-w-0">
            {quality.quota.gradedToday} of {quality.quota.dailyCap} graded today · samples{' '}
            {quality.quota.sampleRatePct}% of answered calls nightly
          </span>
        </div>
      )}
    </div>
  );
}
