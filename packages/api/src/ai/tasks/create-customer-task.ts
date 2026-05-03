/**
 * P18-001 — `create_customer` voice task handler.
 *
 * Owns the voice path from a classified `create_customer` intent to a
 * fully-shaped proposal that the human-approval UI can render. The
 * handler is intentionally LLM-free — by the time it runs, the
 * intent classifier has already extracted (displayName, email, phone)
 * and the FSM has resolved the entity payload via `entity_resolved`.
 * This handler stitches those signals together with the inbound
 * caller-id phone, applies the SMS-consent default, and produces the
 * proposal.
 *
 * Pattern mirrors `create-appointment-task.ts` but without the LLM
 * call: the task is deterministic and side-effect free besides the
 * proposal it returns.
 *
 * Hard rule: `create_customer` is identity creation — never
 * auto-execute. We deliberately omit `sourceTrustTier` so the
 * proposal lands in `'draft'` regardless of confidence (D3 in
 * proposal.ts). Approval happens via human screen-tap.
 */

import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import {
  CreateProposalInput,
  Proposal,
  ProposalType,
  createProposal,
} from '../../proposals/proposal';
import {
  buildCreateCustomerPayload,
  CreateCustomerVoiceMetadata,
} from '../../proposals/contracts/create-customer-contract';

/**
 * Voice-call signals the FSM forwards into TaskContext.existingEntities.
 * All optional — the task degrades gracefully when fields are missing.
 *
 *   displayName        — caller's stated name from the LLM
 *   email              — caller's stated email
 *   phone              — caller's stated callback (rare; usually missing)
 *   callerIdPhone      — Twilio "from" header (caller-id)
 *   phoneBlocked       — true when caller-id was withheld / 'restricted'
 *   sessionId          — voice session uuid for proposal->session join
 *   callSid            — Twilio CallSid
 *   correlationId      — session id used by audit / comms reuse
 *   classifierConfidence — score from the intent classifier
 *   language           — BCP-47 short code from the call
 *   existingCustomerId — set when identify_caller already matched
 *   existingLeadId     — set when find-or-create-lead matched a Lead
 */
export interface CreateCustomerEntities {
  displayName?: string;
  email?: string;
  phone?: string;
  callerIdPhone?: string;
  phoneBlocked?: boolean;
  sessionId?: string;
  callSid?: string;
  correlationId?: string;
  classifierConfidence?: number;
  language?: string;
  existingCustomerId?: string;
  existingLeadId?: string;
}

export interface CreateCustomerTaskOutcome {
  status: 'proposal_drafted' | 'already_customer' | 'lead_match' | 'needs_callback' | 'needs_name';
  proposal?: Proposal;
  message: string;
}

/**
 * Static, deterministic confirmation copy the FSM speaks after a
 * proposal is queued. Acceptance criterion AC-5.
 */
export const CREATE_CUSTOMER_CONFIRMATION_TTS =
  "Got it, I've sent your info to the office; we'll send you a confirmation.";

/**
 * Resolve the canonical phone for a new-customer proposal: prefer the
 * spoken callback, fall back to the caller-id, and mark `phoneSource`
 * accordingly so the approval UI can show provenance. Returns
 * `undefined` for both phone and source when caller-id is blocked AND
 * the caller did not state a callback — the task uses this signal to
 * raise a needs_callback outcome.
 */
export function resolvePhone(input: {
  phone?: string;
  callerIdPhone?: string;
  phoneBlocked?: boolean;
}): { phone?: string; phoneSource?: 'caller_id' | 'spoken' | 'callback' } {
  const spoken = input.phone?.trim();
  if (spoken && spoken.length > 0) {
    return { phone: spoken, phoneSource: 'spoken' };
  }
  if (input.phoneBlocked) {
    return {};
  }
  const cid = input.callerIdPhone?.trim();
  if (cid && cid.length > 0) {
    return { phone: cid, phoneSource: 'caller_id' };
  }
  return {};
}

/**
 * Build a CreateCustomerEntities object from a TaskContext.
 * Tolerant of missing fields — the caller passes whatever the FSM
 * accumulated.
 */
