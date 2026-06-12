/**
 * Voice-extended execution handlers — production wire-up tests.
 *
 * TDD path:
 *   - add_note      → calls NoteRepository.create with mapped fields
 *   - record_payment → calls recordPayment() with the real
 *                       PaymentRepository + InvoiceRepository pair,
 *                       mapping voice `card` → invoice `credit_card`
 *                       and `paymentReference` → `providerReference`.
 *   - send_invoice  → dispatches via InvoiceDeliveryProvider; the
 *                       Noop default is the production gate (real
 *                       provider is a follow-up slice).
 *
 * Each handler also keeps its existing failure-mode tests (missing
 * fields → handler-level rejection) so the schema contract isn't
 * silently weakened by the wire-up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { applyChainMetadata } from '../../../src/proposals/chain';
import { resolveChainReferences } from '../../../src/proposals/execution/chain-resolution';
import {
  AddNoteExecutionHandler,
  SendInvoiceExecutionHandler,
  SendEstimateExecutionHandler,
  RecordPaymentExecutionHandler,
  NoopInvoiceDeliveryProvider,
  NoopEstimateDeliveryProvider,
} from '../../../src/proposals/execution/voice-extended-handlers';
import { InMemoryNoteRepository } from '../../../src/notes/note';
import {
  InMemoryPaymentRepository,
  Payment,
} from '../../../src/invoices/payment';
import {
  InMemoryInvoiceRepository,
  Invoice,
  createInvoice,
} from '../../../src/invoices/invoice';

function fakeApproved(
  proposalType: ProposalType,
  payload: Record<string, unknown>
): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
    approvedAt: new Date(now.getTime() - 10_000),
  };
}

const validUuid = '550e8400-e29b-41d4-a716-446655440000';
const otherUuid = '660e8400-e29b-41d4-a716-446655440001';

// ─── add_note real wire-up ─────────────────────────────────────
//
// The execution handler maps the proposal's `targetKind` (job /
// customer / invoice / estimate / appointment) to the NoteRepository's
// `entityType` (customer / location / job / estimate / invoice). The
// proposal's `body` becomes `content`, the `executedBy` becomes
// `authorId`. `targetId` MUST be a UUID — free-text `targetReference`
// alone is not enough to actually persist the note.
describe('AddNoteExecutionHandler — real NoteRepository wire-up', () => {
  let noteRepo: InMemoryNoteRepository;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
  });

  it('persists a note via NoteRepository when targetId is a valid UUID', async () => {
    const handler = new AddNoteExecutionHandler(noteRepo);
    const proposal = fakeApproved('add_note', {
      body: 'customer wants a call before arrival',
      targetKind: 'job',
      targetId: validUuid,
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();

    const stored = await noteRepo.findById('t-1', result.resultEntityId!);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe('customer wants a call before arrival');
    expect(stored!.entityType).toBe('job');
    expect(stored!.entityId).toBe(validUuid);
    expect(stored!.authorId).toBe('u-1');
  });

  it('resolves a chained add_note token onto targetId and attaches to the parent-created entity', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const handler = new AddNoteExecutionHandler(noteRepo);
    const parentJobId = '770e8400-e29b-41d4-a716-446655440002';
    const parent = fakeApproved('create_job', {
      customerId: validUuid,
      title: 'Install',
    });
    parent.id = 'p-parent';
    parent.status = 'executed';
    parent.resultEntityId = parentJobId;
    applyChainMetadata(parent, {
      chainId: 'c-note',
      chainIndex: 0,
      chainLength: 2,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const note = fakeApproved('add_note', {
      body: 'Gate code is 1234',
      targetKind: 'customer',
      targetId: validUuid,
    });
    note.id = 'p-note';
    applyChainMetadata(note, {
      chainId: 'c-note',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'targetId', parentChainIndex: 0, entityKind: 'jobId' }],
    });
    note.status = 'approved';
    await proposalRepo.createMany([parent, note]);

    const resolution = await resolveChainReferences(note, { proposalRepo });
    expect(resolution).toMatchObject({ status: 'resolved' });
    const result = await handler.execute(
      { ...note, payload: resolution.status === 'resolved' ? resolution.payload : note.payload },
      { tenantId: 't-1', executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const stored = await noteRepo.findById('t-1', result.resultEntityId!);
    expect(stored).toMatchObject({
      entityType: 'job',
      entityId: parentJobId,
      content: 'Gate code is 1234',
    });
  });

  it('rejects when only targetReference is supplied — needs a resolved UUID', async () => {
    const handler = new AddNoteExecutionHandler(noteRepo);
    const proposal = fakeApproved('add_note', {
      body: 'note text',
      targetKind: 'job',
      targetReference: 'Rodriguez',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/targetId/);
  });

  it('rejects when targetKind is not a NoteRepository entity type', async () => {
    const handler = new AddNoteExecutionHandler(noteRepo);
    // 'appointment' is a valid voice targetKind but NOT a valid
    // NoteRepository entityType (which is customer/location/job/
    // estimate/invoice). Handler must reject so we never persist
    // a note that the notes UI can't display.
    const proposal = fakeApproved('add_note', {
      body: 'note text',
      targetKind: 'appointment',
      targetId: validUuid,
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entityType|targetKind/);
  });

  it('still rejects when body is empty (existing schema-level guard preserved)', async () => {
    const handler = new AddNoteExecutionHandler(noteRepo);
    const proposal = fakeApproved('add_note', {
      body: '',
      targetKind: 'job',
      targetId: validUuid,
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
  });
});

// ─── record_payment real wire-up ───────────────────────────────
//
// The execution handler calls recordPayment() with mapped fields:
//   payload.invoiceId        → input.invoiceId (must be UUID)
//   payload.amountCents      → input.amountCents (integer cents)
//   payload.paymentMethod    → input.method
//                              voice 'card' maps to 'credit_card'
//                              voice 'cash'/'check'/'other' pass through
//   payload.paymentReference → input.providerReference (free-text)
//
// recordPayment internally validates that the invoice is payable and
// updates invoice balances; the handler relies on that guarantee
// rather than re-implementing it.
describe('RecordPaymentExecutionHandler — real PaymentRepository wire-up', () => {
  let paymentRepo: InMemoryPaymentRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let invoice: Invoice;

  beforeEach(async () => {
    paymentRepo = new InMemoryPaymentRepository();
    invoiceRepo = new InMemoryInvoiceRepository();

    // Seed an invoice in the 'open' state with $500 due so the
    // payment recording path has something real to write against.
    invoice = await createInvoice(
      {
        tenantId: 't-1',
        invoiceNumber: 'INV-TEST-1',
        jobId: otherUuid,
        // billing-engine LineItem requires every numeric field —
        // calculateDocumentTotals reads totalCents directly. The
        // production createInvoice route normalizes user input;
        // here we hand-construct a valid item so the totals ladder
        // computes a clean $500 due.
        lineItems: [
          {
            id: 'li-1',
            description: 'Pipe repair',
            quantity: 1,
            unitPriceCents: 50000,
            totalCents: 50000,
            sortOrder: 0,
            taxable: false,
            category: 'labor',
          },
        ],
        createdBy: 'u-1',
      },
      invoiceRepo
    );
    // createInvoice may produce a 'draft' invoice — recordPayment
    // requires open/partially_paid. Force it to 'open' so the test
    // exercises the real wire-up rather than the validation guard.
    await invoiceRepo.update('t-1', invoice.id, {
      status: 'open',
      amountDueCents: invoice.totals.totalCents,
    });
  });

  it('records a payment and updates invoice balances', async () => {
    const handler = new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo);
    const proposal = fakeApproved('record_payment', {
      invoiceId: invoice.id,
      amountCents: 50000,
      paymentMethod: 'cash',
      paymentReference: 'check #1042',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();

    const payments = await paymentRepo.findByInvoice('t-1', invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(50000);
    expect(payments[0].method).toBe('cash');
    // paymentReference was mapped onto providerReference per
    // the real PaymentRepository contract.
    expect(payments[0].providerReference).toBe('check #1042');
    expect(payments[0].processedBy).toBe('u-1');

    const updated = await invoiceRepo.findById('t-1', invoice.id);
    expect(updated!.amountDueCents).toBe(0);
    expect(updated!.status).toBe('paid');
  });

  it('maps voice paymentMethod=card → invoice method=credit_card', async () => {
    const handler = new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo);
    const proposal = fakeApproved('record_payment', {
      invoiceId: invoice.id,
      amountCents: 25000,
      paymentMethod: 'card',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);

    const payments = await paymentRepo.findByInvoice('t-1', invoice.id);
    expect(payments[0].method).toBe('credit_card');
  });

  it('rejects when invoiceId is missing (only invoiceReference provided)', async () => {
    const handler = new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo);
    const proposal = fakeApproved('record_payment', {
      invoiceReference: 'INV-0042',
      amountCents: 10000,
      paymentMethod: 'cash',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invoiceId/);
  });

  it('surfaces underlying recordPayment validation errors (over-payment)', async () => {
    const handler = new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo);
    const proposal = fakeApproved('record_payment', {
      invoiceId: invoice.id,
      amountCents: 99999999, // wildly over the $500 due
      paymentMethod: 'cash',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds amount due/);
  });
});

// ─── send_invoice via InvoiceDeliveryProvider ──────────────────
//
// No production-grade outbound email/SMS subsystem exists yet, so
// the handler is wired against a small `InvoiceDeliveryProvider`
// abstraction. The default `NoopInvoiceDeliveryProvider` records the
// dispatch but never sends real bytes — its `send` call is logged
// but the handler still returns success so the proposal lifecycle
// completes. The real provider (SendGrid / Twilio) is a follow-up
// slice; until then the abstraction means the handler doesn't need
// the env-flag gate AND can be swapped without touching the
// handler.
describe('SendInvoiceExecutionHandler — InvoiceDeliveryProvider wire-up', () => {
  it('dispatches via the provider when wired with a Noop default', async () => {
    const provider = new NoopInvoiceDeliveryProvider();
    const handler = new SendInvoiceExecutionHandler(provider);
    const proposal = fakeApproved('send_invoice', {
      invoiceId: validUuid,
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
    // Noop provider records what it would have sent so tests / dev
    // can observe the dispatch shape.
    expect(provider.lastDispatch).toEqual({
      tenantId: 't-1',
      invoiceId: validUuid,
      channel: 'email',
      recipient: undefined,
      customMessage: undefined,
    });
  });

  it('forwards recipient and customMessage to the provider', async () => {
    const provider = new NoopInvoiceDeliveryProvider();
    const handler = new SendInvoiceExecutionHandler(provider);
    const proposal = fakeApproved('send_invoice', {
      invoiceId: validUuid,
      channel: 'sms',
      recipient: '+15555550100',
      customMessage: 'Thanks for your business',
    });

    await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(provider.lastDispatch?.channel).toBe('sms');
    expect(provider.lastDispatch?.recipient).toBe('+15555550100');
    expect(provider.lastDispatch?.customMessage).toBe('Thanks for your business');
  });

  it('rejects when invoiceId is missing (only invoiceReference provided)', async () => {
    const provider = new NoopInvoiceDeliveryProvider();
    const handler = new SendInvoiceExecutionHandler(provider);
    const proposal = fakeApproved('send_invoice', {
      invoiceReference: 'INV-0042',
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invoiceId/);
  });

  it('rejects when channel is invalid', async () => {
    const provider = new NoopInvoiceDeliveryProvider();
    const handler = new SendInvoiceExecutionHandler(provider);
    const proposal = fakeApproved('send_invoice', {
      invoiceId: validUuid,
      channel: 'fax',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/channel/);
  });

  it('surfaces provider failures rather than swallowing them', async () => {
    const failing = {
      async send() {
        throw new Error('provider down');
      },
    };
    const handler = new SendInvoiceExecutionHandler(failing);
    const proposal = fakeApproved('send_invoice', {
      invoiceId: validUuid,
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/provider down/);
  });
});

describe('SendEstimateExecutionHandler — EstimateDeliveryProvider wire-up', () => {
  it('dispatches via the provider when wired with a Noop default', async () => {
    const provider = new NoopEstimateDeliveryProvider();
    const handler = new SendEstimateExecutionHandler(provider);
    const proposal = fakeApproved('send_estimate', {
      estimateId: validUuid,
      channel: 'sms',
      recipient: '+15555550100',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
    expect(provider.lastDispatch).toEqual({
      tenantId: 't-1',
      estimateId: validUuid,
      channel: 'sms',
      recipient: '+15555550100',
      customMessage: undefined,
    });
  });

  it('rejects when estimateId is missing (only estimateReference provided)', async () => {
    const handler = new SendEstimateExecutionHandler(new NoopEstimateDeliveryProvider());
    const proposal = fakeApproved('send_estimate', {
      estimateReference: 'EST-0042',
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/estimateId/);
  });

  it('rejects when channel is invalid', async () => {
    const handler = new SendEstimateExecutionHandler(new NoopEstimateDeliveryProvider());
    const proposal = fakeApproved('send_estimate', {
      estimateId: validUuid,
      channel: 'fax',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/channel/);
  });

  it('surfaces provider failures rather than swallowing them', async () => {
    const failing = {
      async send() {
        throw new Error('provider down');
      },
    };
    const handler = new SendEstimateExecutionHandler(failing);
    const proposal = fakeApproved('send_estimate', {
      estimateId: validUuid,
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/provider down/);
  });
});
