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

describe('GET /api/conversations/:id — journey QA bug 11 (thread self-wipe)', () => {
  it('returns the conversation WITH its messages (role derived from senderRole)', async () => {
    const { app, conversationRepo } = buildApp({ withGateway: false });
    const conv = await conversationRepo.createConversation({
      tenantId: TENANT_ID,
      title: 'What should I focus on today?',
      createdBy: USER_ID,
    });
    await conversationRepo.addMessage({
      tenantId: TENANT_ID,
      conversationId: conv.id,
      messageType: 'text',
      content: 'What should I focus on today?',
      senderId: USER_ID,
      senderRole: 'user',
      source: 'assistant',
    });
    await conversationRepo.addMessage({
      tenantId: TENANT_ID,
      conversationId: conv.id,
      messageType: 'text',
      content: 'Two estimates are waiting on approval.',
      senderId: 'assistant',
      senderRole: 'assistant',
      source: 'assistant',
    });

    const res = await request(app).get(`/api/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(conv.id);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0]).toMatchObject({
      role: 'user',
      content: 'What should I focus on today?',
    });
    expect(res.body.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Two estimates are waiting on approval.',
    });
    // The UI reads createdAt for the bubble timestamp.
    expect(res.body.messages[0].createdAt).toBeTruthy();
  });

  it('returns an empty messages array (not undefined) for a thread with no messages', async () => {
    const { app, conversationRepo } = buildApp({ withGateway: false });
    const conv = await conversationRepo.createConversation({
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });
    const res = await request(app).get(`/api/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it('still 404s for an unknown conversation', async () => {
    const { app } = buildApp({ withGateway: false });
    const res = await request(app).get('/api/conversations/nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/conversations/search — Story 3.11 history search', () => {
  async function seedLinked(repo: InMemoryConversationRepository) {
    const custConv = await repo.createConversation({
      tenantId: TENANT_ID,
      createdBy: USER_ID,
      entityType: 'customer',
      entityId: 'cust-7',
    });
    await repo.addMessage({
      tenantId: TENANT_ID,
      conversationId: custConv.id,
      messageType: 'text',
      content: 'Send the Rodriguez invoice',
      senderId: USER_ID,
      senderRole: 'user',
    });
    const jobConv = await repo.createConversation({
      tenantId: TENANT_ID,
      createdBy: USER_ID,
      entityType: 'job',
      entityId: 'job-3',
    });
    await repo.addMessage({
      tenantId: TENANT_ID,
      conversationId: jobConv.id,
      messageType: 'text',
      content: 'Crew running late on the roof job',
      senderId: USER_ID,
      senderRole: 'user',
    });
  }

  it('searches by free text', async () => {
    const { app, conversationRepo } = buildApp({ withGateway: false });
    await seedLinked(conversationRepo);
    const res = await request(app).get('/api/conversations/search').query({ q: 'rodriguez' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].message.content).toContain('Rodriguez');
    expect(res.body.results[0].conversation.entityId).toBe('cust-7');
  });

  it('searches by linked customer and by linked job', async () => {
    const { app, conversationRepo } = buildApp({ withGateway: false });
    await seedLinked(conversationRepo);
    const byCustomer = await request(app).get('/api/conversations/search').query({ customerId: 'cust-7' });
    expect(byCustomer.body.results).toHaveLength(1);
    const byJob = await request(app).get('/api/conversations/search').query({ jobId: 'job-3' });
    expect(byJob.body.results).toHaveLength(1);
    expect(byJob.body.results[0].message.content).toContain('roof');
  });

  it('400s when no search criterion is supplied', async () => {
    const { app } = buildApp({ withGateway: false });
    const res = await request(app).get('/api/conversations/search');
    expect(res.status).toBe(400);
  });

  it('does not collide with GET /:id (search is its own route)', async () => {
    const { app, conversationRepo } = buildApp({ withGateway: false });
    await seedLinked(conversationRepo);
    // 'search' must not be treated as a conversation id (which would 404).
    const res = await request(app).get('/api/conversations/search').query({ q: 'crew' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});
