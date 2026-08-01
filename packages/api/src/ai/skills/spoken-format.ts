/**
 * Shared spoken-output formatting helpers used by the lookup-skill family.
 *
 * These are pure, zero-dependency utilities — no DB access, no I/O.
 * All three helpers are intentionally kept together so a single import
 * covers the common voice-formatting surface; adding a new lookup skill
 * should not require duplicating them.
 *
 * Formatting contract: output must read correctly on both TTS engines
 * (Amazon Polly and Google Cloud TTS). In practice that means:
 *   - Dollar amounts as "$120.50" (not "120 dollars 50 cents" — that
 *     confuses Polly's number-interpretation heuristic).
 *   - No markdown, no HTML entities, no trailing punctuation added here
 *     (the caller's sentence owns punctuation).
 */
import { formatUsdCentsPlain } from '@ai-service-os/shared';

/**
 * Simple pluralisation helper.
 *
 * plural(1, 'appointment')          → 'appointment'
 * plural(3, 'appointment')          → 'appointments'
 * plural(1, 'approval is', 'approvals are') → 'approval is'
 * plural(2, 'approval is', 'approvals are') → 'approvals are'
 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * Format an integer-cents amount as a USD dollar string suitable for TTS.
 * Delegates to the cross-package `formatUsdCentsPlain` (bare `$N.NN`, no
 * thousands separators) — separators confuse Polly's number heuristic, which
 * is exactly the terse contract that helper provides.
 *
 * formatCents(45000) → '$450.00'
 * formatCents(0)     → '$0.00'
 */
export function formatCents(cents: number): string {
  return formatUsdCentsPlain(cents);
}

/**
 * Alias for formatCents — used by lookup-pending-items which names the
 * helper "formatUsd" internally for readability. Both produce identical
 * output; the alias keeps callers in sync without a rename.
 */
export const formatUsd = formatCents;
