/**
 * N-003 (P2-036) — customer-facing negotiation acknowledgment.
 *
 * When the guardrail fires, the AI must NOT answer substantively (no price, no
 * discount, no scope commitment). It sends a brand-voiced holding line and
 * routes the decision to the owner. This composer is deterministic (no LLM) so
 * the wording is auditable and can never drift into an accidental concession;
 * it is parameterized by the locked brand voice so it still sounds like the
 * shop (PRD: "Acknowledgment message uses the locked brand voice").
 *
 * Used by the inbound-SMS negotiation handler. (The live-call FSM speaks a
 * fixed script line, consistent with how operator_request / emergency lines are
 * scripted in the pure state machine.)
 */
import type { BrandVoiceSettings } from '../../settings/settings';
import { resolveRegister } from '../../ai/brand-voice/prompts';

export interface NegotiationAcknowledgmentInput {
  /** Owner's first name for the "let me check with X" line. */
  ownerFirstName?: string | null;
  brandVoice?: BrandVoiceSettings | null;
  /**
   * Tenant business name (from `tenant_settings.businessName`), used as the
   * shop reference when no owner first name and no `brandVoice.business_name`
   * is set — these are distinct settings fields.
   */
  businessName?: string | null;
  /** How soon we promise to follow up. Defaults to "within the hour". */
  callbackWindow?: string;
}

/**
 * The shop reference used in the holding line: the owner's first name when
 * known, else the business name, else a neutral "the owner".
 */
function resolvePerson(input: NegotiationAcknowledgmentInput): string {
  const who = (input.ownerFirstName ?? '').trim();
  if (who) return who;
  const business = (input.brandVoice?.business_name ?? input.businessName ?? '').trim();
  if (business) return `the team at ${business}`;
  return 'the owner';
}

export function composeNegotiationAcknowledgment(
  input: NegotiationAcknowledgmentInput = {},
): string {
  const person = resolvePerson(input);
  const window = (input.callbackWindow ?? '').trim() || 'within the hour';
  // Professional register mirrors suggest-reply-task's brand-voice read.
  // N-011 — register is authoritative; legacy `formality` maps forward.
  if (input.brandVoice && resolveRegister(input.brandVoice) === 'formal') {
    return `Thanks for asking — I'll need to confirm that with ${person} before I can give you an answer. I'll follow up ${window}.`;
  }
  return `Good question — let me check with ${person} on that and I'll get right back to you ${window}.`;
}

/**
 * Side-effect payload `source` tag the live-call FSM stamps on its fixed
 * negotiation holding-line `tts_play`, so the settings-aware voice-turn
 * processor can recognise and brand-voice it. Must match the literal the FSM
 * emits in `customer-calling/transitions.ts`.
 */
export const NEGOTIATION_HOLDING_TTS_SOURCE = 'negotiation_holding';

/**
 * Rewrite the FSM's fixed negotiation holding-line `tts_play` (tagged
 * `source: NEGOTIATION_HOLDING_TTS_SOURCE`) in place with the brand-voiced,
 * deterministic acknowledgment, so the live call sounds like the shop and
 * matches the SMS channel. Pure: mutates the passed side effects, no I/O, never
 * LLM. Other `tts_play` effects are left untouched.
 */
export function brandVoiceNegotiationTts(
  sideEffects: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
  brand: NegotiationAcknowledgmentInput,
): void {
  for (const fx of sideEffects) {
    if (fx.type === 'tts_play' && fx.payload?.source === NEGOTIATION_HOLDING_TTS_SOURCE) {
      fx.payload.text = composeNegotiationAcknowledgment(brand);
    }
  }
}
