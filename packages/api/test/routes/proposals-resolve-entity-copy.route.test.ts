/**
 * A3-4 — what POST /api/proposals/:id/resolve-entity says to the owner.
 *
 * Mobile shows the server's `message` verbatim (useProposalReview's
 * decodeError), so every refusal this route can give is owner copy: short,
 * plain, and never "proposal", "AI", "agent" or the other words owner copy
 * must not use. The service's own errors (and the shared ones it passes
 * through: assertStatusWrite's "Cannot transition proposal from ...",
 * NotFoundError's "Proposal not found: <id>", the gateway's "AI provider rate
 * limit reached ...") are mapped at this route, keeping their status codes.
 */
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository, createProposal, type Proposal } from '../../src/proposals/proposal';
import { InMemoryTransactionRunner } from '../../src/db/tenant-transaction';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { RedraftHandlerFactory } from '../../src/proposals/redraft-handler-factory';
import type { TaskHandler } from '../../src/ai/tasks/task-handlers';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../src/shared/errors';
import { ownerFacingPickError } from '../../src/proposals/resolve-entity';

const TENANT = 'tenant-a34-copy';
const USER = 'owner-a34-copy';
const CUST_A = '11111111-1111-4111-8111-111111111111';
const CUST_B = '22222222-2222-4222-8222-222222222222';

/** Words owner-facing copy must never say. */
const BANNED = /\b(ai|agent|dashboard|verify|provisioning|proposals?|stripe|twilio)\b/i;

function clarification(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT,
      proposalType: 'voice_clarification',
      summary: 'Which customer? "Bob" matched 2 records',
      createdBy: USER,
      payload: {
        transcript: 'invoice Bob for the water heater',
        reason: 'ambiguous_entity',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, label: 'Bob Jones', score: 0.81 },
        ],
      },
      sourceContext: {
        source: 'voice',
        transcript: 'invoice Bob for the water heater',
        entityKind: 'customer',
        entityReference: 'Bob',
        originalIntent: { intentType: 'create_invoice', extractedEntities: { customerName: 'Bob' } },
      },
    }),
    ...overrides,
  };
}

/** A re-draft that answers with a typed draft. */
const drafting: TaskHandler = {
  taskType: 'draft_invoice',
  handle: async (ctx) => ({
    taskType: 'draft_invoice',
    proposal: createProposal({
      tenantId: ctx.tenantId,
      proposalType: 'draft_invoice',
      payload: { customerId: CUST_B, lineItems: [{ description: 'Water heater service', quantity: 1, unitPriceCents: 45000 }] },
      summary: 'Invoice Bob Jones',
      createdBy: ctx.userId,
    }),
  }),
};

/** A re-draft whose LLM call fails with `err`. */
const failing = (err: Error): TaskHandler => ({
  taskType: 'draft_invoice',
  handle: async () => {
    throw err;
  },
});

