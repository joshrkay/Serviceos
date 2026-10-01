/**
 * #1331 — classifier→contract key aliases for the tradesperson write intents
 * on the LIVE voice turn (phone + in-app share `buildVoiceProposalPayload`).
 *
 * Layer 2 weekly run 36829085635 (real gpt-4o-mini classifier, real phone
 * path) logged "voice payload failed its proposal contract" for every one of
 * these: the classifier emits the extraction keys the taxonomy names
 * (`materialDescription`, `amount`, `expenseCategory`, …) while the payload
 * contracts read `description`, `amountCents`, `category`, … The memo/chat
 * task handlers already translate them; the live-turn leg did not, so every
 * phone-drafted request was born gated on fields the caller had SAID, and the
 * caller heard "a few details still need to be sorted out". Each mapping
 * below mirrors the named task handler.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const deps = { tenantId: 'tenant-1' };
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

function input(proposalType: string, entities: Record<string, unknown>, utterance?: string) {
  return {
    intent: proposalType,
    proposalType: proposalType as never,
    entities,
    envelope: { sessionId: 'sess-1' },
    callerCustomerId: CUSTOMER_ID,
    ...(utterance ? { utterance } : {}),
  };
}

describe('#1331 — tradesperson write-intent payload aliases', () => {
  it('add_material: materialDescription/materialQuantity become description/quantity (AddMaterialTaskHandler)', async () => {
    const result = await buildVoiceProposalPayload(
      input('add_material', { materialDescription: 'half-inch PEX', materialQuantity: 3 }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ description: 'half-inch PEX', quantity: 3 });
    expect(result.missingFieldPaths).toEqual([]);
  });

  it('apply_credit: the spoken amount (cents) and creditReason fill amountCents/reason; only the unresolved invoice stays gated (ApplyCreditTaskHandler)', async () => {
    const result = await buildVoiceProposalPayload(
      input('apply_credit', { amount: 5000, creditReason: 'the callback', jobReference: 'Henderson' }),
      deps,
    );
    expect(result.payload).toMatchObject({ amountCents: 5000, reason: 'the callback' });
    expect(result.missingFieldPaths).toEqual(['invoiceId']);
  });

  it('record_refund: amount/refundMethod/refundReason fill amountCents/method/reason, method defaulting to cash (RecordRefundTaskHandler)', async () => {
    const spoken = await buildVoiceProposalPayload(
      input('record_refund', { amount: 10000, refundMethod: 'cash', refundReason: "the recharge didn't hold" }),
      deps,
    );
    expect(spoken.payload).toMatchObject({ amountCents: 10000, method: 'cash', reason: "the recharge didn't hold" });
    expect(spoken.missingFieldPaths).toEqual(['invoiceId']);

    const unstated = await buildVoiceProposalPayload(input('record_refund', { amount: 2500 }), deps);
    expect(unstated.payload).toMatchObject({ amountCents: 2500, method: 'cash' });
  });

  it('log_expense: amount/expenseCategory/expenseDescription fill amountCents/category/description; spentAt (tenant-local today) stays gated (LogExpenseTaskHandler)', async () => {
    const result = await buildVoiceProposalPayload(
      input('log_expense', { amount: 5500, expenseCategory: 'fuel', expenseDescription: 'fuel' }),
      deps,
    );
    expect(result.payload).toMatchObject({ amountCents: 5500, category: 'fuel', description: 'fuel' });
    expect(result.missingFieldPaths).toEqual(['spentAt']);

    const bare = await buildVoiceProposalPayload(
      input('log_expense', { amount: 1200 }, 'Log a 12 dollar expense.'),
      deps,
    );
    expect(bare.payload).toMatchObject({ category: 'other', description: 'Log a 12 dollar expense.' });
  });

  it('create_service_agreement: serviceAgreementName/amount fill name/priceCents (CreateServiceAgreementTaskHandler)', async () => {
    const result = await buildVoiceProposalPayload(
      input('create_service_agreement', {
        serviceAgreementName: 'Annual maintenance plan',
        amount: 2900,
        serviceAgreementCadence: 'monthly',
      }),
      deps,
    );
    expect(result.payload).toMatchObject({ name: 'Annual maintenance plan', priceCents: 2900 });
    expect(result.missingFieldPaths).not.toContain('name');
    expect(result.missingFieldPaths).not.toContain('priceCents');
  });

  it('send_customer_message: customerMessageChannel/Body fill channel/body, channel sms unless email was said (SendCustomerMessageTaskHandler)', async () => {
    const result = await buildVoiceProposalPayload(
      input('send_customer_message', {
        customerMessageBody: 'Your part arrived — we can come by Thursday morning.',
        customerMessageChannel: 'sms',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: 'Your part arrived — we can come by Thursday morning.',
    });

    const email = await buildVoiceProposalPayload(
      input('send_customer_message', { customerMessageBody: 'Invoice attached.', customerMessageChannel: 'email' }),
      deps,
    );
    expect(email.payload).toMatchObject({ channel: 'email' });
  });

  it('mark_lead_lost: lostReason fills reason, falling back to the spoken request (MarkLeadLostTaskHandler)', async () => {
    const said = await buildVoiceProposalPayload(
      input('mark_lead_lost', { leadReference: 'the Johnson lead', lostReason: 'went with a competitor' }),
      deps,
    );
    expect(said.ok).toBe(true);
    expect(said.payload).toMatchObject({ reason: 'went with a competitor' });

    const unsaid = await buildVoiceProposalPayload(
      input('mark_lead_lost', { leadReference: 'the Johnson lead' }, 'Mark the Johnson lead as lost.'),
      deps,
    );
    expect(unsaid.payload).toMatchObject({ reason: 'Mark the Johnson lead as lost.' });
  });
});
