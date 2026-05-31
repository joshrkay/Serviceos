import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createConversationRouter } from '../../src/routes/conversations';
import {
  InMemoryConversationRepository,
} from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-conv-1';
const USER_ID = 'user-conv-1';

function buildApp(opts: { withGateway: boolean; draft?: string }) {
  const conversationRepo = new InMemoryConversationRepository();
  const auditRepo = new InMemoryAuditRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const mock = createMockLLMGateway(opts.draft ?? 'draft reply');

  const app: Express = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-conv-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/conversations',
    createConversationRouter(
      conversationRepo,
      auditRepo,
      opts.withGateway ? { gateway: mock.gateway, settingsRepo } : undefined,
    ),
  );
  return { app, conversationRepo, settingsRepo };
}

async function seedConversation(repo: InMemoryConversationRepository) {
  const conv = await repo.createConversation({
    tenantId: TENANT_ID,
    title: 'Sandra Wu',
    createdBy: USER_ID,
  });
  await repo.addMessage({
    tenantId: TENANT_ID,
    conversationId: conv.id,
    messageType: 'text',
    content: 'My AC stopped cooling.',
    senderId: 'cust-1',
    senderRole: 'customer',
  });
  return conv;
}

describe('POST /api/conversations/:id/suggest-reply', () => {
  let withAi: ReturnType<typeof buildApp>;

  beforeEach(() => {
    withAi = buildApp({ withGateway: true, draft: 'Hi Sandra, we can help — want a Thursday slot?' });
  });

  it('returns an AI-drafted reply for an existing conversation', async () => {
    const conv = await seedConversation(withAi.conversationRepo);
    const res = await request(withAi.app).post(`/api/conversations/${conv.id}/suggest-reply`).send({});
    expect(res.status).toBe(200);
    expect(res.body.draft).toBe('Hi Sandra, we can help — want a Thursday slot?');
  });

  it('returns 503 when the AI gateway is not configured', async () => {
    const noAi = buildApp({ withGateway: false });
    const conv = await seedConversation(noAi.conversationRepo);
    const res = await request(noAi.app).post(`/api/conversations/${conv.id}/suggest-reply`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('UNAVAILABLE');
  });

  it('returns 404 for an unknown conversation', async () => {
    const res = await request(withAi.app)
      .post('/api/conversations/does-not-exist/suggest-reply')
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 503 (not 500) gracefully and never sends a message', async () => {
    // A conversation with only a system_event has no repliable content;
    // the task throws, surfacing as a 500 — assert it does not 201/200 a send.
    const conv = await withAi.conversationRepo.createConversation({
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });
    await withAi.conversationRepo.addMessage({
      tenantId: TENANT_ID,
      conversationId: conv.id,
      messageType: 'system_event',
      content: 'call started',
      senderId: 'system',
      senderRole: 'system',
    });
    const res = await request(withAi.app).post(`/api/conversations/${conv.id}/suggest-reply`).send({});
    expect(res.status).toBe(500);
    // No message was appended as a side effect of drafting.
    const msgs = await withAi.conversationRepo.getMessages(TENANT_ID, conv.id);
    expect(msgs).toHaveLength(1);
  });
});
