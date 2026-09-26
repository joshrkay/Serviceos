/**
 * QA 2026-09-16 (issues #1271, #1276) — chat drafting defects, pinned at the
 * public seam: POST /api/assistant/chat with a scripted gateway.
 *
 *   #1271  create_customer dropped the spoken address: the chat route rebuilt
 *          the handler's entities from name/email/phone only, so the address
 *          the classifier extracted never reached the payload, the card, or
 *          execution (every AI-created customer had zero service locations).
 *   #1276A "Add a new customer named Taylor." drafted at High confidence and
 *          executed with an empty last name — ask, don't guess (D-029).
 *   #1276C a numeric reply "1" to a customer disambiguation fell to general
 *          chat when the client did not echo `conversationId` (the web UI
 *          does; an API client that only replays `messages` did not).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../src/proposals/actions';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

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

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository, entityResolver?: EntityResolver) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      tenantTimezoneResolver: async () => 'America/Phoenix',
      ...(entityResolver ? { entityResolver } : {}),
    }),
  );
  return app;
}

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1271 — chat create_customer keeps the spoken address', () => {
  it('carries the classifier-extracted address onto the persisted payload and the card', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_customer', {
          displayName: 'Priya Whitfield',
          phone: '555-0100',
          address: '456 Oak Ave, Phoenix AZ 85002',
        }),
      ]),
      proposalRepo,
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: 'Create a new customer Priya Whitfield, phone 555-0100, address 456 Oak Ave, Phoenix AZ 85002',
          },
        ],
      });

    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('create_customer');
    expect(persisted.payload.address).toBe('456 Oak Ave, Phoenix AZ 85002');
    const card = res.body.message.proposal;
    expect(card.addressCapture?.address).toBe('456 Oak Ave, Phoenix AZ 85002');
  });
});