describe('A3-4 — resolve-entity owner copy', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  function app(redraftHandler?: TaskHandler) {
    const factory: RedraftHandlerFactory | undefined = redraftHandler ? () => redraftHandler : undefined;
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
      next();
    });
    a.use(
      '/api/proposals',
      createProposalsRouter(
        proposalRepo,
        new InMemoryTransactionRunner(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        factory,
      ),
    );
    return a;
  }

  const pick = (a: express.Express, id: string, candidateId = CUST_B) =>
    request(a).post(`/api/proposals/${id}/resolve-entity`).send({ candidateId });

  function expectOwnerCopy(res: request.Response, status: number, message: string) {
    expect(res.status).toBe(status);
    expect(res.body.message).toBe(message);
    expect(res.body.message).not.toMatch(BANNED);
  }

  it('a row that is gone: 404 in plain words, with no id and no "proposal"', async () => {
    const res = await pick(app(), '9b2f6c1e-0000-4000-8000-000000000001');
    expectOwnerCopy(res, 404, 'This is no longer here, so that choice was not saved.');
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a row someone already decided: 409 in plain words', async () => {
    const seeded = await proposalRepo.create(clarification({ status: 'approved' }));
    const res = await pick(app(), seeded.id);
    expectOwnerCopy(res, 409, 'This was already handled, so that choice was not saved.');
  });

  it('a row with nothing left to pick: 400 in plain words', async () => {
    const seeded = await proposalRepo.create(
      clarification({ payload: { transcript: 'do something', reason: 'unknown_intent' }, sourceContext: { source: 'voice' } }),
    );
    const res = await pick(app(), seeded.id);
    expectOwnerCopy(res, 400, 'There is nothing left to choose here.');
  });

  it('a choice that is not on the card: 400 in plain words', async () => {
    const seeded = await proposalRepo.create(clarification());
    const res = await pick(app(), seeded.id, '33333333-3333-4333-8333-333333333333');
    expectOwnerCopy(res, 400, 'That choice is not one of the options.');
  });

  it('a decision landing between the lock and the status write: assertStatusWrite is mapped to the same plain 409', async () => {
    const seeded = await proposalRepo.create(clarification());
    // The row is approved by someone else just before the re-draft's status
    // write, so the repository's own guard refuses approved -> ready_for_review.
    const realUpdateStatus = proposalRepo.updateStatus.bind(proposalRepo);
    proposalRepo.updateStatus = async (tenantId, id, status, updates) => {
      await realUpdateStatus(tenantId, id, 'approved', {});
      return realUpdateStatus(tenantId, id, status, updates);
    };

    const res = await pick(app(drafting), seeded.id);

    expectOwnerCopy(res, 409, 'This was already handled, so that choice was not saved.');
  });

  it.each([
    [
      'the provider is down',
      new AppError('LLM_PROVIDER_UNAVAILABLE', 'All providers failed. Last error: upstream 503', 503),
      503,
    ],
    [
      'the provider is rate limited',
      new AppError(
        'LLM_RATE_LIMITED',
        'AI provider rate limit reached (requests); retry after 8.6s. Provider said: Rate limit reached',
        429,
        { retryAfterMs: 8640, providerPath: ['api.openai.com:gpt-4o-mini'], lastProvider: 'api.openai.com' },
      ),
      429,
    ],
  ])('the re-draft cannot run because %s: plain words, same status and code', async (_label, err, status) => {
    const seeded = await proposalRepo.create(clarification());
    const res = await pick(app(failing(err)), seeded.id);
    expectOwnerCopy(res, status, 'That could not be finished right now. Please try again.');
    expect(res.body.error).toBe(err.code);
    // Provider internals stay out of the response; a wait hint stays in.
    expect(res.body.details).toEqual(status === 429 ? { retryAfterMs: 8640 } : undefined);
    expect(res.body.message).not.toMatch(/openai|provider/i);
    // Nothing changed on the card.
    expect((await proposalRepo.findById(TENANT, seeded.id))!.proposalType).toBe('voice_clarification');
  });

  it('a successful pick still answers 200 with the re-drafted card', async () => {
    const seeded = await proposalRepo.create(clarification());
    const res = await pick(app(drafting), seeded.id);
    expect(res.status).toBe(200);
    expect(res.body.proposalType).toBe('draft_invoice');
    expect(res.body.status).toBe('ready_for_review');
  });
});

describe('A3-4 — ownerFacingPickError', () => {
  it('words any other ValidationError (a payload contract check) plainly, without its internal details', () => {
    const mapped = ownerFacingPickError(
      new ValidationError("Invalid payload for proposal type 'voice_clarification'", { errors: ['x'] }),
    ) as ValidationError;
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.message).toBe('That choice could not be saved.');
    expect(mapped.details).toBeUndefined();
  });

  it('keeps its own plain refusals, a permission refusal and its own 409 as they are', () => {
    for (const err of [
      new ValidationError('That choice is not one of the options.'),
      new ValidationError('There is nothing left to choose here.'),
      new ForbiddenError(),
      new ConflictError('This was already handled, so that choice was not saved.', { status: 'approved' }),
    ]) {
      expect(ownerFacingPickError(err)).toBe(err);
    }
  });

  it('leaves an error that is not an AppError alone (it answers the generic 500)', () => {
    const err = new Error('pool exhausted for proposal p-1');
    expect(ownerFacingPickError(err)).toBe(err);
  });
});
