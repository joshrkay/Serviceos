/**
 * P22-005 (U7) — `lookup_job_profit` voice skill.
 *
 * Owner asks "Did I make money on the <job>?" → speaks a per-job P&L:
 * revenue, materials, labor (hours), and the resulting margin. The job is
 * resolved to a concrete `jobId` upstream (entity resolver) before this skill
 * runs — same contract as `lookup_balance`, which takes a resolved `customerId`.
 *
 * Tenant-scoped, read-only. Bypasses the proposals pipeline. The math lives in
 * jobs/job-profit.ts (`getJobProfit`); this skill only reads the tenant labor
 * rate and formats the answer for TTS.
 *
 * Honest degradation: when no labor rate is set the spoken answer says so
 * explicitly ("not counting your labor rate — set one in settings") rather
 * than silently reporting a margin that ignores labor.
 */
import {
  getJobProfit,
  type GetJobProfitDeps,
  type JobProfit,
} from '../../jobs/job-profit';
import type { JobRepository } from '../../jobs/job';
import type { SettingsRepository } from '../../settings/settings';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { formatUsdCentsPlain } from '@ai-service-os/shared';

export interface LookupJobProfitInput {
  tenantId: string;
  /** Concrete job id, resolved upstream by the entity resolver. */
  jobId: string;
  sessionId?: string;
}

export interface LookupJobProfitDeps {
  jobRepo: JobRepository;
  settingsRepo: SettingsRepository;
  invoiceRepo: GetJobProfitDeps['invoiceRepo'];
  timeEntryRepo: GetJobProfitDeps['timeEntryRepo'];
  expenseRepo: GetJobProfitDeps['expenseRepo'];
  /** Optional materials resolver (P14); defaults to 0 inside getJobProfit. */
  materialsResolver?: GetJobProfitDeps['materialsResolver'];
  lookupEvents?: LookupEventService;
}

export type LookupJobProfitResult =
  | {
      status: 'found';
      summary: string;
      data: JobProfit & { jobId: string };
    }
  | { status: 'not_found'; summary: string; data: { jobId: string } }
  | { status: 'error'; summary: string; data: { error: string } };

/** TTS money formatter for job-profit prose. Always emits a positive-magnitude
 *  amount — spoken losses read better as "lost $40" than "-$40.00", so the
 *  caller phrases the sign. Delegates the terse `$N.NN` formatting to the
 *  shared `formatUsdCentsPlain`. */
function formatCents(cents: number): string {
  return formatUsdCentsPlain(Math.abs(cents));
}

/** Whole-ish hours for speech: "3 hours", "1 hour", "1.5 hours". */
function formatHours(minutes: number): string {
  const hours = minutes / 60;
  // One decimal, then drop a trailing ".0" so "3.0" speaks as "3".
  const rounded = Math.round(hours * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'hour' : 'hours'}`;
}

/**
 * Build the spoken summary. Kept pure + exported so the skill test can assert
 * grammaticality (incl. the negative-margin and unpriced-labor cases) without
 * standing up repos.
 */
export function formatJobProfitSummary(jobLabel: string, profit: JobProfit): string {
  const parts: string[] = [];
  parts.push(
    profit.revenueCents > 0
      ? `The ${jobLabel} brought in ${formatCents(profit.revenueCents)}`
      : `The ${jobLabel} hasn't brought in any revenue yet`,
  );

  // Costs clause — only mention the cost lines that exist so the sentence
  // stays natural ("you spent $320 on materials and 3 hours of labor").
  const costClauses: string[] = [];
  if (profit.materialsCents > 0) {
    costClauses.push(`${formatCents(profit.materialsCents)} on materials`);
  }
  if (profit.expensesCents > 0) {
    costClauses.push(`${formatCents(profit.expensesCents)} in expenses`);
  }
  if (profit.laborMinutes > 0) {
    costClauses.push(
      profit.laborUnpriced
        ? `${formatHours(profit.laborMinutes)} of labor`
        : `${formatHours(profit.laborMinutes)} of labor (${formatCents(profit.laborCents ?? 0)})`,
    );
  }
  if (costClauses.length > 0) {
    const joined =
      costClauses.length === 1
        ? costClauses[0]
        : `${costClauses.slice(0, -1).join(', ')} and ${costClauses[costClauses.length - 1]}`;
    parts.push(`you spent ${joined}`);
  }

  // Margin clause — sign-aware so a loss reads honestly.
  let marginClause: string;
  if (profit.marginCents >= 0) {
    marginClause = `about ${formatCents(profit.marginCents)} margin`;
  } else {
    marginClause = `a loss of about ${formatCents(profit.marginCents)}`;
  }
  if (profit.marginPct !== null) {
    marginClause += ` (${profit.marginPct}%)`;
  }
  parts.push(marginClause);

  let summary = `${parts.join('; ')}.`;
  if (profit.laborUnpriced) {
    summary += " That's not counting your labor rate — set one in settings to include it.";
  }
  return summary;
}

export async function lookupJobProfit(
  input: LookupJobProfitInput,
  deps: LookupJobProfitDeps,
): Promise<LookupJobProfitResult> {
  const start = Date.now();
  const recordEvent = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_job_profit',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an event-write failure must never break the TTS turn */
    }
  };

  try {
    const job = await deps.jobRepo.findById(input.tenantId, input.jobId);
    if (!job) {
      const summary = "I couldn't find that job.";
      await recordEvent('none', 0, summary);
      return { status: 'not_found', summary, data: { jobId: input.jobId } };
    }

    const settings = await deps.settingsRepo.findByTenant(input.tenantId);
    const profit = await getJobProfit(
      {
        tenantId: input.tenantId,
        jobId: input.jobId,
        laborRateCentsPerHour: settings?.laborRateCentsPerHour ?? null,
      },
      {
        invoiceRepo: deps.invoiceRepo,
        timeEntryRepo: deps.timeEntryRepo,
        expenseRepo: deps.expenseRepo,
        ...(deps.materialsResolver ? { materialsResolver: deps.materialsResolver } : {}),
      },
    );

    // Prefer the customer-y "Miller job" phrasing the owner used; fall back to
    // the job number. The job summary is the human label closest to "the
    // Miller job" we have without a second customer lookup.
    const jobLabel = job.summary?.trim() ? `${job.summary.trim()} job` : `${job.jobNumber} job`;
    const summary = formatJobProfitSummary(jobLabel, profit);
    await recordEvent('found', 1, summary);
    return { status: 'found', summary, data: { ...profit, jobId: input.jobId } };
  } catch (err) {
    const summary = "I'm having trouble pulling up that job's numbers right now.";
    await recordEvent('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