function readEntities(context: TaskContext): CreateCustomerEntities {
  const raw = context.existingEntities ?? {};
  const get = (key: string): unknown => (raw as Record<string, unknown>)[key];
  const str = (key: string): string | undefined => {
    const v = get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const num = (key: string): number | undefined => {
    const v = get(key);
    return typeof v === 'number' ? v : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const v = get(key);
    return typeof v === 'boolean' ? v : undefined;
  };
  return {
    displayName: str('displayName') ?? str('customerName') ?? str('name'),
    email: str('email'),
    phone: str('phone'),
    callerIdPhone: str('callerIdPhone'),
    phoneBlocked: bool('phoneBlocked'),
    sessionId: str('sessionId') ?? context.conversationId,
    callSid: str('callSid'),
    correlationId: str('correlationId') ?? context.conversationId,
    classifierConfidence: num('classifierConfidence'),
    language: str('language'),
    existingCustomerId: str('existingCustomerId'),
    existingLeadId: str('existingLeadId'),
  };
}

export class CreateCustomerVoiceTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_customer';

  async handle(context: TaskContext): Promise<TaskResult> {
    const outcome = await this.run(context);
    if (!outcome.proposal) {
      // The story requires a proposal output. When the runtime
      // resolves to a no-proposal outcome (already-customer, lead-match,
      // needs-callback, needs-name), the FSM should be driving an
      // alternate flow — but this method returns a `TaskResult`, so we
      // emit a `voice_clarification` proposal that captures the reason
      // the create_customer flow declined to draft. Keeps the contract
      // tight and gives the operator a paper trail.
      const clarification = createProposal({
        tenantId: context.tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: context.message,
          reason: 'missing_entities',
          conversationId: context.conversationId,
        },
        summary: outcome.message,
        explanation: outcome.message,
        sourceContext: {
          source: 'voice',
          intent: 'create_customer',
          status: outcome.status,
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        },
        createdBy: context.userId,
      });
      return { proposal: clarification, taskType: 'voice_clarification' };
    }
    return { proposal: outcome.proposal, taskType: this.taskType };
  }

  /**
   * Run the deterministic proposal-build pipeline. Exposed separately
   * so the FSM adapter can branch on the outcome WITHOUT a clarification
   * proposal (e.g. already_customer → confirm identity instead).
   */
  async run(context: TaskContext): Promise<CreateCustomerTaskOutcome> {
    const ents = readEntities(context);

    // Path 1: caller already matched to an existing customer. Don't
    // generate a create proposal — agent confirms identity instead
    // (Secondary path 1).
    if (ents.existingCustomerId) {
      return {
        status: 'already_customer',
        message: 'Caller is already a customer; confirming identity instead of creating a duplicate',
      };
    }

    const { phone, phoneSource } = resolvePhone(ents);
    // Path 4: phone blocked and no spoken callback — escalate via
    // needs_callback so the FSM asks for a callback number.
    if (!phone) {
      return {
        status: 'needs_callback',
        message: 'Caller-ID is blocked and no callback number was provided',
      };
    }

    // Path 3: name missing — proposals can still be created with phone
    // alone PER acceptance-criterion variant 3 ("name only" → proposal
    // with name+phone). When BOTH name and email/spoken phone are
    // missing AND the only signal is caller-id, raise needs_name so
    // the FSM can prompt for the name. The contract requires `name` —
    // we never produce a contract-violating proposal.
    const name = ents.displayName?.trim();
    if (!name || name.length === 0) {
      return {
        status: 'needs_name',
        message: 'Need the caller name before drafting a create_customer proposal',
      };
    }

    // Path 5: caller phone matches an existing LEAD. We still draft
    // the proposal so the human approver can convert the lead → customer
    // in one screen-tap; the lead linkage rides in voice metadata.
    const voice: CreateCustomerVoiceMetadata = {
      ...(phoneSource ? { phoneSource } : {}),
      ...(ents.phoneBlocked !== undefined ? { phoneBlocked: ents.phoneBlocked } : {}),
      ...(ents.sessionId ? { sessionId: ents.sessionId } : {}),
      ...(ents.callSid ? { callSid: ents.callSid } : {}),
      ...(ents.classifierConfidence !== undefined
        ? { classifierConfidence: ents.classifierConfidence }
        : {}),
      ...(ents.language ? { language: ents.language } : {}),
    };

    const payload = buildCreateCustomerPayload({
      name,
      email: ents.email,
      phone,
      voice: Object.keys(voice).length > 0 ? voice : undefined,
      smsConsent: false, // tenant default; never auto-opt-in
    });

    const correlationId = ents.correlationId ?? context.conversationId;

    const sourceContext: Record<string, unknown> = {
      source: 'voice',
      intent: 'create_customer',
      transcript: context.message,
      classifierConfidence: ents.classifierConfidence,
      ...(correlationId ? { correlationId } : {}),
      ...(ents.sessionId ? { sessionId: ents.sessionId } : {}),
      ...(ents.callSid ? { callSid: ents.callSid } : {}),
      ...(ents.existingLeadId ? { existingLeadId: ents.existingLeadId, suggestLeadConversion: true } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    };

    const summaryEmail = payload.email ? `, ${payload.email}` : '';
    const summary = `New customer from inbound call: ${payload.name} (${phone})${summaryEmail}`;
    const explanation = ents.existingLeadId
      ? `Caller phone matches lead ${ents.existingLeadId}. Approve to convert to customer; reject to keep as lead.`
      : 'Caller asked to sign up as a new customer. Approve to add them to the CRM.';

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: payload as unknown as Record<string, unknown>,
      summary,
      explanation,
      confidenceScore: ents.classifierConfidence,
      sourceContext,
      createdBy: context.userId,
      // Deliberately NO sourceTrustTier. Identity creation is always
      // human-gated; D3 puts capture-class proposals on the autonomous
      // ladder, but create_customer is too sensitive (PII + dedup
      // implications) to auto-approve even at the highest tier.
    };

    const proposal = createProposal(input);
    return {
      status: ents.existingLeadId ? 'lead_match' : 'proposal_drafted',
      proposal,
      message: ents.existingLeadId
        ? 'Caller phone matches an existing lead — proposal queued for conversion review'
        : 'Proposal queued for approval',
    };
  }
}

export { buildCreateCustomerPayload };
