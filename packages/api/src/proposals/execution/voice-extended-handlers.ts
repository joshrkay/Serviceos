import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  NoteRepository,
  NoteEntityType,
  createNote,
} from '../../notes/note';
import {
  PaymentRepository,
  PaymentMethod,
  recordPayment,
  PaymentReceiptNotifier,
} from '../../invoices/payment';
import { InvoiceRepository } from '../../invoices/invoice';
import { RefreshJobMoneyStateDeps } from '../../jobs/job-money-state';
import { AuditRepository } from '../../audit/audit';

/**
 * Execution handlers for the Stage-2 voice intents.
 *
 * Two handlers (add_note, record_payment) are wired against the real
 * domain repositories; the third (send_invoice) is wired against a
 * small `InvoiceDeliveryProvider` abstraction whose default Noop
 * implementation logs the dispatch shape without sending bytes. The
 * Noop is the production gate for outbound comms — when a real
 * outbound provider lands, swap the provider in `app.ts` and no
 * handler code changes.
 */

// ─── add_note ──────────────────────────────────────────────────
//
// Maps the proposal payload onto NoteRepository's `entityType` /
// `entityId`. The voice schema accepts an `appointment` targetKind
// (the assistant frontend renders a note on the appointment card),
// but the NoteRepository only knows customer / location / job /
// estimate / invoice. The handler refuses 'appointment' rather than
// silently re-categorizing — when notes-on-appointments lands, both
// sides update together.
const NOTE_ENTITY_TYPES: ReadonlySet<NoteEntityType> = new Set([
  'customer',
  'location',
  'job',
  'estimate',
  'invoice',
]);

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
  );
}

export class AddNoteExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_note';

  constructor(
    private readonly noteRepo: NoteRepository | undefined,
    // WS3 — auditRepo is structurally REQUIRED: a persisted note must always
    // emit its note.created audit event (createNote forwards it). Non-optional
    // so a call site cannot wire this handler without an audit sink.
    private readonly auditRepo: AuditRepository,
  ) {}

  // WS3 — degrades to nothing without the note repo; boot fails when a pool is
  // configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.noteRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (typeof payload.body !== 'string' || payload.body.length === 0) {
      return { success: false, error: 'Payload must include a non-empty body' };
    }
    const targetKind = payload.targetKind;
    if (typeof targetKind !== 'string') {
      return { success: false, error: 'Payload must include targetKind' };
    }
    if (!NOTE_ENTITY_TYPES.has(targetKind as NoteEntityType)) {
      // 'appointment' falls through here intentionally — we don't
      // store appointment-scoped notes yet, so refusing is safer
      // than re-categorizing onto the wrong entity.
      return {
        success: false,
        error: `targetKind '${targetKind}' is not a supported note entityType`,
      };
    }
    if (!isUuid(payload.targetId)) {
      return {
        success: false,
        error: 'Payload must include a valid targetId UUID (resolve targetReference at review time first)',
      };
    }

    if (!this.noteRepo) {
      // WS3 — no synthetic success: a missing repo is a wiring fault, never a
      // silent no-op that reports success while persisting nothing.
      return { success: false, error: 'handler_not_wired:noteRepo' };
    }

    try {
      const note = await createNote(
        {
          tenantId: context.tenantId,
          entityType: targetKind as NoteEntityType,
          entityId: payload.targetId,
          content: payload.body,
          authorId: context.executedBy,
          // Voice notes come from the operator. The audit subsystem
          // tracks the actor; role here is the high-level bucket
          // the notes UI groups by.
          authorRole: 'voice',
        },
        this.noteRepo,
        // WS3 — emit the note.created audit event (joins the ambient tenant
        // transaction established by the executor / request middleware).
        this.auditRepo,
      );
      return { success: true, resultEntityId: note.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Note creation failed',
      };
    }
  }
}

// ─── record_payment ────────────────────────────────────────────
//
// Mirrors POST /api/payments. The voice schema's enum is a slightly
// narrower vocabulary than the invoice payment system — we map
// 'card' onto 'credit_card' (the canonical name) and keep cash /
// check / other one-to-one. `paymentReference` (free-text from the
// transcript: "check 1042") becomes `providerReference` on the
// stored Payment.
//
// The underlying recordPayment() validates that the invoice is
// payable (status open / partially_paid) and that amount ≤ amount
// due — we surface those errors verbatim to the operator instead of
// re-wrapping.
const VOICE_PAYMENT_METHOD_MAP: Record<string, PaymentMethod> = {
  cash: 'cash',
  check: 'check',
  card: 'credit_card',
  other: 'other',
};

export class RecordPaymentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'record_payment';
  // recordPayment() awaits paymentReceiptNotifier.notifyPaymentReceived (customer
  // SMS/email receipt via the delivery provider) and an owner push — external
  // network I/O. Its DB writes are already crash-safe outside a shared executor
  // tx (atomic invoice credit + ledger reconciliation backstop), so run it out
  // of the executor transaction.
  performsExternalIo = true;

  constructor(
    private readonly paymentRepo?: PaymentRepository,
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
    private readonly paymentReceiptNotifier?: PaymentReceiptNotifier,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (records no payment) without
  // both the payment repo and the invoice repo. Boot fails when a pool is
  // configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.paymentRepo) && Boolean(this.invoiceRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!isUuid(payload.invoiceId)) {
      return {
        success: false,
        error: 'Payload must include a valid invoiceId UUID (resolve invoiceReference at review time first)',
      };
    }
    if (typeof payload.amountCents !== 'number' || payload.amountCents <= 0) {
      return { success: false, error: 'Payload must include a positive amountCents' };
    }
    const voiceMethod = payload.paymentMethod;
    if (typeof voiceMethod !== 'string' || !(voiceMethod in VOICE_PAYMENT_METHOD_MAP)) {
      return { success: false, error: 'Payload must specify paymentMethod' };
    }
    const method = VOICE_PAYMENT_METHOD_MAP[voiceMethod];

    if (!this.paymentRepo || !this.invoiceRepo) {
      // Dev/test wiring without repos.
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const { payment } = await recordPayment(
        {
          tenantId: context.tenantId,
          invoiceId: payload.invoiceId,
          amountCents: payload.amountCents,
          method,
          providerReference:
            typeof payload.paymentReference === 'string' ? payload.paymentReference : undefined,
          processedBy: context.executedBy,
        },
        this.invoiceRepo,
        this.paymentRepo,
        this.moneyStateDeps,
        this.paymentReceiptNotifier,
        this.auditRepo,
        { actorRole: 'system', correlationId: proposal.id },
      );
      return { success: true, resultEntityId: payment.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Payment recording failed',
      };
    }
  }
}

