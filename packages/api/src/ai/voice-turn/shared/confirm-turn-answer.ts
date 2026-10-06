/**
 * #1476 item 3 — the ANSWER to a question asked at the `intent_confirm`
 * readback ("can you confirm the number you have for me?", "what time was
 * that again?"). The pending request is kept and re-asked by the caller;
 * this module only decides what is said in between.
 *
 * #1601 step 2 — the one copy. The phone processor and the in-app adapter
 * each carried this and had drifted on the cost cap (in-app decided on this
 * call's tracker events; the processor on the tracker's LEVEL, #1204). The
 * processor's rule is kept: the surface passes its `recordCost` port from
 * `shared/session-cost.ts`. Everything genuinely surface-specific stays a
 * port: who counts as untrusted, the caller-ID, how a lookup is classified
 * (phone context vs in-app retry) and answered (`answerPhoneLookup` with its
 * S1/D-026 rules vs `answerInAppLookup` with RBAC).
 *
 * Rules:
 *   - callback number: an UNTRUSTED (S1) caller hears only what they gave on
 *     this call or their own caller-ID masked — never a number off a customer
 *     record (the record is not read); a trusted surface may read the number
 *     on file for the pending customer;
 *   - a question about the pending request's own details is answered from
 *     its slots (no classify, no lookup);
 *   - anything else goes through the surface's EXISTING read-only lookup
 *     path: the unchanged classifier names the lookup; only a CONFIDENT
 *     lookup intent is answered. A mutation intent, low confidence, a
 *     classifier failure, or a surface that serves no lookups says "no detail
 *     yet" — a question never becomes an instruction here;
 *   - a lookup classify that crosses the session cap supersedes the answer.
 */
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import { TTS_COPY } from '../../agents/customer-calling/tts-copy';
import { TAU_INT } from '../../agents/customer-calling/transitions';
import { isLookupIntent, type IntentClassification, type IntentType } from '../../orchestration/intent-classifier';
import {
  answerCallbackNumberQuestion,
  answerPendingDetailQuestion,
  type ConfirmTurnQuestionKind,
} from '../confirm-turn-question';
import type { TurnTokenUsage } from './session-cost';

/** The surface's read-only lookup path, or null when it serves no lookups. */
export interface ConfirmTurnLookupPorts {
  classify(text: string): Promise<IntentClassification>;
  /** `SessionCostRecorder.recordCost` — true when the cap is exceeded (the surface escalates). */
  recordCost(session: VoiceSession, usage: TurnTokenUsage): boolean;
  /** The surface's lookup dispatch for a confident lookup classification. */
  answer(classification: IntentClassification): Promise<string | undefined>;
  onClassifyError?(err: unknown): void;
}

/** The slice of the customer repo the callback-number answer reads. */
export interface ConfirmTurnCustomerReader {
  findById(
    tenantId: string,
    id: string,
  ): Promise<{ primaryPhone?: string | null; secondaryPhone?: string | null } | null | undefined>;
}

export interface ConfirmTurnAnswerPorts {
  /** S1 caller: never a number off a record. */
  untrustedCaller: boolean;
  /** The line the caller is calling from (spoken masked to an S1 caller). */
  callerId?: string;
  /** Read only on a trusted surface. */
  customerRepo?: ConfirmTurnCustomerReader;
  lookup: ConfirmTurnLookupPorts | null;
}

export type ConfirmTurnAnswer = { capExceeded: false; answer: string } | { capExceeded: true };

export async function answerConfirmTurnQuestionByLookup(
  session: VoiceSession,
  text: string,
  lookup: ConfirmTurnLookupPorts | null,
): Promise<{ text?: string; capExceeded: boolean }> {
  if (!lookup) return { capExceeded: false };
  let classification: IntentClassification;
  try {
    classification = await lookup.classify(text);
  } catch (err) {
    lookup.onClassifyError?.(err);
    return { capExceeded: false };
  }
  if (lookup.recordCost(session, classification.tokenUsage)) return { capExceeded: true };
  if (classification.confidence < TAU_INT || !isLookupIntent(classification.intentType as IntentType)) {
    return { capExceeded: false };
  }
  return { text: await lookup.answer(classification), capExceeded: false };
}

export async function answerConfirmTurnQuestion(
  session: VoiceSession,
  kind: ConfirmTurnQuestionKind,
  text: string,
  ports: ConfirmTurnAnswerPorts,
): Promise<ConfirmTurnAnswer> {
  const entities = (session.machine.currentContext.extractedEntities ?? {}) as Record<string, unknown>;
  if (kind === 'callback_number') {
    let onFile: string | undefined;
    // Trusted line only: an S1 caller never gets a record read to them.
    if (!ports.untrustedCaller && ports.customerRepo) {
      const customerId =
        (typeof entities.customerId === 'string' ? entities.customerId : undefined) ?? session.customerId;
      const customer = customerId
        ? await ports.customerRepo.findById(session.tenantId, customerId).catch(() => null)
        : null;
      onFile = customer?.primaryPhone ?? customer?.secondaryPhone ?? undefined;
    }
    return {
      capExceeded: false,
      answer: answerCallbackNumberQuestion({
        untrustedCaller: ports.untrustedCaller,
        givenThisCall: typeof entities.phone === 'string' ? entities.phone : undefined,
        callerId: ports.callerId,
        onFile,
      }),
    };
  }
  let looked: string | undefined;
  const detail = answerPendingDetailQuestion(kind, entities);
  if (detail === undefined) {
    const lookup = await answerConfirmTurnQuestionByLookup(session, text, ports.lookup);
    if (lookup.capExceeded) return { capExceeded: true };
    looked = lookup.text;
  }
  return { capExceeded: false, answer: detail ?? looked ?? TTS_COPY.no_detail_yet.en };
}
