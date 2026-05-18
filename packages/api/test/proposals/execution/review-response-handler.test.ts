import { describe, it, expect, vi } from 'vitest';
import {
  ReviewResponseExecutionHandler,
  type GoogleBusinessReplyResolver,
  type ReviewPrivateMessageSender,
} from '../../../src/proposals/execution/review-response-handler';
import { InMemoryServiceCreditRepository } from '../../../src/reputation/service-credit';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { GoogleBusinessQuotaError } from '../../../src/reputation/google-business-client';
import type { Proposal } from '../../../src/proposals/proposal';
import type { ReviewResponseProposalPayload } from '@ai-service-os/shared';

const TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';
const PROPOSAL_ID = '55555555-5555-5555-5555-555555555555';
const REVIEW_ID = '11111111-1111-1111-1111-111111111111';

function makePayload(
  overrides: Partial<ReviewResponseProposalPayload> = {},
): ReviewResponseProposalPayload {
  return {
    reviewId: REVIEW_ID,
    classification: 'specific_complaint',
    publicResponse: { text: 'We apologize.', approved: false },
    privateFollowUp: null,
    serviceCredit: null,
    ...overrides,
  };
}

function makeProposal(
  payload: ReviewResponseProposalPayload,
  overrides: Partial<Proposal> = {},
): Proposal {
  return {
    id: PROPOSAL_ID,
    tenantId: TENANT,
    proposalType: 'review_response_proposal',
    status: 'approved',
    payload: payload as unknown as Record<string, unknown>,
    summary: 'Review response',
    createdBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeResolver(): GoogleBusinessReplyResolver {
  return {
    resolve: vi.fn(async () => ({
      accessToken: 'tok',
      accountId: 'acct',
      locationId: 'loc',
      reviewExternalId: 'rext',
    })),
  };
}

function makeSender(): ReviewPrivateMessageSender {
  return {
    send: vi.fn(async () => ({ providerMessageId: 'msg-1' })),
  };
}

describe('P7-026 ReviewResponseExecutionHandler', () => {
  it('proposalType is review_response_proposal', () => {
    const h = new ReviewResponseExecutionHandler();
    expect(h.proposalType).toBe('review_response_proposal');
  });

  describe('dispatch on approved flag', () => {
    it('publicResponse.approved=false → does NOT call Google reply', async () => {
      const resolver = makeResolver();
      const replyFn = vi.fn();
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        resolver,
        undefined,
        undefined,
        replyFn,
      );
      await handler.execute(makeProposal(makePayload()), {
        tenantId: TENANT,
        executedBy: 'user',
      });
      expect(replyFn).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it('publicResponse.approved=true → calls Google reply ONCE', async () => {
      const resolver = makeResolver();
      const replyFn = vi.fn(async () => ({
        comment: 'We apologize.',
        updateTime: '2026-05-17T11:00:00Z',
      }));
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        resolver,
        undefined,
        undefined,
        replyFn,
      );
      const result = await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'We apologize.', approved: true },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(replyFn).toHaveBeenCalledTimes(1);
      expect(replyFn).toHaveBeenCalledWith(
        'tok',
        'acct',
        'loc',
        'rext',
        'We apologize.',
      );
      expect(result.success).toBe(true);
    });

    it('approving only publicResponse: no credit insert, no notification send', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const resolver = makeResolver();
      const sender = makeSender();
      const replyFn = vi.fn(async () => ({
        comment: 'x',
        updateTime: '2026-05-17T11:00:00Z',
      }));
      const handler = new ReviewResponseExecutionHandler(
        repo,
        resolver,
        sender,
        undefined,
        replyFn,
      );
      await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'x', approved: true },
            privateFollowUp: {
              customerId: CUSTOMER,
              channel: 'email',
              body: 'p',
              approved: false,
            },
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 5000,
              approved: false,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(replyFn).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalled();
      expect(repo.size()).toBe(0);
    });

    it('approving public + credit: issues credit but no notification', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const resolver = makeResolver();
      const sender = makeSender();
      const replyFn = vi.fn(async () => ({
        comment: 'x',
        updateTime: '2026-05-17T11:00:00Z',
      }));
      const handler = new ReviewResponseExecutionHandler(
        repo,
        resolver,
        sender,
        undefined,
        replyFn,
      );
      const result = await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'x', approved: true },
            privateFollowUp: {
              customerId: CUSTOMER,
              channel: 'email',
              body: 'p',
              approved: false,
            },
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 5000,
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
      expect(replyFn).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalled();
      expect(repo.size()).toBe(1);
      expect(await repo.sumIssuedInLast12Months(TENANT, CUSTOMER)).toBe(5000);
    });

    it('approving all 3 components executes all 3', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const resolver = makeResolver();
      const sender = makeSender();
      const replyFn = vi.fn(async () => ({
        comment: 'x',
        updateTime: '2026-05-17T11:00:00Z',
      }));
      const handler = new ReviewResponseExecutionHandler(
        repo,
        resolver,
        sender,
        undefined,
        replyFn,
      );
      await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'public', approved: true },
            privateFollowUp: {
              customerId: CUSTOMER,
              channel: 'email',
              body: 'private',
              approved: true,
            },
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 2500,
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(replyFn).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(repo.size()).toBe(1);
    });
  });

  describe('idempotency via per-component key', () => {
    it('passes a stable idempotency key to the private message sender', async () => {
      const sender = makeSender();
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        undefined,
        sender,
      );
      await handler.execute(
        makeProposal(
          makePayload({
            privateFollowUp: {
              customerId: CUSTOMER,
              channel: 'sms',
              body: 'p',
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      const sendCall = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.idempotencyKey).toBe(`review-response-private:${PROPOSAL_ID}`);
    });

    it('Google PUT reply is naturally idempotent — handler does not maintain its own dedup', async () => {
      const resolver = makeResolver();
      const replyFn = vi.fn(async () => ({
        comment: 'x',
        updateTime: '2026-05-17T11:00:00Z',
      }));
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        resolver,
        undefined,
        undefined,
        replyFn,
      );
      const proposal = makeProposal(
        makePayload({
          publicResponse: { text: 'x', approved: true },
        }),
      );
      // Two executes — the executor's idempotency layer would normally
      // block this in production. The handler itself does not block,
      // and that's intentional — the Google API tolerates the duplicate.
      await handler.execute(proposal, { tenantId: TENANT, executedBy: 'user' });
      await handler.execute(proposal, { tenantId: TENANT, executedBy: 'user' });
      expect(replyFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('audit emission is failure-soft', () => {
    it('audit failure does NOT unwind mutations', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const auditRepo = new InMemoryAuditRepository();
      // Override create to throw
      auditRepo.create = vi.fn(async () => {
        throw new Error('audit pipeline down');
      });
      const handler = new ReviewResponseExecutionHandler(
        repo,
        undefined,
        undefined,
        auditRepo,
      );
      const result = await handler.execute(
        makeProposal(
          makePayload({
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 2500,
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
      expect(repo.size()).toBe(1);
    });

    it('successful execution emits review_response.executed audit event with subResults', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const auditRepo = new InMemoryAuditRepository();
      const handler = new ReviewResponseExecutionHandler(
        repo,
        undefined,
        undefined,
        auditRepo,
      );
      await handler.execute(
        makeProposal(
          makePayload({
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 2500,
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      const events = auditRepo.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('review_response.executed');
      expect(events[0].entityType).toBe('proposal');
      expect(events[0].entityId).toBe(PROPOSAL_ID);
      expect(events[0].metadata?.subResults).toBeDefined();
    });
  });

  describe('Google reply error surfacing', () => {
    it('quota error → success=false with quota_exceeded label', async () => {
      const resolver = makeResolver();
      const replyFn = vi.fn(async () => {
        throw new GoogleBusinessQuotaError('quota');
      });
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        resolver,
        undefined,
        undefined,
        replyFn,
      );
      const result = await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'x', approved: true },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota_exceeded');
    });

    it('resolver returning null → success=false with descriptive error', async () => {
      const resolver: GoogleBusinessReplyResolver = {
        resolve: vi.fn(async () => null),
      };
      const handler = new ReviewResponseExecutionHandler(
        undefined,
        resolver,
        undefined,
        undefined,
        vi.fn(),
      );
      const result = await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'x', approved: true },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No Google Business reply context');
    });
  });

  describe('no deps wired — degrades to passthrough', () => {
    it('with no Google resolver: public approved still returns ok=true (test/dev path)', async () => {
      const handler = new ReviewResponseExecutionHandler();
      const result = await handler.execute(
        makeProposal(
          makePayload({
            publicResponse: { text: 'x', approved: true },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
    });

    it('with no sender: private approved still returns ok=true (logs warning)', async () => {
      const handler = new ReviewResponseExecutionHandler();
      const result = await handler.execute(
        makeProposal(
          makePayload({
            privateFollowUp: {
              customerId: CUSTOMER,
              channel: 'email',
              body: 'p',
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
    });

    it('with no creditRepo: credit approved still returns ok=true (test/dev path)', async () => {
      const handler = new ReviewResponseExecutionHandler();
      const result = await handler.execute(
        makeProposal(
          makePayload({
            serviceCredit: {
              customerId: CUSTOMER,
              amountCents: 2500,
              approved: true,
            },
          }),
        ),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
    });

    it('with no components approved: returns success=true with no mutations', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const sender = makeSender();
      const resolver = makeResolver();
      const replyFn = vi.fn();
      const handler = new ReviewResponseExecutionHandler(
        repo,
        resolver,
        sender,
        undefined,
        replyFn,
      );
      const result = await handler.execute(
        makeProposal(makePayload()),
        { tenantId: TENANT, executedBy: 'user' },
      );
      expect(result.success).toBe(true);
      expect(replyFn).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
      expect(repo.size()).toBe(0);
    });
  });
});
