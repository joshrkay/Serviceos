/**
 * The assistant chat card's UNDO WINDOW.
 *
 * `create_appointment` carries `sourceTrustTier: 'autonomous'` and is
 * capture-class, so for a permitted caller `decideInitialStatus` returns
 * 'approved' and the row is queued for execution with NO human tap. The card
 * the operator sees is therefore terminal on arrival. It reported
 * `status: 'Approved'` (commit 2 of the auto-approve follow-up) but nothing
 * else — no window — so the chat surface could not offer the undo the inbox
 * and the operator-tapped approve path both offer, even though the row is
 * 'approved' and still inside the 5s window `POST /api/proposals/:id/undo`
 * accepts.
 *
 * The card now carries `undoExpiresAt` (= `approvedAt` + UNDO_WINDOW_MS) so
 * the client anchors the SAME countdown to the server's real instant instead
 * of a fresh client 5s that ignores the round-trip already spent (see
 * packages/web useUndoableApproval, which leaves the affordance inactive when
 * nothing is left rather than offering an undo the server would 409).
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter, proposalToUI } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = '22222222-2222-4222-8222-222222222222';
const TEST_USER = 'user-owner-auto-approve';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-owner',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
  return app;
}

/**
 * The auto-approved half, mapped directly.
 *
 * Driving a REAL auto-approval through `/api/assistant/chat` needs an entity
 * resolver plus enough seeded repos to keep the drafting handler's confidence
 * above the auto-approve threshold; without them every wired intent caps at
 * 0.5 and lands on 'ready_for_review' (verified against `create_appointment`
 * and `update_job` while writing this). So the mapper — pure, no I/O — is
 * exercised directly here, and the route test below anchors the pending half
 * end to end.
 */
describe('proposalToUI — auto-approved card carries its undo window', () => {
  const base = {
    id: 'prop-1',
    proposalType: 'create_appointment',
    summary: 'Appointment — Tuesday at 2:00 PM',
    payload: {},
  };

  it('emits undoExpiresAt = approvedAt + UNDO_WINDOW_MS for an approved proposal', () => {
    const approvedAt = new Date('2026-08-09T12:00:00.000Z');
    const card = proposalToUI({ ...base, status: 'approved', approvedAt }, 'book Tuesday at 2pm');

    expect(card.status).toBe('Approved');
    expect(card.undoExpiresAt).toBe(
      new Date(approvedAt.getTime() + UNDO_WINDOW_MS).toISOString(),
    );
  });

  it('omits the window for an approved proposal with no approvedAt stamp (historical row)', () => {
    // No stamp ⇒ no real window ⇒ emit nothing rather than a fabricated
    // "5 seconds from now" the undo endpoint would reject.
    const card = proposalToUI({ ...base, status: 'approved' }, 'book Tuesday at 2pm');
    expect(card.status).toBe('Approved');
    expect(card.undoExpiresAt).toBeUndefined();
  });

  it('omits the window for a proposal that is not approved, even if an approvedAt somehow rides along', () => {
    const card = proposalToUI(
      { ...base, status: 'ready_for_review', approvedAt: new Date() },
      'book Tuesday at 2pm',
    );
    expect(card.status).toBe('Pending');
    expect(card.undoExpiresAt).toBeUndefined();
  });
});

/**
 * Review K4 — this mapper OVERWROTE `proposal.explanation` unconditionally
 * with "From your message: …". `update_catalog_item` IS chat-dispatchable,
 * so the entire payload of the refused-spoken-price fix — the sentence that
 * names the figure that was heard, says it was above the limit, and says it
 * was NOT applied — was discarded on the assistant surface, leaving the
 * operator with a raw payload key ("Needs: proposedUnitPriceCents").
 */
describe('proposalToUI — the persisted explanation reaches the card', () => {
  const base = {
    id: 'prop-explained',
    proposalType: 'update_catalog_item',
    summary: 'Update catalog item — Drain snake',
    payload: {},
  };

  it('keeps a persisted explanation instead of overwriting it with the echo', () => {
    const explanation =
      'Heard a price of $290000.00, above the $100000.00 limit for a spoken price — most likely a mishearing, so it was NOT applied. Set the price on this proposal if that figure is right.';
    const card = proposalToUI({ ...base, explanation }, 'change the drain snake to two ninety');

    expect(card.explanation).toContain('$290000.00');
    expect(card.explanation).toContain('NOT applied');
  });

  it('still shows the source echo when the proposal has no explanation of its own', () => {
    const card = proposalToUI(base, 'change the drain snake to two ninety');
    expect(card.explanation).toBe('From your message: "change the drain snake to two ninety"');
  });

  it('treats a blank explanation as absent', () => {
    const card = proposalToUI({ ...base, explanation: '   ' }, 'change the drain snake');
    expect(card.explanation).toBe('From your message: "change the drain snake"');
  });
});

describe('assistant chat — a pending card carries no undo window', () => {
  it('omits undoExpiresAt on a card that is still pending review', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        // add_note is capture-class but carries no autonomous trust tier, so it
        // lands for review — no approval instant, therefore no window to offer.
        classifierReply('add_note', { note: 'gate valve is seized', customerName: 'Miller' }),
      ]),
      proposalRepo,
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'note that the gate valve is seized at Miller' }] });

    expect(res.status).toBe(200);
    const card = res.body.message?.proposal;
    expect(card).toBeTruthy();
    expect(card.status).toBe('Pending');
    expect(card.undoExpiresAt).toBeUndefined();
  });
});