// ─── send_invoice ──────────────────────────────────────────────
//
// Outbound delivery — email or SMS. There's no general comms gateway
// yet, so the handler delegates to a small `InvoiceDeliveryProvider`
// interface. The default Noop logs the dispatch shape and returns
// success; a real outbound provider replaces the Noop in `app.ts`
// without touching the handler.
//
// Provider failures bubble as ExecutionResult.error rather than
// swallowing — operators need to know if the email never went out.
export interface InvoiceDispatch {
  tenantId: string;
  invoiceId: string;
  channel: 'email' | 'sms';
  recipient?: string;
  customMessage?: string;
}

export interface InvoiceDeliveryProvider {
  send(dispatch: InvoiceDispatch): Promise<{ providerMessageId?: string }>;
}

/**
 * Default delivery provider. Records the most recent dispatch on
 * `lastDispatch` so dev/test consumers can observe what would have
 * been sent. NEVER sends real bytes. Production swaps this for a
 * real provider.
 */
export class NoopInvoiceDeliveryProvider implements InvoiceDeliveryProvider {
  lastDispatch: InvoiceDispatch | null = null;

  async send(dispatch: InvoiceDispatch): Promise<{ providerMessageId?: string }> {
    this.lastDispatch = dispatch;
    return { providerMessageId: `noop-${uuidv4()}` };
  }
}

// ─── send_estimate ─────────────────────────────────────────────
//
// Outbound delivery of an estimate (the customer-facing approval link),
// mirroring send_invoice. Same 'comms' gate: never auto-approves, so an
// operator/supervisor must approve before the executor runs this. Lets
// the voice flow "draft an estimate → send it" once a human signs off.
export interface EstimateDispatch {
  tenantId: string;
  estimateId: string;
  channel: 'email' | 'sms';
  recipient?: string;
  customMessage?: string;
}

export interface EstimateDeliveryProvider {
  send(dispatch: EstimateDispatch): Promise<{ providerMessageId?: string }>;
}

export class NoopEstimateDeliveryProvider implements EstimateDeliveryProvider {
  lastDispatch: EstimateDispatch | null = null;

  async send(dispatch: EstimateDispatch): Promise<{ providerMessageId?: string }> {
    this.lastDispatch = dispatch;
    return { providerMessageId: `noop-${uuidv4()}` };
  }
}

export class SendEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_estimate';
  // Awaits provider.send() — outbound estimate email/SMS delivery.
  performsExternalIo = true;

  constructor(private readonly provider?: EstimateDeliveryProvider) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!isUuid(payload.estimateId)) {
      return {
        success: false,
        error: 'Payload must include a valid estimateId UUID (resolve estimateReference at review time first)',
      };
    }
    if (payload.channel !== 'email' && payload.channel !== 'sms') {
      return { success: false, error: 'Payload must specify channel as email or sms' };
    }

    if (!this.provider) {
      // Dev wiring without a provider. Returns synthetic id.
      return { success: true, resultEntityId: uuidv4() };
    }

    const dispatch: EstimateDispatch = {
      tenantId: context.tenantId,
      estimateId: payload.estimateId,
      channel: payload.channel,
      recipient: typeof payload.recipient === 'string' ? payload.recipient : undefined,
      customMessage: typeof payload.customMessage === 'string' ? payload.customMessage : undefined,
    };

    try {
      const sent = await this.provider.send(dispatch);
      return { success: true, resultEntityId: sent.providerMessageId ?? uuidv4() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Estimate delivery failed',
      };
    }
  }
}

export class SendInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_invoice';
  // Awaits provider.send() — outbound invoice email/SMS delivery.
  performsExternalIo = true;

  constructor(private readonly provider?: InvoiceDeliveryProvider) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!isUuid(payload.invoiceId)) {
      return {
        success: false,
        error: 'Payload must include a valid invoiceId UUID (resolve invoiceReference at review time first)',
      };
    }
    if (payload.channel !== 'email' && payload.channel !== 'sms') {
      return { success: false, error: 'Payload must specify channel as email or sms' };
    }

    if (!this.provider) {
      // Dev wiring without a provider. Returns synthetic id.
      return { success: true, resultEntityId: uuidv4() };
    }

    const dispatch: InvoiceDispatch = {
      tenantId: context.tenantId,
      invoiceId: payload.invoiceId,
      channel: payload.channel,
      recipient: typeof payload.recipient === 'string' ? payload.recipient : undefined,
      customMessage: typeof payload.customMessage === 'string' ? payload.customMessage : undefined,
    };

    try {
      const sent = await this.provider.send(dispatch);
      return { success: true, resultEntityId: sent.providerMessageId ?? uuidv4() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Invoice delivery failed',
      };
    }
  }
}
