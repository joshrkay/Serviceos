/**
 * #1540 §3 (owner decision 2026-10-01) — a caller who is ALREADY a customer
 * asks to "sign up". The classifier hears create_customer (literally what was
 * asked); reading back "you'd like to add a new customer" and drafting a
 * duplicate record is wrong. The agent says they're already a customer and
 * asks what they need instead.
 *
 * Applies only on the untrusted CALLER surface (S1): on the owner line or a
 * trusted operator surface, create_customer means adding SOMEONE ELSE.
 * A caller whose record this call's ask_caller turn just created from their
 * phone number is not "already" a customer — their sign-up still drafts.
 *
 * The copy is the line the Gather transport's P18-001 branch has always
 * spoken to an already-matched caller (twilio-adapter.ts
 * `handleCreateCustomerVoiceIntent`), so every phone transport says the same
 * thing: media-streams speechTurn, Gather, and the voice-quality text driver
 * that mirrors them.
 */
import type { ClassifierProfile } from '../orchestration/classifier-profile';

export const EXISTING_CUSTOMER_SIGNUP_COPY =
  "I've got you in our system already. Let me know what you'd like help with today.";

export interface ExistingCustomerSignupInput {
  intentType: string;
  profile: ClassifierProfile;
  /** The session's identified caller (caller-ID match or ask_caller). */
  callerCustomerId?: string;
  callerCreatedThisCall?: boolean;
}

/** The reply to speak, or null when the turn is not an existing customer signing up. */
export function existingCustomerSignupReply(input: ExistingCustomerSignupInput): string | null {
  if (input.intentType !== 'create_customer') return null;
  if (input.profile !== 'caller') return null;
  if (!input.callerCustomerId || input.callerCreatedThisCall) return null;
  return EXISTING_CUSTOMER_SIGNUP_COPY;
}
