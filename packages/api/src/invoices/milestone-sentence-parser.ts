/**
 * U2 (agent wave) — deterministic milestone-sentence grammar.
 *
 * The voice classifier hands `CreateInvoiceScheduleTaskHandler` the VERBATIM
 * milestone sentence in `extractedEntities.scheduleDescription` ("50% deposit,
 * rest on completion"). This module turns that sentence into typed
 * `InvoiceMilestone[]` — deterministically, with NO LLM involvement — so an
 * LLM can never invent a billing split. Anything the grammar cannot parse
 * confidently returns `null`; the task handler then flags `milestones` as
 * missing and the proposal holds in draft with the raw sentence preserved for
 * the review UI. All money is integer cents; percents are basis points,
 * matching `invoices/invoice-schedule.ts`.
 *
 * Covered shapes:
 *   - "50% deposit / 50% up front / 30 percent down"  → percent, on_accept
 *   - "rest / balance / remainder on completion"      → remainder, on_completion
 *   - "50% deposit, 50% on completion"                → percents summing to
 *     100% — the LAST percent becomes the required `remainder`
 *   - "30/30/40 split"                                → percent chain, last as
 *     remainder (first on_accept, middles manual, last on_completion)
 *   - "$500 deposit up front, rest when we finish"    → flat cents, on_accept
 *     + remainder
 *
 * Rejected (→ null): percents summing past 100%, no derivable remainder
 * (e.g. a bare "$500 deposit" with no rest/balance language), multiple
 * remainder clauses, or no billing tokens at all. Every non-null result is
 * re-checked with `validateMilestones` before it leaves this module.
 */
import {
  InvoiceMilestone,
  MilestoneTrigger,
  validateMilestones,
} from './invoice-schedule';

/** Words that pin a clause to the accept/deposit moment. */
const ON_ACCEPT_RX =
  /\b(deposit|up\s*front|upfront|down(?:\s*payment)?|to\s+start|to\s+book|on\s+accept(?:ance)?|when\s+(?:they|the\s+customer)\s+accepts?|at\s+booking)\b/i;
/** Words that pin a clause to job completion. */
const ON_COMPLETION_RX =
  /\b(on\s+completion|complete(?:d|s)?|when\s+(?:we(?:'re)?|the\s+job(?:\s+is)?|it(?:'s)?|work(?:\s+is)?)\s*(?:finish(?:ed)?|done)|finish(?:ed)?|at\s+the\s+end|when\s+done|wrap(?:ped)?\s*up)\b/i;
