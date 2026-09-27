/**
 * #1399 P3s (QA 2026-09-26 §17) — two chat turns that must never reach the
 * drafting pipeline:
 *
 *   - "There is a strong smell of gas in the customer house right now, what
 *     do I do?" came back as the honesty-guard's "I understood that as an
 *     emergency dispatch request, but I can't do that from here yet" — no
 *     safety advice at all. The phone path (E1, classifyCallerSafety) speaks
 *     the life-safety script; the chat must give the same advice, book nothing.
 *   - "Mark every invoice paid." became a voice_clarification follow-up
 *     proposal. A bulk money mutation is refused outright, never proposed.
 *
 * Seam: POST /api/assistant/chat. The gateway is a scripted fake; neither
 * guard may call it.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { LIFE_SAFETY_E1_ADVICE } from '../../src/ai/agents/customer-calling/emergency-tier';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-1399-guards';

function untouchableGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('the gateway must not be called for this turn');
    }),
  } as unknown as LLMGateway;
}

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1399',
      sessionId: 'sess-1399',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
  return app;
}

async function chat(text: string) {
  const gateway = untouchableGateway();
  const proposalRepo = new InMemoryProposalRepository();
  const res = await request(buildApp(gateway, proposalRepo))
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content: text }] });
  const proposals = await proposalRepo.findByTenant(TENANT);
  return { res, gateway, proposals };
}

describe('#1399 — a gas smell typed in chat gets the E1 life-safety advice', () => {
  it('answers with the phone path\'s E1 advice and drafts nothing', async () => {
    const { res, gateway, proposals } = await chat(
      'There is a strong smell of gas in the customer house right now, what do I do?',
    );

    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain(LIFE_SAFETY_E1_ADVICE);
    expect(res.body.message.proposal).toBeUndefined();
    expect(proposals).toHaveLength(0);
    expect(gateway.complete).not.toHaveBeenCalled();
  });
});

describe('#1399 — a bulk money mutation is refused, not proposed', () => {
  it.each([
    'Mark every invoice paid.',
    'mark all my invoices as paid',
    'Void all the open invoices',
    'refund every payment from this week',
  ])('%j is refused with no proposal', async (text) => {
    const { res, gateway, proposals } = await chat(text);

    expect(res.status).toBe(200);
    expect(res.body.message.content).toMatch(/one (?:invoice|at a time)/i);
    expect(res.body.message.content).toMatch(/haven't (?:changed|marked)/i);
    expect(res.body.message.proposal).toBeUndefined();
    expect(proposals).toHaveLength(0);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it.each(['Invoice all my completed jobs', 'Send payment reminders for all overdue invoices'])(
    '%j is a real batch feature and is not refused',
    async (text) => {
      const { res, gateway } = await chat(text);
      expect(res.body.message.content).not.toMatch(/can't change money on every invoice/i);
      expect(gateway.complete).toHaveBeenCalled();
    },
  );
});
