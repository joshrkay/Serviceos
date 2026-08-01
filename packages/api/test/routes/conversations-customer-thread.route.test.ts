import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createConversationRouter } from '../../src/routes/conversations';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-thread-1';
const USER = 'owner-1';

function buildApp(opts: { withCustomerLookup: boolean; knownCustomerIds?: string[] } = { withCustomerLookup: true }) {
  const conversationRepo = new InMemoryConversationRepository();
  const auditRepo = new InMemoryAuditRepository();
  const known = new Set(opts.knownCustomerIds ?? ['cust-1']);
  const customerLookup = {
    findById: async (_tenantId: string, id: string) => (known.has(id) ? ({ id } as never) : null),
  };

  const app: Express = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/conversations',
    createConversationRouter(
      conversationRepo,
      auditRepo,
      undefined,
      undefined,
      opts.withCustomerLookup ? customerLookup : undefined,
    ),
  );
  return { app, conversationRepo };
}

describe('POST /api/conversations/customer/:customerId', () => {
  let env: ReturnType<typeof buildApp>;
  beforeEach(() => {
    env = buildApp({ withCustomerLookup: true });
  });

  it('creates a customer thread on first call', async () => {
    const res = await request(env.app).post('/api/conversations/customer/cust-1').send({});
    expect(res.status).toBe(200);
    expect(res.body.conversation.entityType).toBe('customer');
    expect(res.body.conversation.entityId).toBe('cust-1');
  });

  it('reuses the same thread on repeat calls (idempotent, no duplicate)', async () => {
    const first = await request(env.app).post('/api/conversations/customer/cust-1').send({});
    const second = await request(env.app).post('/api/conversations/customer/cust-1').send({});
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    const all = await env.conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(all).toHaveLength(1);
  });

  it('404s an unknown customer when a lookup is wired', async () => {
    const res = await request(env.app).post('/api/conversations/customer/ghost').send({});
    expect(res.status).toBe(404);
  });

  it('still creates when no customer lookup is wired (skips verification)', async () => {
    const { app } = buildApp({ withCustomerLookup: false });
    const res = await request(app).post('/api/conversations/customer/whoever').send({});
    expect(res.status).toBe(200);
  });
});
