/**
 * P7-026 — review-response execution handler tests.
 *
 * Covers:
 *   - independent approve/edit/reject of public, private, credit
 *   - PII defense-in-depth: a poisoned edited public draft is refused
 *   - the 12-month cap is enforced again at execution time
 *   - audit events fire for each approved sub-action
 *   - synthetic-mode fallback when providers are not wired
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { ReviewResponseExecutionHandler } from '../../../src/proposals/execution/review-response-handler';
import { InMemoryServiceCreditRepository } from '../../../src/reputation/service-credit-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  createProposal,
  type Proposal,
  type ProposalType,
} from '../../../src/proposals/proposal';
import type { ExecutionContext } from '../../../src/proposals/execution/handlers';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const REVIEW = '33333333-3333-3333-3333-333333333333';

function makeProposal(payload: Record<string, unknown>): Proposal {
  return createProposal({
    tenantId: TENANT,
    proposalType: 'review_response' as ProposalType,
    payload,
    summary: 'review response',
    createdBy: 'system',
  });
}

const ctx: ExecutionContext = {
  tenantId: TENANT,
  executedBy: 'owner-1',
};

describe('P7-026 ReviewResponseExecutionHandler', () => {
  let creditRepo: InMemoryServiceCreditRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    creditRepo = new InMemoryServiceCreditRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('P7-026 only executes approved sub-payloads (independent approval)', async () => {
    let publicPostCount = 0;
    let privateSendCount = 0;
    const handler = new ReviewResponseExecutionHandler({
      auditRepo,
      creditRepo,
      postPublicResponse: async () => {
        publicPostCount++;
        return { externalId: 'ext-1' };
      },
      sendPrivateApology: async () => {
        privateSendCount++;
        return { messageId: 'sms-1' };
      },
    });
    const proposal = makeProposal({
      reviewId: REVIEW,
      classification: 'specific_complaint',
      matchConfidence: 'high',
      matchedCustomerId: CUSTOMER,
      publicResponse: { draft: 'Public sorry note.', decision: 'approved' },
      // private is pending — should be skipped
      privateMessage: { channel: 'sms', draft: 'Hi.', decision: 'pending' },
      // credit is rejected — should be skipped
      serviceCredit: {
        amountCents: 5000,
        remainingCapCents: 5000,
        capApplied: false,
        decision: 'rejected',
      },
    });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(true);
    expect(publicPostCount).toBe(1);
    expect(privateSendCount).toBe(0);
    const credits = await creditRepo.findByCustomer(TENANT, CUSTOMER);
    expect(credits).toHaveLength(0);
  });

  it('P7-026 approves all three sub-payloads → all three side-effects fire + audit events emitted', async () => {
    const handler = new ReviewResponseExecutionHandler({
      auditRepo,
      creditRepo,
      postPublicResponse: async () => ({ externalId: 'ext-pub' }),
      sendPrivateApology: async () => ({ messageId: 'msg-priv' }),
    });
    const proposal = makeProposal({
      reviewId: REVIEW,
      classification: 'specific_complaint',
      matchConfidence: 'high',
      matchedCustomerId: CUSTOMER,
      publicResponse: { draft: 'We are sorry.', decision: 'approved' },
      privateMessage: { channel: 'sms', draft: 'Hi Margaret, sorry.', decision: 'approved' },
      serviceCredit: {
        amountCents: 5000,
        remainingCapCents: 5000,
        capApplied: false,
        decision: 'approved',
      },
    });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(true);

    // Credit row written
    const credits = await creditRepo.findByCustomer(TENANT, CUSTOMER);
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountCents).toBe(5000);
    expect(credits[0]?.sourceReviewId).toBe(REVIEW);

    // Three audit events
    const events = auditRepo.getAll();
    const eventTypes = events.map((e) => e.eventType).sort();
    expect(eventTypes).toEqual([
      'review.private_message_sent',
      'review.public_response_posted',
      'review.service_credit_issued',
    ]);
  });

  it('P7-026 PII defense-in-depth: edited public draft with PII is refused', async () => {
    const handler = new ReviewResponseExecutionHandler({
      auditRepo,
      creditRepo,
      postPublicResponse: async () => {
        throw new Error('should not be called');
      },
    });
    const proposal = makeProposal({
      reviewId: REVIEW,
      classification: 'specific_complaint',
      matchConfidence: 'none',
      publicResponse: {
        draft: 'sorry',
        editedText: 'Sorry, please call us at (415) 555-1234.',
        decision: 'edited',
      },
    });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PII redaction/);
  });

  it('P7-026 cap re-enforced at execution: edited credit above cap is rejected', async () => {
    // Customer already has $90 credit issued in window.
    await creditRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 9000,
      issuedAt: new Date(),
      issuedByUserId: 'u1',
      createdAt: new Date(),
    });

    const handler = new ReviewResponseExecutionHandler({
      auditRepo,
      creditRepo,
      postPublicResponse: async () => ({ externalId: 'ext-1' }),
    });
    const proposal = makeProposal({
      reviewId: REVIEW,
      classification: 'specific_complaint',
      matchConfidence: 'high',
      matchedCustomerId: CUSTOMER,
      serviceCredit: {
        amountCents: 1000,
        remainingCapCents: 1000,
        capApplied: false,
        // Owner edited the amount upward — to $50, well above the
        // remaining $10. Execution MUST refuse.
        editedAmountCents: 5000,
        decision: 'edited',
      },
    });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/12-month/);
    const credits = await creditRepo.findByCustomer(TENANT, CUSTOMER);
    // No additional credit row should have been written.
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountCents).toBe(9000);
  });

  it('P7-026 falls back to synthetic mode when no providers are wired (tests / dev)', async () => {
    const handler = new ReviewResponseExecutionHandler({
      auditRepo,
      creditRepo,
    });
    const proposal = makeProposal({
      reviewId: REVIEW,
      classification: 'specific_complaint',
      matchConfidence: 'high',
      matchedCustomerId: CUSTOMER,
      publicResponse: { draft: 'sorry', decision: 'approved' },
      privateMessage: { channel: 'sms', draft: 'sorry', decision: 'approved' },
    });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(true);
    // Synthetic mode still emits the audit events
    expect(auditRepo.getAll()).toHaveLength(2);
  });

  it('P7-026 rejects an invalid payload', async () => {
    const handler = new ReviewResponseExecutionHandler({});
    const proposal = makeProposal({ foo: 'bar' });
    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid review_response payload/);
  });
});
