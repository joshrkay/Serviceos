/**
 * P2-034 — SMS approval transport reply contract.
 *
 * When a proposal is routed to the owner via SMS (unsupervised
 * `queue_and_sms`), the body invites three reply tokens:
 *
 *   APPROVE (or Y)  → approve the proposal through the existing approval
 *                     path (execution, undo window, audits all unchanged)
 *   REJECT  (or N)  → reject; any text after the token is the reason
 *   EDIT            → open a 10-minute edit session; the next message is
 *                     the requested change
 *
 * This module is the single typed contract for parsing those replies so
 * the API handler (consumer) and any future surface that renders the
 * invitation (producer) agree on the accepted tokens. The parser is
 * deliberately tolerant — the owner is typing with gloves on, in a truck:
 * capitalization, leading whitespace/punctuation, and the most common
 * typos all resolve to the intended action. Anything else is
 * `unrecognized` and triggers a one-time clarification, never a guess.
 */
import { z } from 'zod';

export const PROPOSAL_SMS_REPLY_INTENTS = [
  'approve',
  'approve_all',
  'reject',
  'edit',
  'unrecognized',
] as const;

export type ProposalSmsReplyIntent = (typeof PROPOSAL_SMS_REPLY_INTENTS)[number];

/**
 * Accepted first tokens per intent, lowercase. Includes the common
 * typo/casual variants the review prompt calls out (`YES`, `OK`,
 * `approve`). Tokens must stay unique across intents AND must not collide
 * with other registered inbound-SMS keywords (STOP/START compliance,
 * OUT/SICK/UNAVAILABLE tech status).
 */
export const APPROVE_TOKENS = [
  'y',
  'yes',
  'yess',
  'yep',
  'yeah',
  'ok',
  'okay',
  'approve',
  'approved',
  'aprove',
] as const;

export const REJECT_TOKENS = [
  'n',
  'no',
  'nope',
  'reject',
  'rejected',
  'decline',
  'deny',
] as const;

export const EDIT_TOKENS = ['edit', 'change', 'modify', 'fix'] as const;

/**
 * U5 — bulk-approve token. "ALL" (alone) or "APPROVE ALL" / "YES ALL" is a
 * DELIBERATE bulk approval of everything currently one-tap-eligible (the same
 * capture-class, confident set a single texted Y could approve). Distinct from
 * `approve` so the handler fans out to the batch-approve path instead of the
 * single most-recent-render target.
 */
export const APPROVE_ALL_TOKENS = ['all'] as const;

const INTENT_BY_TOKEN: ReadonlyMap<string, ProposalSmsReplyIntent> = new Map([
  ...APPROVE_TOKENS.map((t) => [t, 'approve'] as const),
  ...REJECT_TOKENS.map((t) => [t, 'reject'] as const),
  ...EDIT_TOKENS.map((t) => [t, 'edit'] as const),
]);

export const ProposalSmsReplySchema = z.object({
  intent: z.enum(PROPOSAL_SMS_REPLY_INTENTS),
  /**
   * Everything after the recognized token, trimmed. Carries the rejection
   * reason ("N too expensive") or, for `unrecognized`, the full normalized
   * body so the clarification/edit-capture path can use it.
   */
  remainder: z.string(),
});

export type ProposalSmsReply = z.infer<typeof ProposalSmsReplySchema>;

/**
 * Strip the leading/trailing punctuation an owner's reply commonly picks
 * up ("Yes!", "'approve'", "ok.") so token matching sees the bare word.
 */
function bareToken(raw: string): string {
  return raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Parse an inbound SMS body into a reply intent. Pure, total — never
 * throws. Unknown or empty bodies come back `unrecognized` with the
 * trimmed body as remainder so the caller can run the
 * clarify-once-then-escalate flow.
 */
export function parseProposalSmsReply(body: string): ProposalSmsReply {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return { intent: 'unrecognized', remainder: '' };

  const [first = '', ...rest] = trimmed.split(/\s+/);
  const token = bareToken(first.toLowerCase());
  const restFirst = rest.length > 0 ? bareToken(rest[0].toLowerCase()) : '';

  // Bulk approve: "ALL" alone, or an approve token followed by "all"
  // ("APPROVE ALL", "YES ALL"). Checked before the single-intent lookup so the
  // trailing "all" isn't mistaken for a one-proposal approve with remainder.
  if (token === 'all') {
    return { intent: 'approve_all', remainder: rest.join(' ').trim() };
  }
  const firstIntent = INTENT_BY_TOKEN.get(token);
  if (firstIntent === 'approve' && restFirst === 'all') {
    return { intent: 'approve_all', remainder: rest.slice(1).join(' ').trim() };
  }
  if (!firstIntent) return { intent: 'unrecognized', remainder: trimmed };

  return { intent: firstIntent, remainder: rest.join(' ').trim() };
}