/** Words that mark the catch-all remaining balance. */
const REMAINDER_RX = /\b(rest|balance|remainder|remaining|what(?:'s|\s+is)\s+left)\b/i;

/** "30/30/40 (percent) split" — a slash-separated percent chain. */
const SLASH_SPLIT_RX = /\b(\d{1,3})\s*\/\s*(\d{1,3})(?:\s*\/\s*(\d{1,3}))?\b/;

const PERCENT_RX = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b)/i;
const DOLLAR_RX = /\$\s*([\d,]+(?:\.\d{1,2})?)/;

interface ParsedPiece {
  kind: 'percent' | 'flat' | 'remainder';
  /** percent: bps; flat: integer cents; remainder: unused. */
  value: number;
  trigger: MilestoneTrigger | null;
}

/** "$1,234.5" → 123450 integer cents via string math (no float drift). */
function dollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  const m = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

function triggerOf(clause: string): MilestoneTrigger | null {
  // Accept-words win over completion-words within one clause ("deposit when
  // you finish" is nonsense we'd rather anchor on the explicit "deposit").
  if (ON_ACCEPT_RX.test(clause)) return 'on_accept';
  if (ON_COMPLETION_RX.test(clause)) return 'on_completion';
  return null;
}

function labelFor(piece: ParsedPiece, trigger: MilestoneTrigger): string {
  if (piece.kind === 'remainder') return 'Balance';
  const amount =
    piece.kind === 'percent' ? `${piece.value / 100}%` : `$${(piece.value / 100).toFixed(2)}`;
  if (trigger === 'on_accept') return `Deposit (${amount})`;
  if (trigger === 'on_completion') return `Completion (${amount})`;
  return `Progress payment (${amount})`;
}

/** Handle the "30/30/40 split" shape. Requires the chain to sum to 100. */
function parseSlashSplit(sentence: string): InvoiceMilestone[] | null {
  const m = sentence.match(SLASH_SPLIT_RX);
  if (!m) return null;
  // Guard against dates ("6/12") masquerading as splits: require either a
  // third segment or explicit split/percent wording nearby.
  const parts = [m[1], m[2], m[3]].filter((p): p is string => p !== undefined).map(Number);
  if (parts.length === 2 && !/\b(split|percent|%)\b/i.test(sentence)) return null;
  if (parts.reduce((a, b) => a + b, 0) !== 100) return null;

  const milestones: InvoiceMilestone[] = parts.map((pct, i) => {
    const last = i === parts.length - 1;
    if (last) {
      return { label: 'Balance', type: 'remainder' as const, value: 0, trigger: 'on_completion' as const };
    }
    const trigger: MilestoneTrigger = i === 0 ? 'on_accept' : 'manual';
    return {
      label: i === 0 ? `Deposit (${pct}%)` : `Progress payment (${pct}%)`,
      type: 'percent' as const,
      value: pct * 100,
      trigger,
    };
  });
  return milestones;
}

/**
 * Parse a spoken milestone sentence into a valid milestone list, or null when
 * the sentence does not describe a complete, parseable plan.
 */
export function parseMilestoneSentence(sentence: string): InvoiceMilestone[] | null {
  if (!sentence || sentence.trim().length === 0) return null;
  const text = sentence.trim();

  const slashSplit = parseSlashSplit(text);
  if (slashSplit) return finalize(slashSplit);

  // Clause-based pass: split on commas / "and" / "then" / semicolons and
  // classify each clause as percent, flat, or remainder. A comma directly
  // followed by a digit is a thousands separator ("$1,500"), not a clause
  // boundary.
  const clauses = text
    .split(/,(?!\d)|;|\bthen\b|\band\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const pieces: ParsedPiece[] = [];
  for (const clause of clauses) {
    const trigger = triggerOf(clause);
    // Remainder wording takes precedence: "the remaining 50% on completion"
    // is the catch-all balance, not an independent percent.
    if (REMAINDER_RX.test(clause)) {
      pieces.push({ kind: 'remainder', value: 0, trigger });
      continue;
    }
    const pct = clause.match(PERCENT_RX);
    if (pct) {
      const bps = Math.round(Number(pct[1]) * 100);
      if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) return null;
      pieces.push({ kind: 'percent', value: bps, trigger });
      continue;
    }
    // Spoken word-fractions: "half up front" / "a quarter down".
    if (/\bhalf\b/i.test(clause)) {
      pieces.push({ kind: 'percent', value: 5000, trigger });
      continue;
    }
    if (/\b(a\s+)?quarter\b/i.test(clause)) {
      pieces.push({ kind: 'percent', value: 2500, trigger });
      continue;
    }
    const dollars = clause.match(DOLLAR_RX);
    // A dollar amount is only a milestone when the clause anchors it to a
    // billing moment ("$500 deposit") — otherwise it is likely the job total
    // ("the $4,000 remodel"), which rides `amount`, not a milestone.
    if (dollars && trigger !== null) {
      const cents = dollarsToCents(dollars[1]);
      if (cents === null || cents <= 0) return null;
      pieces.push({ kind: 'flat', value: cents, trigger });
      continue;
    }
    // Safety rule: a clause that names a billing moment ("…to start",
    // "…on completion") but whose amount we could NOT parse means we only
    // partially understood the plan — reject the whole sentence rather than
    // silently dropping a spoken milestone. Trigger-free clauses ("for the
    // Hendersons") legitimately contribute nothing.
    if (trigger !== null) return null;
  }

  if (pieces.length === 0) return null;
  if (pieces.filter((p) => p.kind === 'remainder').length > 1) return null;

  // No explicit remainder: a percent chain that sums to exactly 100% converts
  // its LAST percent into the required remainder ("50% deposit, 50% on
  // completion"). Anything else is an incomplete plan → null (the handler
  // marks `milestones` missing rather than guessing the back half).
  if (!pieces.some((p) => p.kind === 'remainder')) {
    const percents = pieces.filter((p) => p.kind === 'percent');
    const bpsSum = percents.reduce((sum, p) => sum + p.value, 0);
    if (percents.length >= 2 && bpsSum === 10000 && pieces.every((p) => p.kind === 'percent')) {
      const last = pieces[pieces.length - 1];
      pieces[pieces.length - 1] = {
        kind: 'remainder',
        value: 0,
        trigger: last.trigger ?? 'on_completion',
      };
    } else {
      return null;
    }
  }

  const milestones: InvoiceMilestone[] = pieces.map((piece, i) => {
    const trigger: MilestoneTrigger =
      piece.trigger ??
      (piece.kind === 'remainder' ? 'on_completion' : i === 0 ? 'on_accept' : 'manual');
    return {
      label: labelFor(piece, trigger),
      type: piece.kind,
      value: piece.kind === 'remainder' ? 0 : piece.value,
      trigger,
    };
  });

  return finalize(milestones);
}

/** Belt-and-braces: only emit lists the schedule domain itself accepts. */
function finalize(milestones: InvoiceMilestone[]): InvoiceMilestone[] | null {
  return validateMilestones(milestones).length === 0 ? milestones : null;
}
