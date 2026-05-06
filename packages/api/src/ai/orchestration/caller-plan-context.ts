/**
 * §3C — Caller plan / membership awareness for the calling agent.
 *
 * After `identifyCaller` resolves a phone number to a `customerId`, the
 * agent should know whether that customer is on an active maintenance
 * plan. Without this, a Gold-plan member calling in is greeted the
 * same as a stranger — no priority routing, no "your next tune-up is
 * scheduled for X" personalization.
 *
 * This module is the data shape and pure formatter. The agent's
 * caller-identification path (in `inapp-adapter.ts` + `twilio-adapter.ts`)
 * calls `buildCallerPlanContext` after a successful match and stashes
 * the result on the session, then `formatCallerPlanForPrompt` produces
 * the prompt-shaped block injected into the classifier (and later the
 * greeting) — same pattern as §3B's vertical context.
 *
 * Reads through `AgreementRepository.findByTenant` with status
 * filtered to 'active' so paused / cancelled agreements don't trigger
 * a "you're on a plan" greeting that confuses the customer.
 */

import type { AgreementRepository } from '../../agreements/agreement';

export interface CallerPlanContext {
  /** True iff the customer has at least one active agreement. */
  hasActivePlan: boolean;
  /** Names of all active agreements (e.g. "Gold Membership", "Spring Tune-Up"). */
  planNames: string[];
  /** Earliest `nextRunAt` across active agreements. Undefined when no active plan. */
  earliestNextServiceDue?: Date;
}

const EMPTY_CONTEXT: CallerPlanContext = {
  hasActivePlan: false,
  planNames: [],
};

export async function buildCallerPlanContext(
  tenantId: string,
  customerId: string,
  agreementRepo: AgreementRepository,
): Promise<CallerPlanContext> {
  if (!tenantId || !customerId) return EMPTY_CONTEXT;

  let active;
  try {
    active = await agreementRepo.findByTenant(tenantId, {
      customerId,
      status: 'active',
    });
  } catch {
    // Best-effort — a repo failure must not crash the calling agent.
    // Caller proceeds without plan awareness; the next turn retries.
    return EMPTY_CONTEXT;
  }

  if (active.length === 0) return EMPTY_CONTEXT;

  const planNames = active.map((a) => a.name);
  const earliest = active
    .map((a) => a.nextRunAt)
    .reduce((min, d) => (d.getTime() < min.getTime() ? d : min));

  return {
    hasActivePlan: true,
    planNames,
    earliestNextServiceDue: earliest,
  };
}

/**
 * Render the caller plan context as a prompt-shaped block. Returns ''
 * when there's no active plan so callers can unconditionally
 * concatenate. Same shape and embedding strategy as
 * `formatVerticalForCallerPrompt` (see §3B).
 */
export function formatCallerPlanForPrompt(ctx: CallerPlanContext): string {
  if (!ctx.hasActivePlan) return '';

  const lines: string[] = ['Caller is on an active maintenance plan.'];
  if (ctx.planNames.length > 0) {
    lines.push(`Plans: ${ctx.planNames.join(', ')}`);
  }
  if (ctx.earliestNextServiceDue) {
    const isoDate = ctx.earliestNextServiceDue.toISOString().slice(0, 10);
    lines.push(`Next scheduled service: ${isoDate}`);
  }
  lines.push(
    'Treat as priority. Acknowledge the plan in the greeting. ' +
      'Disambiguate whether they\'re calling about scheduled service or a new issue.',
  );
  return lines.join('\n');
}
