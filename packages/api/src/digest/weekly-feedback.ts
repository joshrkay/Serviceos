/**
 * Epic 12.6 — Weekly feedback (performance snapshot + suggestions).
 *
 * Extends the digest surface from the daily end-of-day SMS to a weekly owner
 * EMAIL that turns the platform from a tool into an advisor: a performance
 * snapshot plus a few suggestions (wins, misses, and one or two actions).
 *
 * This file owns the *pure* parts — the snapshot shape, the deterministic
 * suggestion engine (always available), and the LLM prompt/parse for the
 * optional gateway-generated suggestions. The builder (DB) and worker
 * (delivery) compose these. Suggestions are advisory text only: nothing here
 * executes — the no-auto-execute invariant is preserved.
 */

export interface WeeklyFeedbackSnapshot {
  weekStartIso: string;
  weekEndIso: string;
  /** Net payments received in the week (integer cents). */
  revenueCents: number;
  /** Net payments received in the prior week, for comparison. */
  priorRevenueCents: number;
  jobsCompleted: number;
  priorJobsCompleted: number;
  /** Jobs created (booked) in the week. */
  jobsBooked: number;
  estimatesSent: number;
  estimatesSentValueCents: number;
  invoicesPaidCount: number;
  /** AI-agent calls answered (voice sessions ended) in the week. */
  callsAnswered: number;
  newLeads: number;
  /** Current outstanding receivables snapshot (integer cents). */
  outstandingCents: number;
  /**
   * WS22 — "same mistake twice" weekly rate: of the proposal-edit
   * corrections logged this week (proposals/corrections, keyed by
   * (intent, field)), how many repeat a correction already made at some
   * earlier time (in-window or not). Coarse field-level identity — line-item
   * edits all collapse to field:'lineItems' (see CorrectionRepository doc
   * comment). Absent when the correction repo/method wasn't wired, OR when
   * `total` is 0 (no corrections this week — nothing to report; "omit if
   * zero" convention shared with the daily digest's optional sections).
   */
  repeatCorrections?: {
    total: number;
    repeats: number;
    /** repeats / total, rounded to the nearest whole percent. */
    rate: number;
  };
}

export interface WeeklySuggestions {
  wins: string[];
  misses: string[];
  /** One or two recommended next actions. */
  actions: string[];
}

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100);
  return `${sign}$${d.toLocaleString('en-US')}`;
}

function pctChange(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

/**
 * Deterministic wins/misses/actions derived from the snapshot. Always
 * available (no LLM needed) so the weekly email is never empty, and used as
 * the fallback when the gateway is unavailable or errors. Capped at two of
 * each so the email stays scannable.
 */
export function deterministicSuggestions(s: WeeklyFeedbackSnapshot): WeeklySuggestions {
  const wins: string[] = [];
  const misses: string[] = [];
  const actions: string[] = [];

  const revPct = pctChange(s.revenueCents, s.priorRevenueCents);
  if (s.revenueCents > 0 && (revPct === null || revPct >= 0)) {
    wins.push(
      revPct && revPct > 0
        ? `Revenue up ${revPct}% to ${dollars(s.revenueCents)} this week.`
        : `Collected ${dollars(s.revenueCents)} this week.`,
    );
  }
  if (s.callsAnswered > 0) {
    wins.push(`Your agent answered ${s.callsAnswered} ${s.callsAnswered === 1 ? 'call' : 'calls'}.`);
  }
  if (s.jobsCompleted > 0) {
    wins.push(`Completed ${s.jobsCompleted} ${s.jobsCompleted === 1 ? 'job' : 'jobs'}.`);
  }

  if (revPct !== null && revPct < 0) {
    misses.push(`Revenue down ${Math.abs(revPct)}% vs last week.`);
  }
  if (s.outstandingCents > 0) {
    misses.push(`${dollars(s.outstandingCents)} still outstanding from customers.`);
  }
  if (s.estimatesSent > 0 && s.jobsBooked === 0) {
    misses.push(`${s.estimatesSent} ${s.estimatesSent === 1 ? 'estimate' : 'estimates'} sent but nothing booked yet.`);
  }

  if (s.outstandingCents > 0) {
    actions.push('Send payment reminders on the outstanding invoices.');
  }
  if (s.newLeads > 0) {
    actions.push(`Follow up with the ${s.newLeads} new ${s.newLeads === 1 ? 'lead' : 'leads'} from this week.`);
  }
  if (actions.length === 0 && s.estimatesSent > 0) {
    actions.push('Nudge the open estimates that haven’t been accepted.');
  }
  if (actions.length === 0) {
    actions.push('Keep the momentum — your numbers look healthy.');
  }

  return {
    wins: wins.slice(0, 2),
    misses: misses.slice(0, 2),
    actions: actions.slice(0, 2),
  };
}

/**
 * Prompt for the gateway to generate suggestions. Counts/aggregates only — no
 * customer names or per-record PII beyond figures the owner already sees.
 * Asks for strict JSON so the response is machine-parseable.
 */
export function buildSuggestionsPrompt(s: WeeklyFeedbackSnapshot): string {
  const facts = {
    revenueCents: s.revenueCents,
    priorRevenueCents: s.priorRevenueCents,
    jobsCompleted: s.jobsCompleted,
    priorJobsCompleted: s.priorJobsCompleted,
    jobsBooked: s.jobsBooked,
    estimatesSent: s.estimatesSent,
    invoicesPaidCount: s.invoicesPaidCount,
    callsAnswered: s.callsAnswered,
    newLeads: s.newLeads,
    outstandingCents: s.outstandingCents,
  };
  return [
    'You are an advisor for a home-services business owner.',
    'Given this week\'s metrics (money is in integer cents), write a short, plain-spoken weekly review.',
    'Return STRICT JSON only: {"wins":[..],"misses":[..],"actions":[..]}.',
    'At most 2 wins, 2 misses, and 2 concrete next actions. Each item one sentence, no markdown.',
    `Metrics: ${JSON.stringify(facts)}`,
  ].join('\n');
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, limit);
}

/**
 * Parse the gateway's JSON response into suggestions. Tolerant: returns null
 * when the payload isn't usable so the caller falls back to deterministic.
 */
export function parseSuggestions(raw: string): WeeklySuggestions | null {
  let parsed: unknown;
  try {
    // Accept a bare JSON object even if the model wrapped it in prose.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const wins = asStringArray(obj.wins, 2);
  const misses = asStringArray(obj.misses, 2);
  const actions = asStringArray(obj.actions, 2);
  if (wins.length === 0 && misses.length === 0 && actions.length === 0) return null;
  return { wins, misses, actions };
}
