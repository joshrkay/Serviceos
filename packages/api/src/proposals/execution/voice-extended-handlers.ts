import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';

/**
 * Execution handlers for the Stage-2 voice intents that don't yet
 * have domain-specific infrastructure wired in. These validate the
 * payload shape and return a result-entity-id placeholder so the
 * proposal lifecycle completes; the real mutation wire-up (to
 * NotesRepository, email/SMS provider, PaymentsRepository) will
 * replace these in follow-up slices.
 *
 * SAFETY GATE
 * -----------
 * In production these handlers MUST NOT run. A stub that transitions
 * a proposal to `executed` while not actually recording a payment or
 * sending an invoice writes a lie into the audit trail — operators
 * think the job is done, reconciliation later discovers it isn't.
 * `assertStubAllowed` throws in production unless
 * `ENABLE_VOICE_STUBS=1` is set explicitly (used by staging to
 * exercise the pipeline end-to-end). The flag is removed when the
 * real handlers land.
 */
function assertStubAllowed(): ExecutionResult | null {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_VOICE_STUBS !== '1') {
    return {
      success: false,
      error:
        'Handler not yet implemented — stub disabled in production. Set ENABLE_VOICE_STUBS=1 on staging to exercise the pipeline.',
    };
  }
  return null;
}

export class AddNoteExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_note';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const gate = assertStubAllowed();
    if (gate) return gate;
    const { payload } = proposal;
    if (typeof payload.body !== 'string' || payload.body.length === 0) {
      return { success: false, error: 'Payload must include a non-empty body' };
    }
    if (typeof payload.targetKind !== 'string') {
      return { success: false, error: 'Payload must include targetKind' };
    }
    if (!payload.targetId && !payload.targetReference) {
      return { success: false, error: 'Payload must include targetId or targetReference' };
    }
    // TODO(follow-up): wire NotesRepository.create — for now return a
    // synthetic id so the proposal transitions to executed cleanly in
    // dev/test/staging. Production is blocked by assertStubAllowed().
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class SendInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_invoice';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const gate = assertStubAllowed();
    if (gate) return gate;
    const { payload } = proposal;
    if (!payload.invoiceId && !payload.invoiceReference) {
      return { success: false, error: 'Payload must include invoiceId or invoiceReference' };
    }
    if (payload.channel !== 'email' && payload.channel !== 'sms') {
      return { success: false, error: 'Payload must specify channel as email or sms' };
    }
    // TODO(follow-up): dispatch to the outbound notifier (email or
    // SMS gateway) via the existing comms subsystem. Payload already
    // validated above so the notifier contract is clean.
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class RecordPaymentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'record_payment';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const gate = assertStubAllowed();
    if (gate) return gate;
    const { payload } = proposal;
    if (!payload.invoiceId && !payload.invoiceReference) {
      return { success: false, error: 'Payload must include invoiceId or invoiceReference' };
    }
    if (typeof payload.amountCents !== 'number' || payload.amountCents <= 0) {
      return { success: false, error: 'Payload must include a positive amountCents' };
    }
    if (
      payload.paymentMethod !== 'cash' &&
      payload.paymentMethod !== 'check' &&
      payload.paymentMethod !== 'card' &&
      payload.paymentMethod !== 'other'
    ) {
      return { success: false, error: 'Payload must specify paymentMethod' };
    }
    // TODO(follow-up): route to PaymentsRepository.create — money
    // moves only after this succeeds. The existing /api/payments
    // route (routes/payments.ts) is the reference for how to wire
    // this properly. Production is blocked by assertStubAllowed().
    return { success: true, resultEntityId: uuidv4() };
  }
}
