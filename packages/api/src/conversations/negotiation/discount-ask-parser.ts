/**
 * V2 negotiation (D-013) — deterministic discount-ask parser.
 *
 * Extracts a concrete target price / discount from a customer's verbatim ask
 * so the evaluator (`evaluateDiscountAsk`) can decide. CONSERVATIVE by mandate
 * (R4): it only returns a number when the phrasing is unambiguous, otherwise
 * `ambiguous` so the caller emits a `voice_clarification` instead of guessing.
 * No LLM — pure, auditable regex logic, mirroring the deterministic style of
 * the V1 ask-type detection in `proposals/guardrails/negotiation-guardrail.ts`.
 *
 * Precision lever: a bare number is NEVER treated as money. A value counts as
 * money only with a currency marker (`$`, "dollars", "bucks") or a percent
 * marker (`%`, "percent"); a target/discount is only emitted when a clear
 * frame word accompanies it. So "I have 2 dogs" / "call me at 512…" / "how
 * much?" all resolve to `ambiguous`.
 */
import { applyBps } from '../../shared/billing-engine';
import type { DiscountTarget } from '../../proposals/guardrails/discount-evaluator';

export type ParsedDiscountAsk =
  | { kind: 'target_price'; cents: number }
  | { kind: 'amount_off'; cents: number }
  | { kind: 'percent_off'; bps: number }
  | { kind: 'ambiguous' };

/** "$1,200" / "1200 dollars" / "$49.99" → integer cents. */
function moneyToCents(whole: string, frac?: string): number {
  const dollars = parseInt(whole.replace(/,/g, ''), 10);
  if (!Number.isFinite(dollars)) return NaN;
  const cents = frac ? parseInt((frac + '00').slice(0, 2), 10) : 0;
  return dollars * 100 + cents;
}

const DOLLAR_RX = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const WORD_MONEY_RX = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:dollars?|bucks)\b/gi;

/** All money amounts in the text (currency-marked only), sorted by position. */
function extractMoney(text: string): Array<{ cents: number; index: number }> {
  const out: Array<{ cents: number; index: number }> = [];
  for (const m of text.matchAll(DOLLAR_RX)) {
    const cents = moneyToCents(m[1], m[2]);
    if (Number.isFinite(cents)) out.push({ cents, index: m.index ?? 0 });
  }
  for (const m of text.matchAll(WORD_MONEY_RX)) {
    const cents = moneyToCents(m[1], m[2]);
    if (Number.isFinite(cents)) out.push({ cents, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

// "knock/take/shave off", "discount" → the money is an amount OFF.
const AMOUNT_OFF_RX = /\boff\b|\bdiscount/i;
// Frames where the money is the price the customer wants to PAY.
const TARGET_FRAME_RX =
  /\bpay\b|\bfor\s+\$?\d|\bmake it\b|\bgive\s+(?:you|ya|me)\b|\bdo\s+\$?\d|\b(?:not|instead of)\b|\bmatch\b/i;

/**
 * Parse a discount ask into a concrete shape, or `ambiguous`. Percent is
 * checked first ("10% off" is a percentage, not a $10 amount).
 */
export function parseDiscountAsk(text: string): ParsedDiscountAsk {
  if (!text || text.trim() === '') return { kind: 'ambiguous' };

  // 1. Percent off — "10% off", "10 percent". Reject 0 / >100% as nonsensical.
  //    The leading \b anchors the number to a word boundary so a 4+ digit run
  //    can't backtrack into a valid suffix ("1025%" must NOT match "025%").
  const pm = text.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b)/i);
  if (pm) {
    const bps = Math.round(parseFloat(pm[1]) * 100);
    if (bps > 0 && bps <= 10000) return { kind: 'percent_off', bps };
  }

  // 2. Money amounts (currency-marked only).
  const monies = extractMoney(text);
  if (monies.length === 0) return { kind: 'ambiguous' };

  // 3. Amount off — a discount framed by "off"/"discount".
  if (AMOUNT_OFF_RX.test(text)) {
    return { kind: 'amount_off', cents: monies[0].cents };
  }

  // 4. Target price — an explicit "pay/for/make it/not/instead/match" frame.
  //    Use the lowest amount: the customer's desired price ("$200 not $250").
  if (TARGET_FRAME_RX.test(text)) {
    const cents = Math.min(...monies.map((m) => m.cents));
    return { kind: 'target_price', cents };
  }

  // 5. Money present but no clear frame ("the $250 is too much") → clarify.
  return { kind: 'ambiguous' };
}

/**
 * Ground a parsed ask against the catalog list price to produce the
 * evaluator's `DiscountTarget`. `amount_off`/`percent_off` need `listCents`
 * (the caller has it once the scope is catalog-resolved); `target_price`
 * passes through. All math via `applyBps` / integer cents.
 */
export function resolveTargetFromParsedAsk(
  parsed: ParsedDiscountAsk,
  listCents: number,
): DiscountTarget {
  const list = Math.max(0, Math.round(listCents));
  switch (parsed.kind) {
    case 'ambiguous':
      return { ambiguous: true };
    case 'target_price':
      return { ambiguous: false, targetPriceCents: Math.max(0, Math.round(parsed.cents)) };
    case 'amount_off':
      return {
        ambiguous: false,
        targetPriceCents: Math.max(0, list - Math.max(0, Math.round(parsed.cents))),
      };
    case 'percent_off':
      return { ambiguous: false, targetPriceCents: Math.max(0, list - applyBps(list, parsed.bps)) };
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}
